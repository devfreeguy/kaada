import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";

import { createLoggerOptions } from "@kaada/logger";
import pino from "pino";

describe("request logging", () => {
  it("never writes a chat webhook secret, an Authorization header or a cookie to a log line", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino(createLoggerOptions({ level: "info" }), sink);
    logger.error({
      req: {
        headers: {
          "x-telegram-bot-api-secret-token": "WEBHOOK-SECRET-VALUE",
          "x-hub-signature-256": "sha256=SIGNATURE-VALUE",
          authorization: "Bearer BEARER-VALUE",
          cookie: "session=COOKIE-VALUE",
          "user-agent": "curl",
        },
      },
    });
    const written = lines.join("");
    for (const secret of [
      "WEBHOOK-SECRET-VALUE",
      "SIGNATURE-VALUE",
      "BEARER-VALUE",
      "COOKIE-VALUE",
    ]) {
      assert.ok(!written.includes(secret), `${secret} reached the log`);
    }
    assert.match(written, /user-agent/, "ordinary headers are still logged");
  });
});
