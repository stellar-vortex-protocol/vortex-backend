import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
} from "class-validator";

@ValidatorConstraint({ name: "isValidDeadline", async: false })
export class IsValidDeadlineConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== "number" || !Number.isInteger(value)) return false;

    const now = Math.floor(Date.now() / 1000);
    const minDeadline = now + 60;
    const maxDeadline = now + 86400;

    return value >= minDeadline && value <= maxDeadline;
  }

  defaultMessage(_args: ValidationArguments): string {
    const now = Math.floor(Date.now() / 1000);
    const minDeadline = now + 60;
    const maxDeadline = now + 86400;
    return `deadline must be between ${minDeadline} (now + 60s) and ${maxDeadline} (now + 24h)`;
  }
}

export function IsValidDeadline(validationOptions?: ValidationOptions) {
  return function (target: object, propertyName: string) {
    registerDecorator({
      target: target.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidDeadlineConstraint,
    });
  };
}
