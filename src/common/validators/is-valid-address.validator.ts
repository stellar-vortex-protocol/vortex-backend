import { registerDecorator, ValidationOptions, ValidationArguments } from "class-validator";

/**
 * Validates that a field contains a well-formed chain address.
 *
 * When `chain` is explicitly supplied (e.g. `@IsValidAddress({ chain: "stellar" })`),
 * that chain is used regardless of the DTO's `srcChain` field.  This allows the
 * decorator to be applied to DTOs that don't carry a `srcChain` property (e.g.
 * AcceptIntentDto, FillIntentDto, CancelIntentDto, RegisterSolverDto).
 *
 * When `chain` is omitted the validator falls back to reading `srcChain` from the
 * containing object, preserving the existing behaviour for CreateIntentDto.
 */
export function IsValidAddress(validationOptions?: ValidationOptions & { chain?: string }) {
  const fixedChain = validationOptions?.chain;
  // Strip our custom option so class-validator doesn't see an unknown key.
  const cvOptions: ValidationOptions | undefined = fixedChain
    ? (({ chain: _chain, ...rest }) => rest)(validationOptions as ValidationOptions & { chain?: string })
    : validationOptions;

  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isValidAddress",
      target: object.constructor,
      propertyName: propertyName,
      options: cvOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const chain = fixedChain ?? (args.object as any).srcChain;

          if (chain === "stellar") {
            return typeof value === "string" && /^G[A-Z2-7]{55}$/.test(value);
          }

          return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          const chain = fixedChain ?? (args.object as any).srcChain;
          if (chain === "stellar") {
            return "Stellar addresses must be 56 characters starting with G";
          }
          return "EVM addresses must be 42 characters starting with 0x";
        },
      },
    });
  };
}
