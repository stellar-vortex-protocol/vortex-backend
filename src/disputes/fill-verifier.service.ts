import { Injectable } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { EvidenceVerification } from "./disputes.types";

/**
 * Automated evidence verification ("fill-verifier").
 *
 * Where possible, a submitted dispute is checked against recorded intent
 * state: if the solver claims the fill actually landed and supplies the
 * matching on-chain tx hash, the evidence is flagged as verified. Evidence
 * that can't be auto-checked (e.g. RPC-lag narratives) is left for human
 * review — `verified` is advisory, not dispositive.
 */
@Injectable()
export class FillVerifierService {
  constructor(private readonly intentsService: IntentsService) {}

  async verify(intentId: string, txHashes: string[]): Promise<EvidenceVerification> {
    if (txHashes.length === 0) {
      return { verified: false, reason: "no transaction hashes supplied" };
    }

    const intent = await this.intentsService.get(intentId);
    if (!intent) {
      return { verified: false, reason: "intent not found" };
    }

    if (intent.state === "filled" && intent.txHash && txHashes.includes(intent.txHash)) {
      return { verified: true, reason: "evidence tx hash matches the recorded on-chain fill" };
    }

    if (intent.state === "filled") {
      return { verified: false, reason: "fill recorded but no evidence tx hash matches it" };
    }

    return { verified: false, reason: `intent is not filled (state=${intent.state})` };
  }
}
