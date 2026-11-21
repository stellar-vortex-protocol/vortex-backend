import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ProtocolParamsService } from "./protocol-params.service";
import { GuardianStateService, ALL_PARAMS } from "./guardian-state.service";

interface FrozenKeyStatus {
  key: string;
  since: string;
  reason: string;
  actionId?: string;
  txHash?: string;
}

interface FreezeStatusResponse {
  globallyFrozen: boolean;
  frozenKeys: FrozenKeyStatus[];
}

@ApiTags("params")
@Controller("api/v1/params")
@ApiOkResponse({ description: "Protocol parameters" })
export class ParamsController {
  constructor(
    private readonly params: ProtocolParamsService,
    private readonly guardianState: GuardianStateService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Get current protocol parameters" })
  get() {
    return this.params.get();
  }

  @Get("freeze-status")
  @ApiOperation({
    summary: "Get guardian freeze status for protocol parameters",
    description:
      "Cross-references guardian-frozen parameter keys with the guardian action that froze them. " +
      "`globallyFrozen` is true when the ALL_PARAMS (\"*\") freeze is active; per-key freezes are listed in `frozenKeys`.",
  })
  @ApiOkResponse({
    description: "Guardian freeze status",
    schema: {
      type: "object",
      properties: {
        globallyFrozen: { type: "boolean" },
        frozenKeys: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              since: { type: "string" },
              reason: { type: "string" },
              actionId: { type: "string", nullable: true },
              txHash: { type: "string", nullable: true },
            },
            required: ["key", "since", "reason"],
          },
        },
      },
      required: ["globallyFrozen", "frozenKeys"],
    },
  })
  freezeStatus(): FreezeStatusResponse {
    const { frozenParams } = this.guardianState.snapshot();
    const globallyFrozen = Object.prototype.hasOwnProperty.call(frozenParams, ALL_PARAMS);
    const frozenKeys: FrozenKeyStatus[] = Object.entries(frozenParams)
      .filter(([key]) => key !== ALL_PARAMS)
      .map(([key, ref]) => ({
        key,
        since: ref.since,
        reason: ref.reason,
        actionId: ref.actionId,
        txHash: ref.txHash,
      }));
    return { globallyFrozen, frozenKeys };
  }
}
