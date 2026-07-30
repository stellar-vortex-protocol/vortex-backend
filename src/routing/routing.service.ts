import { Injectable } from "@nestjs/common";
import { Route, RouteStep, TokenInfo } from "../intents/intents.types";

@Injectable()
export class RoutingService {
  createDirectRoute(srcToken: TokenInfo, dstToken: TokenInfo, solver: string): Route {
    const step: RouteStep = {
      type: "transfer",
      protocol: "direct-solver",
      fromChain: srcToken.chain,
      toChain: "stellar",
      fromToken: srcToken,
      toToken: dstToken,
      estimatedTime: 60,
      estimatedGas: "0",
    };

    return {
      steps: [step],
      totalTime: step.estimatedTime,
      totalFeesUSD: 0,
      priceImpact: 0,
    };
  }
}
