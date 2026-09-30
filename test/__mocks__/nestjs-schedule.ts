/** Jest stand-in for the ESM-only @nestjs/schedule package. */
export const CronExpression = {
  EVERY_MINUTE: "* * * * *",
  EVERY_5_MINUTES: "*/5 * * * *",
  EVERY_DAY_AT_MIDNIGHT: "0 0 * * *",
};

export function Cron(): MethodDecorator {
  return () => undefined;
}

export function Interval(): MethodDecorator {
  return () => undefined;
}

export function Timeout(): MethodDecorator {
  return () => undefined;
}

export class ScheduleModule {
  static forRoot(): { module: typeof ScheduleModule } {
    return { module: ScheduleModule };
  }
}
