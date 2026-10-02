import { registerDecorator, ValidationOptions, ValidationArguments } from "class-validator";
import { SupportedChain } from "../../intents/intents.types";

/** Validation options plus the chain whose address format should be enforced. */
export interface IsValidAddressOptions extends ValidationOptions {
  /**
   * Chain whose address format to check. When omitted the decorator falls
   * back to the sibling `srcChain` property of the object under validation.
   */
  chain?: SupportedChain;
}

export function IsValidAddress(validationOptions?: IsValidAddressOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isValidAddress",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const chain = validationOptions?.chain ?? (args.object as any).srcChain;

          if (chain === "stellar") {
            return typeof value === "string" && /^G[A-Z2-7]{55}$/.test(value);
          }

          return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          const chain = validationOptions?.chain ?? (args.object as any).srcChain;
          if (chain === "stellar") {
            return "Stellar addresses must be 56 characters";
          }
          return "EVM addresses must be 42 characters starting with 0x";
        },
      },
    });
  };
}
