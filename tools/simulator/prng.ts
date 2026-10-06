/**
 * Deterministic, seedable PRNG for the simulation harness (issue #452).
 *
 * mulberry32: 32-bit state, uniform in `[0, 1)`. Chosen over
 * `Math.random()` because replays must be bit-for-bit reproducible from a
 * seed — including strategies that inject their own randomness through
 * `StrategyContext.random`.
 */

/**
 * Create a deterministic generator from a 32-bit seed.
 *
 * @param seed Any number; coerced to uint32 so negative seeds are stable.
 * @returns A function producing floats in `[0, 1)`.
 */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
