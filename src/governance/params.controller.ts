import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ProtocolParamsService, ParamsApiResponse } from "./params.service";

/**
 * Exposes current governance-controlled protocol parameters, any scheduled
 * pending change (with timelock ETA), and the recent history of parameter
 * versions.
 *
 * @see ProtocolParamsService
 */
@ApiTags("governance")
@Controller("api/v1/params")
export class ParamsController {
  constructor(private readonly paramsService: ProtocolParamsService) {}

  /**
   * GET /api/v1/params
   *
   * Returns:
   * - `current`  — the actively-enforced parameter set (version, feeBps, per-chain windows, …)
   * - `pending`  — the next scheduled change with its execution ledger and ETA, or `null`
   * - `history`  — previous parameter versions, newest-first (max 50)
   */
  @Get()
  @ApiOperation({
    summary: "Current and pending governance-controlled protocol parameters",
    description:
      "Returns the actively-enforced protocol parameters, any pending governance change " +
      "with its timelock execution ledger and ETA, and recent parameter history. " +
      "Parameters are sourced from the on-chain governance contract when PARAMS_CONTRACT_ID " +
      "is configured; code/env defaults are used otherwise.",
  })
  @ApiOkResponse({
    description: "Protocol parameters — current, pending, and history",
    schema: {
      type: "object",
      properties: {
        current: {
          type: "object",
          description: "Currently active protocol parameters",
          properties: {
            version: { type: "number", example: 3 },
            feeBps: { type: "number", example: 30, description: "Protocol fee in basis points" },
            chains: {
              type: "object",
              description: "Per-chain deadline and fill-window overrides",
              additionalProperties: {
                type: "object",
                properties: {
                  deadlineSeconds: { type: "number", example: 900 },
                  fillWindowSeconds: { type: "number", example: 120 },
                },
              },
            },
            maxExposureRatio: {
              type: "number",
              example: 0.05,
              description: "Maximum on-chain exposure ratio (0–1)",
            },
            slashAmount: { type: "string", example: "100000000" },
            activeSinceLedger: { type: "number", example: 12345678 },
            adoptedAt: { type: "string", format: "date-time" },
          },
          required: ["version", "feeBps", "chains", "maxExposureRatio", "slashAmount", "activeSinceLedger", "adoptedAt"],
        },
        pending: {
          nullable: true,
          description: "Scheduled governance change not yet activated, or null",
          oneOf: [
            {
              type: "object",
              properties: {
                params: { type: "object" },
                executionLedger: { type: "number", example: 12349999 },
                estimatedEta: {
                  type: "string",
                  format: "date-time",
                  description: "Best-effort ETA for timelock execution",
                },
                observedAt: { type: "string", format: "date-time" },
              },
            },
            { type: "null" },
          ],
        },
        history: {
          type: "array",
          description: "Previous parameter versions, newest-first (max 50)",
          items: { type: "object" },
        },
      },
      required: ["current", "pending", "history"],
    },
  })
  getParams(): ParamsApiResponse {
    return {
      current: this.paramsService.getCurrent(),
      pending: this.paramsService.getPending(),
      history: this.paramsService.getHistory(),
    };
  }
}
