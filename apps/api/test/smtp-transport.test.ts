import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createTransport } from "nodemailer";

import {
  SmtpEmailSender,
  readSmtpPasswordFile,
  resolveSmtpConnection,
  smtpConnectionFromUrl,
  smtpTransportOptions,
} from "../src/infrastructure/recovery/smtp-email.js";
import type { SmtpConnection } from "../src/infrastructure/recovery/smtp-email.js";

/*
 * Recovery email over SMTP: TLS is enforced through real nodemailer TRANSPORT options (not message defaults), the password is
 * never URL-encoded, and neither it nor URL credentials ever reach an error.
 */

const PASSWORD = "p#a$s&s^w{o}r@d:/%41";

const connection = (security: "starttls" | "tls"): SmtpConnection => ({
  host: "smtp.example.com",
  port: security === "tls" ? 465 : 587,
  user: "mailer",
  password: PASSWORD,
  security,
});

/** The options nodemailer ends up holding on a real transport built from ours. */
const realOptions = (conn: SmtpConnection): Record<string, unknown> =>
  (
    createTransport(smtpTransportOptions(conn)) as unknown as {
      transporter: { options: Record<string, unknown> };
    }
  ).transporter.options;

describe("SMTP transport security", () => {
  it("starttls: a non-implicit transport that REQUIRES the upgrade, with the raw password", () => {
    const options = smtpTransportOptions(connection("starttls"));
    assert.equal(options.secure, false);
    assert.equal(options.requireTLS, true);
    assert.equal(options.port, 587);
    assert.deepEqual(options.auth, { user: "mailer", pass: PASSWORD });
  });

  it("tls: implicit TLS", () => {
    const options = smtpTransportOptions(connection("tls"));
    assert.equal(options.secure, true);
    assert.equal(options.port, 465);
  });

  it("the sender hands these options to the transport factory", () => {
    let seen: Record<string, unknown> | undefined;
    new SmtpEmailSender({
      from: "x@y.z",
      connection: connection("starttls"),
      createTransport: (options) => {
        seen = options;
        return { sendMail: () => Promise.resolve() };
      },
    });
    assert.deepEqual(seen, smtpTransportOptions(connection("starttls")));
  });

  it("a REAL nodemailer transport really holds requireTLS, secure and the timeouts", () => {
    const starttls = realOptions(connection("starttls"));
    assert.equal(starttls.requireTLS, true);
    assert.equal(starttls.secure, false);
    assert.equal(starttls.connectionTimeout, 10_000);
    assert.equal(starttls.greetingTimeout, 10_000);
    assert.equal(starttls.socketTimeout, 20_000);
    const tls = realOptions(connection("tls"));
    assert.equal(tls.secure, true);
    assert.equal(tls.connectionTimeout, 10_000);
    assert.equal(tls.socketTimeout, 20_000);
  });

  it("the legacy URL becomes the same enforced connection: scheme decides, credentials decoded, query ignored", () => {
    const starttls = smtpConnectionFromUrl("smtp://u:p%40ss%23@mail.example:587");
    assert.deepEqual(
      { ...starttls, alsoRedact: undefined },
      {
        host: "mail.example",
        port: 587,
        user: "u",
        password: "p@ss#",
        security: "starttls",
        alsoRedact: undefined,
      },
    );
    assert.equal(smtpConnectionFromUrl("smtp://u:p@mail.example").port, 587);
    const implicit = smtpConnectionFromUrl("smtps://u:p@mail.example");
    assert.equal(implicit.security, "tls");
    assert.equal(implicit.port, 465);
    // a query that tries to switch the requirement off does not win: the real transport still requires TLS
    const options = realOptions(
      smtpConnectionFromUrl("smtp://u:p@mail.example?requireTLS=false&secure=false"),
    );
    assert.equal(options.requireTLS, true);
    assert.equal(options.secure, false);
    assert.equal(options.socketTimeout, 20_000);
    assert.equal(realOptions(implicit).secure, true);
  });

  it("an unusable legacy URL fails without quoting it", () => {
    for (const bad of [
      "http://u:topsecretpw@mail.example",
      "smtp://u:topsecret%ZZ@mail.example",
      "smtp://mail.example",
      "not a url topsecretpw",
    ])
      assert.throws(
        () => smtpConnectionFromUrl(bad),
        (error: Error) =>
          /RECOVERY_SMTP_URL/.test(error.message) && !/topsecret/.test(error.message),
        bad,
      );
  });

  it("a send failure never carries the password or the URL credentials", async () => {
    const urlSender = new SmtpEmailSender({
      from: "x@y.z",
      connection: smtpConnectionFromUrl("smtps://mailer:hunter2secret@mail.example:465"),
      createTransport: () => ({
        sendMail: () =>
          Promise.reject(
            new Error(
              "auth failed for mailer:hunter2secret at smtps://mailer:hunter2secret@mail.example:465",
            ),
          ),
      }),
    });
    await assert.rejects(
      urlSender.send({ to: "a@b.c", subject: "s", text: "t" }),
      (error: Error) =>
        !error.message.includes("hunter2secret") && /auth failed/.test(error.message),
    );
    const encoded = new SmtpEmailSender({
      from: "x@y.z",
      connection: smtpConnectionFromUrl("smtps://mailer:p%40ss%23word@mail.example:465"),
      createTransport: () => ({
        sendMail: () => Promise.reject(new Error("535 rejected p@ss#word / p%40ss%23word")),
      }),
    });
    await assert.rejects(
      encoded.send({ to: "a@b.c", subject: "s", text: "t" }),
      (error: Error) => !/p@ss#word|p%40ss%23word/.test(error.message) && /535/.test(error.message),
    );
    const discreteSender = new SmtpEmailSender({
      from: "x@y.z",
      connection: connection("starttls"),
      createTransport: () => ({
        sendMail: () => Promise.reject(new Error(`535 bad credentials ${PASSWORD}`)),
      }),
    });
    await assert.rejects(
      discreteSender.send({ to: "a@b.c", subject: "s", text: "t" }),
      (error: Error) => !error.message.includes(PASSWORD) && /535/.test(error.message),
    );
  });
});

describe("SMTP password file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kaada-smtp-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o400 });
    return path;
  };
  const password = "#$&^{}@:/%41 end";
  const settings = (passwordFile: string) =>
    ({
      host: "smtp.example.com",
      port: 587,
      user: "mailer",
      security: "starttls",
      passwordFile,
    }) as const;

  it("preserves every special character exactly", () => {
    assert.equal(readSmtpPasswordFile(file("a", password)), password);
    const resolved = resolveSmtpConnection(settings(file("b", password)));
    assert.ok("password" in resolved && resolved.password === password);
  });

  it("removes only the trailing line break(s); leading, internal and trailing spaces stay", () => {
    assert.equal(readSmtpPasswordFile(file("lf", `${password}\n`)), password);
    assert.equal(readSmtpPasswordFile(file("crlf", `${password}\r\n`)), password);
    assert.equal(readSmtpPasswordFile(file("lead", ` ${password}\n`)), ` ${password}`);
    assert.equal(readSmtpPasswordFile(file("mid", "a b\tc\n")), "a b\tc");
    assert.equal(readSmtpPasswordFile(file("trail-space", "abc \n")), "abc ");
  });

  it("an empty or missing file fails", () => {
    assert.throws(() => readSmtpPasswordFile(file("empty", "\n")), /empty/);
    assert.throws(() => readSmtpPasswordFile(join(dir, "missing")), /ENOENT|no such file/i);
  });

  it("a plain password setting is used as given", () => {
    const resolved = resolveSmtpConnection({
      host: "h",
      port: 25,
      user: "u",
      security: "tls",
      password: "  # raw %  ",
    });
    assert.ok("password" in resolved && resolved.password === "  # raw %  ");
  });

  it("the legacy URL setting resolves through the URL parser", () => {
    assert.equal(resolveSmtpConnection({ url: "smtps://u:p@h" }).security, "tls");
  });
});
