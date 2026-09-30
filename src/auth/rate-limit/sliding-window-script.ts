/**
 * Atomic sliding-window rate limiter (issue #441).
 *
 * Implemented as a Redis Lua script so the read-modify-write sequence is
 * atomic — concurrent requests on any number of replicas cannot interleave
 * and bypass the limit through a check-then-act race.
 *
 * Algorithm (sliding window log):
 *   1. Evict sorted-set members whose score (request timestamp) is older than
 *      `now - windowMs`.
 *   2. Count the remaining members — the number of requests in the window.
 *   3. If the count is below the limit, add the current request and allow.
 *   4. Otherwise deny and report the reset time (oldest member + window).
 *
 * The sorted-set member is `<now>-<counter>` where `counter` comes from a
 * companion INCR key, guaranteeing uniqueness when several requests land in
 * the same millisecond. Both keys expire after `windowMs` of inactivity.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key      = KEYS[1]
local window   = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  local member = now .. '-' .. redis.call('INCR', key .. ':m')
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  redis.call('PEXPIRE', key .. ':m', window)
  return { 1, limit - count - 1, now + window }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_at = now
  if oldest and #oldest >= 2 then
    reset_at = tonumber(oldest[2]) + window
  end
  return { 0, 0, reset_at }
end
`;

/** Result tuple returned by the Lua script: { allowed, remaining, resetAt }. */
export type SlidingWindowTuple = [number, number, number];
