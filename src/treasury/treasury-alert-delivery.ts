import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TreasuryAlert } from "./treasury.types";

/** Injectable token for the delivery adapter. */
export const TREASURY_ALERT_DELIVERY = Symbol("TREASURY_ALERT_DELIVERY");

/** Contract every alert-delivery adapter must satisfy. */
export interface ITreasuryAlertDelivery {
  deliver(alert: TreasuryAlert): Promise<void>;
}

/**
 * No-op delivery adapter — used in dev/test when no webhook is configured.
 * Always succeeds silently.
 */
@Injectable()
export class NoopAlertDelivery implements ITreasuryAlertDelivery {
  async deliver(_alert: TreasuryAlert): Promise<void> {
    // intentional no-op
  }
}

/**
 * Slack incoming-webhook delivery adapter.
 *
 * Activated when TREASURY_SLACK_WEBHOOK_URL is set.
 * Posts a simple message block to the configured channel.
 * Throws on non-2xx so callers can decide to swallow the error.
 */
@Injectable()
export class SlackAlertDelivery implements ITreasuryAlertDelivery {
  private readonly logger = new Logger(SlackAlertDelivery.name);
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async deliver(alert: TreasuryAlert): Promise<void> {
    const emoji = alert.severity === "critical" ? "🚨" : "⚠️";
    const body = {
      text: `${emoji} *Treasury ${alert.severity.toUpperCase()} alert*`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `${emoji} *Treasury ${alert.severity.toUpperCase()} — ${alert.asset}*\n` +
              `${alert.message}\n` +
              `Discrepancy: \`${alert.discrepancy}\` base units\n` +
              `Alert ID: \`${alert.id}\``,
          },
        },
      ],
    };

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook returned ${response.status}: ${await response.text()}`);
    }

    this.logger.log(`[treasury] Slack alert delivered for alert ${alert.id}`);
  }
}

/**
 * PagerDuty Events API v2 delivery adapter.
 *
 * Activated when TREASURY_PAGERDUTY_ROUTING_KEY is set.
 * Creates a "trigger" event for critical/warning alerts.
 */
@Injectable()
export class PagerDutyAlertDelivery implements ITreasuryAlertDelivery {
  private static readonly EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
  private readonly logger = new Logger(PagerDutyAlertDelivery.name);
  private readonly routingKey: string;

  constructor(routingKey: string) {
    this.routingKey = routingKey;
  }

  async deliver(alert: TreasuryAlert): Promise<void> {
    const body = {
      routing_key: this.routingKey,
      event_action: "trigger",
      dedup_key: alert.id,
      payload: {
        summary: alert.message,
        severity: alert.severity === "critical" ? "critical" : "warning",
        source: "vortex-treasury",
        custom_details: {
          asset: alert.asset,
          discrepancy: alert.discrepancy,
          alertId: alert.id,
          timestamp: alert.timestamp,
        },
      },
    };

    const response = await fetch(PagerDutyAlertDelivery.EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`PagerDuty Events API returned ${response.status}: ${await response.text()}`);
    }

    this.logger.log(`[treasury] PagerDuty event triggered for alert ${alert.id}`);
  }
}

/**
 * Factory: picks the right delivery adapter from env vars.
 *
 * Priority: PagerDuty > Slack > Noop.
 */
export function createAlertDelivery(config: ConfigService): ITreasuryAlertDelivery {
  const pdKey = config.get<string>("TREASURY_PAGERDUTY_ROUTING_KEY", "");
  if (pdKey) return new PagerDutyAlertDelivery(pdKey);

  const slackUrl = config.get<string>("TREASURY_SLACK_WEBHOOK_URL", "");
  if (slackUrl) return new SlackAlertDelivery(slackUrl);

  return new NoopAlertDelivery();
}
