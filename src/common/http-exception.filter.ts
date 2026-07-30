import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { captureException } from "./sentry";
import { logger } from "./logger";

interface JsonResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

interface RequestWithId {
  requestId?: string;
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
        if (typeof b.error === "string" && !b.statusCode) {
          response.status(status).json(b);
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
