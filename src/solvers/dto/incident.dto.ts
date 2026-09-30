import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";
import { SUPPORTED_CHAINS } from "../../intents/intents.types";

/**
 * Body for `POST /admin/anti-griefing/incidents` (issue #453).
 *
 * Declares a window during which unfilled accepts are *not* counted towards a
 * solver's rolling ratio, so a genuine chain outage cannot be mistaken for
 * griefing.
 */
export class BeginIncidentDto {
  @ApiPropertyOptional({
    description:
      "Source chain the incident covers. Omit to cover every chain. Validated " +
      "against the supported-chain list so a typo fails loudly instead of " +
      "silently creating an incident that never matches.",
    enum: SUPPORTED_CHAINS,
  })
  @IsOptional()
  @IsIn(SUPPORTED_CHAINS)
  chain?: string;

  @ApiProperty({ description: "Why the incident is being declared", minLength: 3 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Body for `POST /admin/anti-griefing/incidents/:id/end`.
 *
 * `excludeUntil` extends coverage past the closure instant, because the
 * sweeper can detect a missed fill long after the outage it was caused by.
 */
export class EndIncidentDto {
  @ApiPropertyOptional({
    description:
      "Epoch milliseconds through which failures stay excused (defaults to " +
      "the closure time, i.e. only failures during the incident).",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  excludeUntil?: number;
}
