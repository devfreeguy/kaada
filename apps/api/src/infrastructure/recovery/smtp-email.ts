import { readFileSync } from "node:fs";

import { createTransport } from "nodemailer";
import type { SmtpSettings } from "@kaada/config";
import type { RecoveryEmailSender } from "@kaada/domain";

/** The one nodemailer method used, so tests can stand in. */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** What the transport needs, with any password file already read. Never logged. */
export interface SmtpConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  security: "starttls" | "tls";
  /** Other spellings of the credentials (the legacy URL's percent-encoded form) to scrub from errors. */
  alsoRedact?: readonly string[];
}

export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 20_000;

/**
 * Reads the SMTP password from a secret file (a read-only mount). Only the line break(s) a file ends with are removed; every other
 * character, including leading and internal whitespace, is the password. The message never contains the file's content.
 */
export function readSmtpPasswordFile(path: string): string {
  const password = readFileSync(path, "utf8").replace(/[\r\n]+$/, "");
  if (password === "") throw new Error("the SMTP password file is empty");
  return password;
}

/**
 * The legacy RECOVERY_SMTP_URL, parsed here into the same connection the discrete settings give, so it goes through the one enforced
 * TLS path. Nodemailer's own URL handling is not used: it would let a `?requireTLS=false` query switch the requirement off. The
 * scheme decides the security (`smtps:` = implicit TLS, `smtp:` = STARTTLS required) and the query string is ignored. Errors never
 * quote the URL.
 */
export function smtpConnectionFromUrl(url: string): SmtpConnection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("RECOVERY_SMTP_URL is not a valid smtp:// or smtps:// URL");
  }
  const implicit = parsed.protocol === "smtps:";
  if ((!implicit && parsed.protocol !== "smtp:") || parsed.hostname === "")
    throw new Error("RECOVERY_SMTP_URL is not a valid smtp:// or smtps:// URL");
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error("RECOVERY_SMTP_URL has credentials that are not valid percent-encoding");
  }
  if (user === "" || password === "")
    throw new Error("RECOVERY_SMTP_URL must carry a user name and a password");
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? (implicit ? 465 : 587) : Number(parsed.port),
    user,
    password,
    security: implicit ? "tls" : "starttls",
    alsoRedact: [parsed.password, parsed.username, url],
  };
}

/** Turns validated settings into a connection, reading the password file when that is the form used. */
export function resolveSmtpConnection(
  settings: SmtpSettings,
  readPasswordFile: (path: string) => string = readSmtpPasswordFile,
): SmtpConnection {
  if ("url" in settings) return smtpConnectionFromUrl(settings.url);
  const password =
    settings.passwordFile !== undefined
      ? readPasswordFile(settings.passwordFile)
      : settings.password;
  if (password === undefined || password === "") throw new Error("no SMTP password is configured");
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password,
    security: settings.security,
  };
}

/**
 * The options handed to nodemailer's `createTransport`. These are TRANSPORT options (the second argument of `createTransport` would be
 * message defaults, which is why everything is in the one options object).
 *  - `starttls`: a plain connection that must upgrade (`secure: false`, `requireTLS: true`); a server that will not upgrade fails the send.
 *  - `tls`: implicit TLS from the first byte (`secure: true`).
 * There is no plaintext mode.
 */
export function smtpTransportOptions(connection: SmtpConnection): Record<string, unknown> {
  const timeouts = {
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  };
  return {
    host: connection.host,
    port: connection.port,
    secure: connection.security === "tls",
    requireTLS: connection.security === "starttls",
    auth: { user: connection.user, pass: connection.password },
    ...timeouts,
  };
}

/** Every secret in a connection, to scrub from an error message. */
function secretsOf(connection: SmtpConnection | undefined): string[] {
  return connection ? [connection.password, ...(connection.alsoRedact ?? [])] : [];
}

function redact(message: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= 3)
    .reduce((text, secret) => text.split(secret).join("[redacted]"), message);
}

/**
 * Sends recovery email (codes and alerts) over SMTP. Plain text only: no tracking, no remote content, and a link in a
 * message is the only thing that can act, so nothing is hidden in HTML. TLS is always required (see `smtpTransportOptions`):
 * `starttls` must upgrade or the send fails, `tls` is implicit TLS.
 */
export class SmtpEmailSender implements RecoveryEmailSender {
  private readonly transport: MailTransport;
  private readonly secrets: string[];

  constructor(
    private readonly options: {
      from: string;
      connection?: SmtpConnection;
      transport?: MailTransport;
      /** Tests: stands in for nodemailer's `createTransport` and sees the real options. */
      createTransport?: (options: Record<string, unknown>) => MailTransport;
    },
  ) {
    this.secrets = secretsOf(options.connection);
    if (options.transport) {
      this.transport = options.transport;
      return;
    }
    if (!options.connection) throw new Error("an SMTP connection is required");
    const factory = options.createTransport ?? ((o) => createTransport(o));
    this.transport = factory(smtpTransportOptions(options.connection));
  }

  async send(input: { to: string; subject: string; text: string }): Promise<void> {
    // A recipient or subject carrying a line break would let a caller add headers: refuse, never sanitise silently.
    if (/[\r\n]/.test(input.to) || /[\r\n]/.test(input.subject)) {
      throw new Error("refusing an email with a line break in the recipient or subject");
    }
    try {
      await this.transport.sendMail({
        from: this.options.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
      });
    } catch (error) {
      // A failure is surfaced (the notifier records it) but never carries the password or the URL's credentials.
      const message = error instanceof Error ? error.message : "the SMTP send failed";
      throw new Error(redact(message, this.secrets));
    }
  }
}
