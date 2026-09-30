import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { captureException } from "./sentry";
import { logger } from "./logger";

/**
 * Fields that are explicitly allowed to pass through in a custom-shaped exception
 * body (i.e. the `b.error && !b.statusCode` branch).
 *
 * Any key NOT in this set will be stripped and a warning emitted in development
 * so the author learns about the leak before it reaches production.  In
 * production the field is silently dropped so no internal detail escapes.
 *
 * Today's only known usage is IntentsController.fill():
 *   throw new BadRequestException({ error, intentId, minDstAmount, fillAmount })
 * — all four fields are intentionally public.
 *
 * To expose a new field from a custom-shaped exception, add its name here and
 * document why it is safe to return to API consumers.  Closes #304.
 */
const CUSTOM_BODY_ALLOWLIST = new Set<string>([
  "error",       // human-readable error message (required)
  "intentId",    // the intent that failed — already in the URL, safe to echo
  "fillAmount",  // the amount the solver attempted — safe to echo to the solver
  "minDstAmount", // the required minimum — safe to echo to the solver
  "requestId",   // injected below; listed for clarity
]);

interface JsonResponse {
  status: (code: number) => { json: (body: unknown) => void };
  setHeader?: (name: string, value: string) => void;
}

interface RequestWithId {
  requestId?: string;
}

/**
 * Some 503s are transient and tell the client when to come back (an emergency
 * pause, a shedding load-shed). An exception may expose `retryAfterSeconds` to
 * have the `Retry-After` header set alongside the body.
 */
function setRetryAfter(response: JsonResponse, exception: unknown): void {
  const retryAfter = (exception as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    response.setHeader?.("Retry-After", String(Math.ceil(retryAfter)));
  }
}

function addRequestId(body: Record<string, unknown>, requestId?: string): Record<string, unknown> {
  if (requestId) body.requestId = requestId;
  return body;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const request = host.switchToHttp().getRequest<RequestWithId>();
    const requestId = request.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      setRetryAfter(response, exception);

      if (typeof body === "string") {
        response.status(status).json(addRequestId({ error: body }, requestId));
        return;
      }

      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;

        if (Array.isArray(b.message)) {
          response.status(status).json(
            addRequestId({ error: "Validation failed", details: b.message }, requestId),
          );
          return;
        }

        // Custom-shaped bodies passed directly to an exception constructor,
        // e.g. new BadRequestException({ error: "...", fillAmount, minDstAmount })
        // Only fields on CUSTOM_BODY_ALLOWLIST are forwarded to the client.
        // Any extra field is stripped and a warning is emitted so that future
        // contributors learn about the leak before it reaches production.
        // Closes #304.
        if (typeof b.error === "string" && !b.statusCode) {
          const sanitized: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(b)) {
            if (CUSTOM_BODY_ALLOWLIST.has(key)) {
              sanitized[key] = value;
            } else {
              logger.warn(
                `HttpExceptionFilter: custom exception body contains unexpected field "${key}" — ` +
                  "it has been stripped from the response. If this field is safe to expose to " +
                  "API consumers, add it to CUSTOM_BODY_ALLOWLIST in http-exception.filter.ts.",
              );
            }
          }
          response.status(status).json(addRequestId(sanitized, requestId));
          return;
        }

        if (typeof b.message === "string") {
          response.status(status).json(addRequestId({ error: b.message }, requestId));
          return;
        }
      }

      response.status(status).json(addRequestId({ error: exception.message }, requestId));
      return;
    }

    const err = exception instanceof Error ? exception : new Error("Unknown error");

    // Express/body-parser errors (e.g. PayloadTooLargeError) carry a numeric
    // `status` field.  Propagate it as-is instead of masking with 500.
    const httpStatus = (exception as Record<string, unknown>)?.status;
    if (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 600) {
      response.status(httpStatus).json({ error: err.message || "Request error" });
      return;
    }

    logger.error(err.stack ?? err.message);
    // Alert on-call engineers — only fires for unexpected exceptions, not
    // routine HttpExceptions, so alert fatigue on 404 / 400 is avoided.
    captureException(err);
    response.status(500).json({ error: err.message || "Internal server error" });
  }
}
