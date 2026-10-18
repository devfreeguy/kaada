import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BadGatewayException, UnauthorizedException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { KaadaError } from "@kaada/domain";

import { AllExceptionsFilter } from "../src/logging/all-exceptions.filter.js";
import { errorText } from "../src/logging/error-text.js";

interface Entry {
  level: "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

function harness(url = "/api/v1/wallet/passkeys/registration/verify?token=SECRET123") {
  const entries: Entry[] = [];
  const sent: { status?: number; body?: unknown } = {};
  const logger = {
    setContext: () => undefined,
    warn: (fields: Record<string, unknown>, message: string) =>
      entries.push({ level: "warn", fields, message }),
    error: (fields: Record<string, unknown>, message: string) =>
      entries.push({ level: "error", fields, message }),
  };
  const reply = {
    sent: false,
    status(code: number) {
      sent.status = code;
      return {
        send(body: unknown) {
          sent.body = body;
        },
      };
    },
  };
  const request = {
    method: "POST",
    url,
    headers: { "x-request-id": "9b1769f0-8447-41b8-be10-282c1cf1eab0" },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter(logger as never);
  return { entries, sent, run: (error: unknown) => filter.catch(error, host) };
}

describe("every error that leaves a request is logged with its cause", () => {
  it("a refused request is a warning naming the route, the reason, the underlying domain error and the web request id", () => {
    const h = harness();
    const cause = new KaadaError("SETUP_SESSION_INVALID", "setup session expired");
    h.run(new UnauthorizedException("this setup link is not valid or has expired", { cause }));
    const [entry] = h.entries;
    assert.equal(entry?.level, "warn");
    assert.equal(entry?.fields["status"], 401);
    assert.equal(entry?.fields["reason"], "this setup link is not valid or has expired");
    assert.equal(entry?.fields["causeCode"], "SETUP_SESSION_INVALID");
    assert.equal(entry?.fields["causeMessage"], "setup session expired");
    assert.equal(entry?.fields["webRequestId"], "9b1769f0-8447-41b8-be10-282c1cf1eab0");
    assert.match(
      entry?.message ?? "",
      /POST \/api\/v1\/wallet\/passkeys\/registration\/verify refused with 401/,
    );
    assert.deepEqual(h.sent, {
      status: 401,
      body: {
        message: "this setup link is not valid or has expired",
        error: "Unauthorized",
        statusCode: 401,
      },
    });
  });

  it("never logs the query string, where a one-time token may travel", () => {
    const h = harness();
    h.run(new UnauthorizedException("x"));
    assert.equal(h.entries[0]?.fields["path"], "/api/v1/wallet/passkeys/registration/verify");
    assert.doesNotMatch(JSON.stringify(h.entries), /SECRET123/);
  });

  it("a server failure is an error with the stack and the underlying cause's stack", () => {
    const h = harness();
    const cause = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    h.run(new BadGatewayException("the wallet could not be created right now", { cause }));
    const [entry] = h.entries;
    assert.equal(entry?.level, "error");
    assert.equal(entry?.fields["status"], 502);
    assert.match(String(entry?.fields["stack"]), /BadGatewayException/);
    assert.match(String(entry?.fields["causeStack"]), /ECONNREFUSED/);
    assert.equal(entry?.fields["causeMessage"], "connect ECONNREFUSED 10.0.0.5:5432");
  });

  it("an unexpected error is logged in full, and the caller still gets only a generic 500", () => {
    const h = harness();
    h.run(new TypeError("Cannot read properties of undefined (reading 'address')"));
    const [entry] = h.entries;
    assert.equal(entry?.level, "error");
    assert.equal(entry?.fields["event"], "http.unhandled_exception");
    assert.equal(entry?.fields["errorName"], "TypeError");
    assert.match(String(entry?.fields["errorMessage"]), /reading 'address'/);
    assert.match(String(entry?.fields["stack"]), /error-logging\.test/);
    assert.deepEqual(h.sent, {
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
  });

  it("a non-Error throw is still logged and answered", () => {
    const h = harness();
    h.run("boom");
    assert.equal(h.entries[0]?.level, "error");
    assert.equal(h.entries[0]?.fields["errorMessage"], "boom");
    assert.equal(h.sent.status, 500);
  });
});

describe("errorText", () => {
  it("names the error, its platform code and its cause on one line", () => {
    const text = errorText(
      Object.assign(
        new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.x") }),
        { code: "E_FETCH" },
      ),
    );
    assert.equal(
      text,
      "Error: fetch failed (code=E_FETCH) <- caused by Error: getaddrinfo ENOTFOUND api.x",
    );
  });
});

describe("wired into a real application, the log lines a person debugging would read", () => {
  it("shows the request line at the right level and the filter's line with the cause, as JSON", async () => {
    const {
      Controller,
      Get,
      Post,
      Module,
      UnauthorizedException: Unauthorized,
    } = await import("@nestjs/common");
    const { FastifyAdapter } = await import("@nestjs/platform-fastify");
    const { Test } = await import("@nestjs/testing");
    const { LoggerModule, Logger } = await import("nestjs-pino");
    const { allExceptionsFilterProvider, httpLogLevel, requestSerializer } =
      await import("../src/logging/all-exceptions.filter.js");
    const { createLoggerOptions } = await import("@kaada/logger");

    @Controller({ path: "probe", version: "1" })
    class ProbeController {
      @Get("refuse")
      refuse(): never {
        throw new Unauthorized("this setup link is not valid or has expired", {
          cause: new KaadaError("SETUP_SESSION_INVALID", "setup session expired"),
        });
      }
      @Post("crash")
      crash(): never {
        throw new TypeError("Cannot read properties of undefined (reading 'address')");
      }
    }

    const lines: string[] = [];
    const stream = { write: (line: string) => void lines.push(line) };
    @Module({
      imports: [
        LoggerModule.forRoot({
          pinoHttp: [
            {
              ...createLoggerOptions({ level: "info" }),
              customLogLevel: httpLogLevel,
              serializers: { req: requestSerializer },
            },
            stream as never,
          ],
        }),
      ],
      controllers: [ProbeController],
      providers: [allExceptionsFilterProvider],
    })
    class ProbeModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useLogger(app.get(Logger));
    const { configureApp } = await import("../src/app.setup.js");
    configureApp(app, { corsOrigins: [] } as never);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      const refused = await app.inject({
        method: "GET",
        url: "/api/v1/probe/refuse?t=SECRET123",
        headers: {
          "x-request-id": "9b1769f0-8447-41b8-be10-282c1cf1eab0",
          authorization: "Bearer TOKEN987654321",
        },
      });
      const crashed = await app.inject({ method: "POST", url: "/api/v1/probe/crash" });
      assert.equal(refused.statusCode, 401);
      assert.equal(crashed.statusCode, 500);
      assert.deepEqual(JSON.parse(crashed.body), {
        statusCode: 500,
        message: "Internal server error",
      });
    } finally {
      await app.close();
    }

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const byEvent = (event: string) => parsed.find((entry) => entry["event"] === event);
    const refusedLine = byEvent("http.request_refused");
    assert.ok(refusedLine, `no refusal line in: ${lines.join("\n")}`);
    assert.equal(refusedLine["level"], 40, "warn");
    assert.equal(refusedLine["causeCode"], "SETUP_SESSION_INVALID");
    assert.equal(refusedLine["webRequestId"], "9b1769f0-8447-41b8-be10-282c1cf1eab0");
    const crashLine = byEvent("http.unhandled_exception");
    assert.ok(crashLine, "no unhandled-exception line");
    assert.equal(crashLine["level"], 50, "error");
    assert.match(String(crashLine["stack"]), /ProbeController/);
    const completed = parsed.filter((entry) =>
      /^request (completed|errored)$/.test(String(entry["msg"])),
    );
    assert.deepEqual(
      completed.map((entry) => entry["level"]),
      [40, 50],
      "401 is a warning, 500 an error",
    );
    assert.doesNotMatch(
      lines.join("\n"),
      /SECRET123|TOKEN987654321/,
      "no query string or bearer token in any line",
    );
  });
});
