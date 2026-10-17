/**
 * Deterministic value noise + fBm + ridged noise.
 * All functions are pure: same seed + coordinates => same output.
 * No Math.random, no globals.
 */

import { hash2 } from "./prng.ts";

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hashUnit(ix: number, iy: number, seed: number): number {
  return (hash2(ix, iy, seed) & 0xffffff) / 0xffffff;
}

/** 2D value noise in [0, 1] at continuous coordinates. */
export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const n00 = hashUnit(x0, y0, seed);
  const n10 = hashUnit(x0 + 1, y0, seed);
  const n01 = hashUnit(x0, y0 + 1, seed);
  const n11 = hashUnit(x0 + 1, y0 + 1, seed);
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fy);
}

/** Fractal Brownian motion of value noise. Returns roughly [0, 1]. */
export function fbm(x: number, y: number, seed: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let s = seed | 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, s);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    s = (s + 0x9e3779b9) | 0;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged multifractal noise in [0, 1]. Peaks where the base noise approaches zero crossings. */
export function ridged(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let s = (seed ^ 0x5bf03635) | 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(x * freq, y * freq, s);
    const r = 1 - Math.abs(n * 2 - 1);
    sum += amp * r * r;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    s = (s + 0x85ebca6b) | 0;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Smooth 0->1 ramp between edges. Deterministic, continuous. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
