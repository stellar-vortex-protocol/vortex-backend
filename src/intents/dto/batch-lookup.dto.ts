import { ArrayMaxSize, IsArray, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * Body for `POST /api/v1/intents/batch` (issue #275).
 *
 * A solver bot tracking many concurrently-accepted intents — or a frontend
 * rendering a user's full history — can reconcile a known set of intent IDs
 * against current server state in one call instead of N `GET /:id` requests.
 *
 * `intentIds` is capped with `@ArrayMaxSize` per the hardening pattern in
 * issue #24 so a single request can't fan out unbounded work.
 */
export class BatchLookupDto {
  @ApiProperty({
    type: [String],
    maxItems: 100,
    description:
      "Intent IDs to look up (max 100). IDs with no matching record are omitted from the response, not individually 404'd.",
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  intentIds!: string[];
}
