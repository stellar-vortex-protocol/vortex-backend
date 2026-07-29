import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
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

        if (typeof b.error === "string" && typeof b.message !== "string") {
          response.status(status).json(addRequestId(b, requestId));
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
    logger.error(`[${requestId}] ${err.stack ?? err.message}`);
    response.status(500).json(addRequestId(
      { error: err.message || "Internal server error" },
      requestId,
    ));
  }
}
