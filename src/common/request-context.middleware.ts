import { v4 as uuidv4 } from "uuid";
import { runWithLogContext } from "./log-context";

interface ContextRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface ContextResponse {
  setHeader(name: string, value: string): void;
}

/** Request ids we adopt from a caller: bounded length, no characters that could break a log line. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** W3C traceparent: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

function header(req: ContextRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve the request id for `req`: an inbound `x-request-id` that is safe to
 * log verbatim, otherwise a fresh UUID. A hostile header (newlines, 10 kB of
 * junk) is replaced rather than sanitised so the id stays greppable.
 */
export function resolveRequestId(req: ContextRequest): string {
  const inbound = header(req, "x-request-id");
  return inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : uuidv4();
}

/**
 * Opens the AsyncLocalStorage log context for one HTTP request (issue #488).
 *
 * Mounted first in `main.ts`, so everything downstream — guards, pipes,
 * handlers, services, the exception filter — logs with the same `requestId`
 * (and `traceId`, when the caller propagated a W3C `traceparent`) without
 * passing it around. The id is echoed back in `x-request-id` so a client can
 * quote it in a support ticket.
 */
export function requestContextMiddleware(
  req: ContextRequest,
  res: ContextResponse,
  next: () => void,
): void {
  const requestId = req.requestId ?? resolveRequestId(req);
  req.requestId = requestId;
  try {
    res.setHeader("x-request-id", requestId);
  } catch {
    // Headers already sent (should not happen this early) — the id is still logged.
  }
  const traceId = header(req, "traceparent")?.match(TRACEPARENT)?.[1];
  runWithLogContext({ requestId, traceId }, next);
}
