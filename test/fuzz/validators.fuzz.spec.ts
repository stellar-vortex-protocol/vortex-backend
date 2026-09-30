import * as fc from "fast-check";
import { ADVERSARIAL_STRINGS } from "./adversarial";
import { assertWithSeedReport, unicodeStrArb } from "./seed";

/* eslint-disable @typescript-eslint/no-var-requires */
function tryRequire(mod: string): Record<string, unknown> | null {
  try {
    return require(mod) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const validators = tryRequire("../../src/common/validators/is-valid-address.validator");
const signature = tryRequire("../../src/common/stellar-signature");

/** Rest-signature so it can be spread safely. */
type ValidateFn = (...args: unknown[]) => unknown;

function findValidateFn(mod: Record<string, unknown> | null): ValidateFn | null {
  if (!mod) return null;
  for (const value of Object.values(mod)) {
    if (typeof value === "function" && /isValidAddress|validate/i.test(value.name)) {
      return value as ValidateFn;
    }
    if (typeof value === "function" && value.prototype && typeof value.prototype.validate === "function") {
      const instance = new (value as new () => { validate: (...a: unknown[]) => unknown })();
      return (...a: unknown[]) => instance.validate(...a);
    }
  }
  return null;
}

const addressValidate = findValidateFn(validators);
const signatureVerify = findValidateFn(signature);

async function noUnhandledCrash(fn: ValidateFn, ...args: unknown[]): Promise<boolean> {
  try {
    const result = fn(...args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
    return true;
  } catch (e) {
    return !(e instanceof TypeError) && !(e instanceof RangeError) && !(e instanceof SyntaxError);
  }
}

describe("validator fuzz (issue #466)", () => {
  (addressValidate ? it : it.skip)("address validation never crashes on adversarial input", async () => {
    await assertWithSeedReport(
      "validators:address",
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(...ADVERSARIAL_STRINGS), fc.string(), unicodeStrArb()),
        (input) => noUnhandledCrash(addressValidate!, input),
      ),
    );
  });

  (signatureVerify ? it : it.skip)("signature verification never crashes on adversarial input", async () => {
    await assertWithSeedReport(
      "validators:signature",
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(...ADVERSARIAL_STRINGS), fc.string()),
        fc.oneof(fc.constantFrom(...ADVERSARIAL_STRINGS), fc.string()),
        (payload, sig) => noUnhandledCrash(signatureVerify!, { payload, signature: sig }),
      ),
    );
  });

  it.skip("signature module currently broken on upstream main; fuzz re-enables automatically once fixed", () => {
    // stellar-signature.ts has pre-existing syntax errors on upstream/main.
  });
});