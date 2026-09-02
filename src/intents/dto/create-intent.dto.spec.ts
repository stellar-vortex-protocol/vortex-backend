import { validate } from "class-validator";
import { CreateIntentDto } from "./create-intent.dto";

const VALID_PUBLIC_KEY = "G" + "A".repeat(55);

describe("CreateIntentDto", () => {
  const makeDto = (overrides: Partial<CreateIntentDto> = {}) =>
    Object.assign(new CreateIntentDto(), {
      user: VALID_PUBLIC_KEY,
      srcChain: "ethereum" as const,
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      srcTokenSymbol: "USDC",
      srcTokenDecimals: 6,
      srcAmount: "1000000",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      dstTokenSymbol: "USDC",
      dstTokenDecimals: 6,
      minDstAmount: "990000",
      ...overrides,
    });

  it("rejects a Stellar self-swap when srcTokenAddress matches dstTokenContract", async () => {
    const dto = makeDto({
      srcChain: "stellar",
      srcTokenAddress: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    });

    const errors = await validate(dto);
    const selfSwapErrors = errors.filter((error) => error.property === "dstTokenContract");

    expect(selfSwapErrors.length).toBeGreaterThan(0);
    expect(selfSwapErrors[0].constraints).toMatchObject({
      isNotSelfSwap: expect.stringContaining("Self-swaps are not allowed"),
    });
  });

  it("allows same-symbol contracts across different chains", async () => {
    const dto = makeDto({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
