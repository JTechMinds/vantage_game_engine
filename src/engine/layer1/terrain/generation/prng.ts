/**
 * Seed-derived deterministic pseudo-random utilities.
 * No Math.random, no globals, no platform dependencies.
 */

/** SplitMix64-style 32-bit integer mixer. Deterministic for any safe-integer seed. */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed | 0) ^ (salt * 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (h >>> 16), 0x6b10f1f9);
  h ^= h >>> 15;
  return h | 0;
}

/** Hash a 2D grid coordinate + seed into a deterministic uint32. */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x27d4eb2f) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h ^ (h >>> 13), 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Deterministic PRNG stream derived from a seed (mulberry32). */
export function createSeededRng(seed: number): () => number {
  let a = mixSeed(seed, 1) >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
