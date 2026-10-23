import { HealthTimelineStore, HealthTransition } from "./health-indicator.registry";

export const HEALTH_TIMELINE_STORE = "HEALTH_TIMELINE_STORE";

export class InMemoryHealthTimelineStore implements HealthTimelineStore {
  private readonly rows: HealthTransition[] = [];

  append(row: HealthTransition): void {
    this.rows.push(row);
    if (this.rows.length > 500) {
      this.rows.splice(0, this.rows.length - 500);
    }
  }
}

export class PrismaHealthTimelineStore implements HealthTimelineStore {
  private readonly rows: HealthTransition[] = [];

  append(row: HealthTransition): void {
    this.rows.push(row);
  }
}
