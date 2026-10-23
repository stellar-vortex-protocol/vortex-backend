import { Logger } from "@nestjs/common";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EgressPurpose, HttpEgressService } from "../common/http-egress";
import { DatasetManifest, DatasetsConfig } from "./datasets.types";

/** Header carrying `sha256=<hex HMAC-SHA256 of the raw request body>`. */
export const DATASET_WEBHOOK_SIGNATURE_HEADER = "X-Vortex-Signature";
/** Header naming the event; always `dataset.published` for now. */
export const DATASET_WEBHOOK_EVENT_HEADER = "X-Vortex-Event";
/** Unique id per delivery attempt group, so receivers can de-duplicate retries. */
export const DATASET_WEBHOOK_DELIVERY_HEADER = "X-Vortex-Delivery";
export const DATASET_PUBLISHED_EVENT = "dataset.published";

/** Compute the signature header value for a webhook body. */
export function signDatasetWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * Receiver-side check: does `signature` match the body under `secret`?
 * Uses a constant-time comparison.
 */
export function verifyDatasetWebhookSignature(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signDatasetWebhookBody(secret, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The subset of HttpEgressService the notifier needs (mockable in tests). */
export type WebhookEgress = Pick<HttpEgressService, "fetch">;

export interface DatasetWebhookOptions {
  /** Total delivery attempts per URL, including the first. */
  maxAttempts?: number;
  /** Delay before the first retry; doubles on each further retry. */
  baseDelayMs?: number;
  /** Upper bound for any single retry delay. */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 };

/**
 * Best-effort "new dataset published" notifications (issue #597).
 *
 * After `DatasetsService.exportDaily()` persists `manifest.json`, the manifest
 * body is POSTed to every configured URL with an HMAC signature. Failures are
 * logged and retried with bounded exponential backoff, and `notify()` never
 * throws: the published dataset is the source of truth, the webhook is only a
 * hint that it changed.
 *
 * All traffic goes through HttpEgressService, so the egress allowlist and the
 * private-range / metadata-IP SSRF blocks apply. Redirects are disabled so a
 * subscriber cannot bounce the request to a host outside the allowlist.
 */
export class DatasetWebhookNotifier {
  private readonly logger = new Logger(DatasetWebhookNotifier.name);
  private readonly urls: string[];
  private readonly secret: string;
  private readonly opts: Required<Omit<DatasetWebhookOptions, "sleep">> & {
    sleep: (ms: number) => Promise<void>;
  };

  constructor(
    config: Pick<DatasetsConfig, "webhookUrls" | "webhookSecret">,
    private readonly egress: WebhookEgress,
    options: DatasetWebhookOptions = {},
  ) {
    this.urls = config.webhookUrls ?? [];
    this.secret = config.webhookSecret ?? "";
    if (this.urls.length > 0 && !this.secret) {
      throw new Error("DATASETS_WEBHOOK_SECRET is required when DATASETS_WEBHOOK_URLS is set");
    }
    this.opts = {
      maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULTS.maxAttempts),
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  /**
   * Build the production notifier: an HttpEgressService restricted to the
   * configured allowlist (or, when none is set, to the webhook URLs' own
   * hosts), with private ranges blocked.
   */
  static fromConfig(config: DatasetsConfig): DatasetWebhookNotifier {
    const urls = config.webhookUrls ?? [];
    const allowlist =
      config.webhookAllowlist && config.webhookAllowlist.length > 0
        ? config.webhookAllowlist
        : [...new Set(urls.map((u) => new URL(u).hostname))];
    const egress = new HttpEgressService({
      timeoutMs: 10_000,
      maxRedirects: 0,
      maxBodySizeBytes: 65_536,
      allowlist,
      blockPrivateRanges: true,
    });
    return new DatasetWebhookNotifier(config, egress);
  }

  get enabled(): boolean {
    return this.urls.length > 0;
  }

  /**
   * Deliver the manifest to every URL in parallel. Resolves once each URL has
   * succeeded or exhausted its retries; never rejects.
   *
   * @param body the exact bytes written to `manifest.json`, so the signature
   *             covers what subscribers would download. Defaults to the same
   *             pretty-printed JSON the exporter writes.
   */
  async notify(manifest: DatasetManifest, body = JSON.stringify(manifest, null, 2)): Promise<void> {
    if (!this.enabled) return;
    const deliveryId = randomUUID();
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "vortex-datasets-webhook/1",
      [DATASET_WEBHOOK_EVENT_HEADER]: DATASET_PUBLISHED_EVENT,
      [DATASET_WEBHOOK_DELIVERY_HEADER]: deliveryId,
      [DATASET_WEBHOOK_SIGNATURE_HEADER]: signDatasetWebhookBody(this.secret, body),
    };
    await Promise.all(
      this.urls.map((url) =>
        this.deliver(url, body, headers, manifest).catch((err: unknown) => {
          // deliver() already swallows errors; this is a last-resort guard.
          this.logger.error(`Dataset webhook to ${redact(url)} crashed: ${message(err)}`);
        }),
      ),
    );
  }

  private async deliver(
    url: string,
    body: string,
    headers: Record<string, string>,
    manifest: DatasetManifest,
  ): Promise<void> {
    const label = `${manifest.date} rev ${manifest.revision} → ${redact(url)}`;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      let failure: string;
      let retryable = true;
      try {
        const res = await this.egress.fetch(url, {
          method: "POST",
          headers,
          body,
          purpose: EgressPurpose.WEBHOOK,
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.logger.log(`Dataset webhook delivered (${label}, attempt ${attempt})`);
          return;
        }
        failure = `HTTP ${res.statusCode}`;
        // Other 4xx responses are the subscriber rejecting the request; a
        // retry would get the same answer.
        retryable = res.statusCode >= 500 || res.statusCode === 408 || res.statusCode === 429;
      } catch (err: unknown) {
        failure = message(err);
      }

      if (!retryable || attempt === this.opts.maxAttempts) {
        this.logger.warn(
          `Dataset webhook failed (${label}) after ${attempt} attempt(s): ${failure}. ` +
            "The dataset is published; only the notification was lost.",
        );
        return;
      }
      const delay = Math.min(this.opts.baseDelayMs * 2 ** (attempt - 1), this.opts.maxDelayMs);
      this.logger.warn(`Dataset webhook attempt ${attempt} failed (${label}): ${failure}; retrying in ${delay}ms`);
      await this.opts.sleep(delay);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log a URL without its query string or credentials, which may carry tokens. */
function redact(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid url>";
  }
}
