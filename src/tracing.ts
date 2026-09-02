import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

const isDev = process.env.NODE_ENV !== "production";

if (isDev) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const traceExporter = isDev
  ? new ConsoleSpanExporter()
  : new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
    });

const sdk = new NodeSDK({
  serviceName: "vortex-backend",
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": {
        enabled: true,
      },
      "@opentelemetry/instrumentation-undici": {
        enabled: true,
      },
      "@opentelemetry/instrumentation-express": {
        enabled: true,
      },
      "@opentelemetry/instrumentation-nestjs-core": {
        enabled: true,
      },
      "@opentelemetry/instrumentation-pg": {
        enabled: true,
      },
    }),
  ],
});

sdk.start();

process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .catch((err) => console.error("Error shutting down OpenTelemetry SDK", err));
});

process.on("SIGINT", () => {
  sdk
    .shutdown()
    .catch((err) => console.error("Error shutting down OpenTelemetry SDK", err));
});

export default sdk;
