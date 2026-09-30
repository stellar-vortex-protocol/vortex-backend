import { BadRequestException, PreconditionFailedException } from "@nestjs/common";
import { Intent } from "./intents.types";
import { VersionConflict } from "./intents.repository";

/**
 * HTTP entity tags for intents (issue #405).
 *
 * The ETag is the intent's optimistic-concurrency `version` as a strong,
 * quoted tag — `"3"`. Clients send it back in `If-Match` on mutating
 * endpoints; a mismatch yields `412 Precondition Failed` (RFC 9110 §13.1.1).
 */
export function etagFor(intent: Pick<Intent, "version">): string {
  return `"${intent.version}"`;
}

/**
 * Parse an `If-Match` header into the expected version.
 *
 * Returns `undefined` when the header is absent or `*` (match any current
 * representation). Weak tags (`W/"3"`) are accepted for leniency with
 * proxies that weaken ETags. Lists (`"1", "2"`) are rejected because a single
 * conditional UPDATE can only assert one version.
 *
 * @throws BadRequestException for malformed values.
 */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value === "" || value === "*") return undefined;

  const match = /^(?:W\/)?"(\d{1,10})"$/.exec(value) ?? /^(\d{1,10})$/.exec(value);
  if (!match) {
    throw new BadRequestException(
      'If-Match must be a single entity tag from a previous ETag response, e.g. If-Match: "3"',
    );
  }
  return Number(match[1]);
}

/** Build the 412 response for a failed `If-Match` precondition. */
export function preconditionFailed(conflict: VersionConflict): PreconditionFailedException {
  return new PreconditionFailedException({
    error: "Intent was modified since the supplied If-Match version",
    intentId: conflict.intentId,
    expectedVersion: conflict.expectedVersion,
    currentVersion: conflict.actualVersion,
    currentETag: `"${conflict.actualVersion}"`,
  });
}
