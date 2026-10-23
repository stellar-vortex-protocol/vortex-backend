import { createHmac } from "node:crypto";
import { EgressPurpose } from "../common/http-egress";
import {
  DATASET_PUBLISHED_EVENT,
  DatasetWebhookNotifier,
  signDatasetWebhookBody,
  verifyDatasetWebhookSignature,
  WebhookEgress,
} from "./dataset-webhook.notifier";
import { DatasetManifest } from "./datasets.types";

const SECRET = "dataset-webhook-secret-0123456789abcdef";

const MANIFEST: DatasetManifest = {
  schema: "intents-v1.0",
  schemaVersion: "1.0",
  generatedAt: "2026-09-29T00:05:00.000Z",
  date: "2026-09-28",
  revision: 2,
  watermark: "2026-09-28T23:59:00.000Z",
  rowCounts: { intents: 3, fills: 1, solver_stats: 2, fees: 1 },
  files: [],
};

function notifierWith(
  fetch: jest.Mock,
  urls = ["https://hooks.example.com/a"],
  sleep = jest.fn().mockResolvedValue(undefined),
) {
  const notifier = new DatasetWebhookNotifier(
    { webhookUrls: urls, webhookSecret: SECRET },
    { fetch } as WebhookEgress,
    { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150, sleep },
  );
  return { notifier, sleep };
}

describe("dataset webhook signatures", () => {
  it("is sha256=<hex HMAC-SHA256 of the raw body> under the dedicated secret", () => {
    const body = JSON.stringify(MANIFEST);
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(signDatasetWebhookBody(SECRET, body)).toBe(`sha256=${hex}`);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a matching signature and rejects tampering, other secrets, or a missing header", () => {
    const body = JSON.stringify(MANIFEST);
    const sig = signDatasetWebhookBody(SECRET, body);
    expect(verifyDatasetWebhookSignature(SECRET, body, sig)).toBe(true);
    expect(verifyDatasetWebhookSignature(SECRET, body.replace('"revision":2', '"revision":3'), sig)).toBe(false);
    expect(verifyDatasetWebhookSignature("another-secret-another-secret-0000", body, sig)).toBe(false);
    expect(verifyDatasetWebhookSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyDatasetWebhookSignature(SECRET, body, "sha256=short")).toBe(false);
  });
});

describe("DatasetWebhookNotifier", () => {
  it("is a no-op without URLs", async () => {
    const fetch = jest.fn();
    const notifier = new DatasetWebhookNotifier({}, { fetch } as WebhookEgress);
    expect(notifier.enabled).toBe(false);
    await notifier.notify(MANIFEST);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to start with URLs but no secret", () => {
    expect(
      () => new DatasetWebhookNotifier({ webhookUrls: ["https://hooks.example.com"] }, { fetch: jest.fn() }),
    ).toThrow(/DATASETS_WEBHOOK_SECRET/);
  });

  it("POSTs the signed manifest to every URL through the egress service", async () => {
    const fetch = jest.fn().mockResolvedValue({ statusCode: 200 });
    const { notifier } = notifierWith(fetch, ["https://a.example.com/hook", "https://b.example.com/hook"]);

    await notifier.notify(MANIFEST);

    expect(fetch).toHaveBeenCalledTimes(2);
    const deliveryIds = new Set<string>();
    for (const [, opts] of fetch.mock.calls) {
      expect(opts.method).toBe("POST");
      expect(opts.purpose).toBe(EgressPurpose.WEBHOOK);
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers["X-Vortex-Event"]).toBe(DATASET_PUBLISHED_EVENT);
      expect(JSON.parse(opts.body)).toEqual(MANIFEST);
      expect(verifyDatasetWebhookSignature(SECRET, opts.body, opts.headers["X-Vortex-Signature"])).toBe(true);
      deliveryIds.add(opts.headers["X-Vortex-Delivery"]);
    }
    // One id per publication, shared across subscribers and retries.
    expect(deliveryIds.size).toBe(1);
  });

  it("retries transient failures with bounded exponential backoff, then succeeds", async () => {
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce({ statusCode: 202 });
    const { notifier, sleep } = notifierWith(fetch);

    await notifier.notify(MANIFEST);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 150]); // 100, then 200 capped to 150
  });

  it("gives up after maxAttempts without throwing", async () => {
    const fetch = jest.fn().mockResolvedValue({ statusCode: 500 });
    const { notifier, sleep } = notifierWith(fetch);

    await expect(notifier.notify(MANIFEST)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent 4xx rejection, but does retry 429", async () => {
    const rejecting = jest.fn().mockResolvedValue({ statusCode: 401 });
    await notifierWith(rejecting).notifier.notify(MANIFEST);
    expect(rejecting).toHaveBeenCalledTimes(1);

    const throttled = jest.fn().mockResolvedValueOnce({ statusCode: 429 }).mockResolvedValueOnce({ statusCode: 200 });
    await notifierWith(throttled).notifier.notify(MANIFEST);
    expect(throttled).toHaveBeenCalledTimes(2);
  });

  it("keeps delivering to healthy URLs when one subscriber fails", async () => {
    const fetch = jest.fn((url: string) =>
      url.includes("bad") ? Promise.reject(new Error("Hostname bad.example.com not in allowlist")) : Promise.resolve({ statusCode: 200 }),
    );
    const { notifier } = notifierWith(fetch, ["https://bad.example.com/x", "https://good.example.com/y"]);

    await expect(notifier.notify(MANIFEST)).resolves.toBeUndefined();
    expect(fetch.mock.calls.filter(([u]) => u.includes("good"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([u]) => u.includes("bad"))).toHaveLength(3);
  });

  describe("fromConfig (egress allowlist)", () => {
    const base = {
      enabled: true,
      anonymize: true,
      salt: "",
      saltRotationHours: 24,
      saltRetentionWindows: 2,
      publicBucket: "b",
      storageKind: "memory" as const,
      localDir: ".",
      webhookSecret: SECRET,
    };

    it("blocks hosts outside WEBHOOK_ALLOWLIST before any network call", async () => {
      const notifier = DatasetWebhookNotifier.fromConfig({
        ...base,
        webhookUrls: ["https://evil.example.net/hook"],
        webhookAllowlist: ["hooks.example.com"],
      });
      const egress = (notifier as unknown as { egress: { fetch: WebhookEgress["fetch"] } }).egress;
      await expect(egress.fetch("https://evil.example.net/hook", { method: "POST" })).rejects.toThrow(
        /not in allowlist/,
      );
    });

    it("blocks private/metadata addresses even when they are the configured URL", async () => {
      const notifier = DatasetWebhookNotifier.fromConfig({
        ...base,
        webhookUrls: ["http://169.254.169.254/latest/meta-data"],
      });
      const egress = (notifier as unknown as { egress: { fetch: WebhookEgress["fetch"] } }).egress;
      await expect(egress.fetch("http://169.254.169.254/latest/meta-data", { method: "POST" })).rejects.toThrow(
        /metadata endpoint blocked/,
      );
    });
  });
});
