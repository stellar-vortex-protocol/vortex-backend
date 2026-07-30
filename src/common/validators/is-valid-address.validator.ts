import { registerDecorator, ValidationOptions, ValidationArguments } from "class-validator";

export function IsValidAddress(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: "isValidAddress",
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const srcChain = (args.object as any).srcChain;
          
          if (srcChain === "stellar") {
            return typeof value === "string" && value.length === 56;
          }
          
          return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          const srcChain = (args.object as any).srcChain;
          if (srcChain === "stellar") {
            return "Stellar addresses must be 56 characters";
          }
          return "EVM addresses must be 42 characters starting with 0x";
        },
      },
    });
  };
}
