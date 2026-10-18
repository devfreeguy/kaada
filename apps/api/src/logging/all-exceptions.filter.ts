import { Catch, HttpException, HttpStatus } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

/** The little of the HTTP request and reply this filter touches (the Fastify types are not a direct dependency). */
interface FilterRequest {
  method: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
}
interface FilterReply {
  sent: boolean;
  status(code: number): { send(body: unknown): unknown };
}

/** Reduces anything thrown to a loggable, secret-free description. Messages are kept; stacks only for real faults. */
export function describeThrown(error: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" && { code }),
      ...(error.stack && { stack: error.stack }),
    };
  }
  return { name: "NonError", message: typeof error === "string" ? error : JSON.stringify(error) };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first && /^[A-Za-z0-9-]{8,64}$/.test(first) ? first : undefined;
}

/** The request path without its query string: a query may carry a one-time token, so it never reaches a log line. */
function pathOf(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Every error that leaves a request handler is logged exactly once, with enough to find the cause:
 *   - 5xx and anything unexpected  -> error level, with the stack and the underlying `cause` chain;
 *   - 4xx (a refused request)      -> warn level, with the reason the handler gave (never a body, a token or a header).
 * The answer the caller gets is unchanged: an HttpException keeps its own status and body, anything else is a plain 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext("Http");
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FilterRequest>();
    const reply = http.getResponse<FilterReply>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const thrown = describeThrown(exception);
    const cause =
      exception instanceof Error && exception.cause ? describeThrown(exception.cause) : undefined;

    const details = {
      event: isHttp ? "http.request_refused" : "http.unhandled_exception",
      status,
      method: request.method,
      path: pathOf(request.url),
      // The id the web app's proxy generated for this call (its own log line carries the same one), so the two sides can be joined.
      webRequestId: headerValue(request.headers?.["x-request-id"]),
      errorName: thrown.name,
      reason: isHttp ? thrown.message : "an unexpected error escaped the handler",
      ...(cause && {
        causeName: cause.name,
        causeCode: cause.code,
        causeMessage: cause.message,
        ...(status >= 500 && { causeStack: cause.stack }),
      }),
      ...(status >= 500 && { stack: thrown.stack }),
      // An unexpected error's own message is for the log only; the caller is never shown it.
      ...(!isHttp && { errorMessage: thrown.message, errorCode: thrown.code }),
    };

    if (status >= 500) {
      this.logger.error(
        details,
        `${request.method} ${details.path} failed with ${String(status)}: ${thrown.message}`,
      );
    } else {
      this.logger.warn(
        details,
        `${request.method} ${details.path} refused with ${String(status)}: ${thrown.message}`,
      );
    }

    if (reply.sent) return;
    if (isHttp) {
      const body = exception.getResponse();
      void reply.status(status).send(body);
    } else {
      void reply
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ statusCode: 500, message: "Internal server error" });
    }
  }
}

/** Registers the filter for the whole application. Shared by the real module and by tests, so both wire it identically. */
export const allExceptionsFilterProvider = {
  provide: APP_FILTER,
  inject: [PinoLogger],
  useFactory: (logger: PinoLogger): AllExceptionsFilter => new AllExceptionsFilter(logger),
};

/** Request-log level: a refused request is a warning and a failed one an error, so the level alone finds the problems. */
export function httpLogLevel(
  _req: unknown,
  res: { statusCode: number },
  error?: Error,
): "info" | "warn" | "error" {
  return error || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
}

/**
 * How a request appears in the access log: the method, the path WITHOUT its query string (a query can carry a one-time token),
 * and the headers (the logger redacts the sensitive ones). Replaces the default serializer, which also logged the raw URL and a
 * parsed `query` object.
 */
const LOGGED_HEADERS = [
  "host",
  "user-agent",
  "content-type",
  "content-length",
  "origin",
  "referer",
  "x-request-id",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "via",
];

type RawLike = {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, unknown>;
};

/** The URL the client asked for. Routing rewrites `url` on the raw request (it ends up "/"), so the first hook records it. */
export function originalUrlOf(req: RawLike): string {
  return req.originalUrl ?? req.url ?? "";
}

/**
 * How a request appears in the access log: the method, the path WITHOUT its query string (a query can carry a one-time token),
 * and ONLY a short list of harmless headers. Platforms add dozens of headers of their own (signatures, OIDC tokens, geo data);
 * a header that is not on the list is never written. Replaces the default serializer, which logged every header.
 */
export function requestSerializer(
  req: RawLike & { id?: unknown; remoteAddress?: string; remotePort?: number; raw?: RawLike },
): Record<string, unknown> {
  const raw = req.raw ?? req;
  const headers = raw.headers ?? req.headers ?? {};
  const picked: Record<string, unknown> = {};
  for (const name of LOGGED_HEADERS) if (headers[name] !== undefined) picked[name] = headers[name];
  return {
    id: req.id,
    method: raw.method ?? req.method,
    url: pathOf(originalUrlOf(raw) || originalUrlOf(req)),
    headers: picked,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}
