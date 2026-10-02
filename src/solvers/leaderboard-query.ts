export type LeaderboardSortKey = "fills" | "reputation";

export interface LeaderboardQuery {
  cursor?: string;
  limit?: number;
  chain?: string;
  /**
   * Primary sort key for the leaderboard (issue #444).
   *   "fills"      — existing behaviour, sorted by fillsCompleted desc.
   *   "reputation" — sorted by the Reputation v2 score (see RFC 0003),
   *                  with fillsCompleted as a tie-breaker.
   * Defaults to "fills" for backward compatibility.
   */
  sort?: LeaderboardSortKey;
  /**
   * Optional window filter, mirroring the controller's `window` query param.
   * "all" means the filter is applied externally; this module itself does not
   * apply time windowing — callers pass already-filtered solver data.
   */
  window?: "24h" | "7d" | "30d" | "all";
}
