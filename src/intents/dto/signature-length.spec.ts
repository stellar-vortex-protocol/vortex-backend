import { validate } from "class-validator";
import { AcceptIntentDto } from "./accept-intent.dto";
import { CancelIntentDto } from "./cancel-intent.dto";
import { FillIntentDto } from "./fill-intent.dto";
import { RegisterSolverDto } from "../../solvers/dto/register-solver.dto";
import { UpdateSolverStatusDto } from "../../solvers/dto/update-solver-status.dto";

const SIGNATURE_MAX_LENGTH = 88;
const VALID_PUBLIC_KEY = "G" + "A".repeat(55);

describe("signature length validation", () => {
  it.each([
    ["AcceptIntentDto", () => Object.assign(new AcceptIntentDto(), { solver: VALID_PUBLIC_KEY, signature: "A".repeat(SIGNATURE_MAX_LENGTH) }), "signature"],
    ["FillIntentDto", () => Object.assign(new FillIntentDto(), { solver: VALID_PUBLIC_KEY, fillAmount: "1000", signature: "A".repeat(SIGNATURE_MAX_LENGTH) }), "signature"],
    ["CancelIntentDto", () => Object.assign(new CancelIntentDto(), { user: VALID_PUBLIC_KEY, signature: "A".repeat(SIGNATURE_MAX_LENGTH) }), "signature"],
    ["UpdateSolverStatusDto", () => Object.assign(new UpdateSolverStatusDto(), { signature: "A".repeat(SIGNATURE_MAX_LENGTH) }), "signature"],
    ["RegisterSolverDto", () => Object.assign(new RegisterSolverDto(), {
      address: VALID_PUBLIC_KEY,
      name: "Solver One",
      bondAmount: "1000",
      avgFillTime: 15,
      supportedChains: ["stellar"],
      supportedTokens: ["USDC"],
      proofSignature: "A".repeat(SIGNATURE_MAX_LENGTH),
    }), "proofSignature"],
  ])("accepts the maximum valid length on %s", async (_name, makeDto, property) => {
    const dto = makeDto();
    const errors = await validate(dto);
    expect(errors.filter((error) => error.property === property)).toHaveLength(0);
  });

  it.each([
    ["AcceptIntentDto", () => Object.assign(new AcceptIntentDto(), { solver: VALID_PUBLIC_KEY, signature: "A".repeat(SIGNATURE_MAX_LENGTH + 1) }), "signature"],
    ["FillIntentDto", () => Object.assign(new FillIntentDto(), { solver: VALID_PUBLIC_KEY, fillAmount: "1000", signature: "A".repeat(SIGNATURE_MAX_LENGTH + 1) }), "signature"],
    ["CancelIntentDto", () => Object.assign(new CancelIntentDto(), { user: VALID_PUBLIC_KEY, signature: "A".repeat(SIGNATURE_MAX_LENGTH + 1) }), "signature"],
    ["UpdateSolverStatusDto", () => Object.assign(new UpdateSolverStatusDto(), { signature: "A".repeat(SIGNATURE_MAX_LENGTH + 1) }), "signature"],
    ["RegisterSolverDto", () => Object.assign(new RegisterSolverDto(), {
      address: VALID_PUBLIC_KEY,
      name: "Solver One",
      bondAmount: "1000",
      avgFillTime: 15,
      supportedChains: ["stellar"],
      supportedTokens: ["USDC"],
      proofSignature: "A".repeat(SIGNATURE_MAX_LENGTH + 1),
    }), "proofSignature"],
  ])("rejects values longer than the maximum on %s", async (_name, makeDto, property) => {
    const dto = makeDto();
    const errors = await validate(dto);
    expect(errors.filter((error) => error.property === property)).not.toHaveLength(0);
  });
});
