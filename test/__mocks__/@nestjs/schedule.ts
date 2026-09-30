/**
 * Jest mock for `@nestjs/schedule` (issue: the 12.x line is ESM-only and the
 * Jest setup runs CommonJS via ts-jest).
 *
 * The scheduler is observability/cron plumbing — no unit or e2e test exercises
 * the cron execution path — so a no-op `ScheduleModule` and identity `@Cron`
 * decorator are sufficient.  Production uses the real package.
 */

export const CronExpression = {
  EVERY_MINUTE: "* * * * *",
  EVERY_HOUR: "0 * * * *",
  EVERY_DAY_AT_MIDNIGHT: "0 0 * * *",
  EVERY_WEEK: "0 0 * * 0",
  EVERY_MONTH: "0 0 1 * *",
};

export function Cron(_expression: string): MethodDecorator {
  return () => {};
}

export function Interval(_ms: number): MethodDecorator {
  return () => {};
}

export function Timeout(_ms: number): MethodDecorator {
  return () => {};
}

export class ScheduleModule {
  static forRoot(): { module: typeof ScheduleModule } {
    return { module: ScheduleModule };
  }
}
