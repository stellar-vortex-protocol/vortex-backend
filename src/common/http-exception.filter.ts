import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { captureException } from "./sentry";
import { logger } from "./logger";

interface JsonResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<JsonResponse>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === "string") {
        response.status(status).json({ error: body });
        return;
      }

      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;

        // class-validator ValidationPipe shape: { message: string[], error, statusCode }
        if (Array.isArray(b.message)) {
          response.status(status).json({ error: "Validation failed", details: b.message });
          return;
        }

        // Custom-shaped bodies passed directly to an exception constructor,
        // e.g. new BadRequestException({ error: "...", fillAmount, minDstAmount })
        if (typeof b.error === "string" && !b.statusCode) {
          response.status(status).json(b);
          return;
        }

        if (typeof b.message === "string") {
          response.status(status).json({ error: b.message });
          return;
        }
      }

      response.status(status).json({ error: exception.message });
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
