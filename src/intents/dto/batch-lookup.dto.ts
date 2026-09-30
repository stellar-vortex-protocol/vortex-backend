import { ArrayMaxSize, IsArray, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { BATCH_LOOKUP_MAX_IDS } from "../../config/limits.config";

/**
 * Body for `POST /api/v1/intents/batch` (issue #275).
 *
 * A solver bot tracking many concurrently-accepted intents — or a frontend
 * rendering a user's full history — can reconcile a known set of intent IDs
 * against current server state in one call instead of N `GET /:id` requests.
 *
 * `intentIds` is capped with `@ArrayMaxSize` per the hardening pattern in
 * issue #476 so a single request can't fan out unbounded work.  The limit
 * constant is defined in src/config/limits.config.ts.
 */
export class BatchLookupDto {
  @ApiProperty({
    type: [String],
    maxItems: BATCH_LOOKUP_MAX_IDS,
    description: `Intent IDs to look up (max ${BATCH_LOOKUP_MAX_IDS}). IDs with no matching record are omitted from the response, not individually 404'd.`,
  })
  @IsArray()
  @ArrayMaxSize(BATCH_LOOKUP_MAX_IDS)
  @IsString({ each: true })
  intentIds!: string[];
}
