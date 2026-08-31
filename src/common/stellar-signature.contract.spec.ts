import { Keypair } from "@stellar/stellar-sdk";
import {
  buildAcceptMessage,
  buildCancelMessage,
  buildFillMessage,
  buildRegisterMessage,
  buildSolverStatusMessage,
  verifyStellarSignature,
} from "./stellar-signature";

const VALID_PUBLIC_KEY = "G" + "A".repeat(55);

const messageBuilders: Array<{ name: string; builder: (...args: any[]) => string; args: any[] }> = [
  { name: "buildCancelMessage", builder: buildCancelMessage, args: ["intent-123"] },
  { name: "buildAcceptMessage", builder: buildAcceptMessage, args: ["intent-123", VALID_PUBLIC_KEY] },
  { name: "buildFillMessage", builder: buildFillMessage, args: ["intent-123", VALID_PUBLIC_KEY] },
  { name: "buildRegisterMessage", builder: buildRegisterMessage, args: [VALID_PUBLIC_KEY] },
  {
    name: "buildSolverStatusMessage",
    builder: buildSolverStatusMessage,
    args: ["deactivate", VALID_PUBLIC_KEY],
  },
];

describe("stellar-signature message contract", () => {
  it.each(messageBuilders)("$name is deterministic and verifiable", ({ builder, args }) => {
    const message = builder(...args);
    const again = builder(...args);

    expect(again).toBe(message);
    expect(message).toContain(":");
    expect(message.split(":").every((part) => !part.includes(":"))).toBe(true);

    const signer = Keypair.random();
    const signature = Buffer.from(signer.sign(Buffer.from(message, "utf8"))).toString("base64");

    expect(() => verifyStellarSignature(signer.publicKey(), message, signature)).not.toThrow();
  });

  it("keeps each builder on the same canonical colon-delimited format", () => {
    const messages = messageBuilders.map(({ builder, args }) => builder(...args));

    for (const message of messages) {
      const parts = message.split(":");
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.every((part) => part.length > 0)).toBe(true);
      expect(parts.every((part) => !part.includes(":"))).toBe(true);
    }
  });
});
