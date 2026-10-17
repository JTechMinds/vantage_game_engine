"use strict";

/**
 * IEP height-ramp (spec-preview-height-ramp.md §5.1): a pure, headless,
 * three-free color-mapping helper for the disposable preview scratch mesh.
 *
 * Responsibility boundary: owns the height→color policy (normalization +
 * 3-stop linear interpolation) so it can be unit-tested without a GL context
 * and without importing three. The caller (preview-scratch.ts) owns the
 * sRGB→linear conversion and the GPU BufferAttribute lifecycle.
 *
 * Determinism: given identical heights, outputs identical colors. No RNG,
 * no time, no frame index. Pure function of (heights, count, palette).
 */

/**
 * A 3-stop color ramp in LINEAR RGB (already converted from sRGB by the
 * caller). Stops sit at t=0 (low), t=0.5 (mid), t=1 (high).
 *
 * The caller converts sRGB hex → linear once at construction (via
 * THREE.Color.convertSRGBToLinear) so the displayed colors land correctly
 * after the SRGB output transform. Keeping three out of this module keeps
 * the helper unit-testable headless.
 */
export interface RampPalette {
  /** Nine linear-RGB values: [r0,g0,b0, r1,g1,b1, r2,g2,b2] — low/mid/high stops. */
  readonly stops: readonly [
    number, number, number,
    number, number, number,
    number, number, number,
  ];
}

/**
 * Default palette (spec §4, §16 R-Q1 — shipped default, @Jordan may override):
 *   low  = cool teal/blue  sRGB #2d6a72
 *   mid  = neutral green   sRGB #4a8c5c
 *   high = warm tan/brown  sRGB #b5906a
 *
 * These are sRGB hex values; the caller converts them to linear RGB before
 * passing them as a RampPalette. Do not invent new colors (spec §15).
 */
export const DEFAULT_RAMP_SRGB: readonly [number, number, number] = [
  0x2d6a72, // low  — cool teal/blue
  0x4a8c5c, // mid  — neutral green
  0xb5906a, // high — warm tan/brown
];

/** The non-finite range the ramp normalized over (for the probe's colorStats). */
export interface RampRange {
  readonly minH: number;
  readonly maxH: number;
}

/**
 * Write count*3 linear-RGB floats into `out` (Float32Array, length ≥ count*3)
 * by mapping each height through a self-normalizing 3-stop ramp. Returns the
 * finite min/max the normalization used so the caller can build colorStats
 * without a second scan (spec §15: bias to fewer passes).
 *
 * Self-normalization: t = (h - minH) / (maxH - minH), clamped to [0,1].
 * If maxH == minH (flat field) every vertex maps to the mid stop.
 * Non-finite heights map to the mid stop (NaN guard, spec §9).
 *
 * Interpolation: two-segment linear lerp — low→mid for t∈[0,0.5],
 * mid→high for t∈[0.5,1]. Stop positions fixed at 0/0.5/1 (spec §5.1).
 */
export function applyHeightRamp(
  heights: ArrayLike<number>,
  count: number,
  out: Float32Array,
  palette: RampPalette,
): RampRange {
  if (count <= 0) return { minH: 0, maxH: 0 }; // degenerate / empty field guard (spec §9)

  // 1. Find min/max (non-finite values are skipped for range computation).
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < count; i++) {
    const h = heights[i];
    if (!Number.isFinite(h)) continue;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }

  // Flat field or all-NaN: fill mid stop for every vertex.
  const flat = !Number.isFinite(minH) || !Number.isFinite(maxH) || maxH === minH;
  const range = flat ? 1 : maxH - minH; // avoid /0
  const outMin = Number.isFinite(minH) ? minH : 0;
  const outMax = Number.isFinite(maxH) ? maxH : 0;

  const [r0, g0, b0, r1, g1, b1, r2, g2, b2] = palette.stops;

  for (let i = 0; i < count; i++) {
    const h = heights[i];
    // NaN / non-finite guard (spec §9): map to mid stop.
    if (!Number.isFinite(h)) {
      out[i * 3] = r1;
      out[i * 3 + 1] = g1;
      out[i * 3 + 2] = b1;
      continue;
    }
    // Self-normalize to [0,1], clamped.
    let t: number;
    if (flat) {
      t = 0.5; // mid stop
    } else {
      t = (h - minH) / range;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    // Two-segment linear lerp: low→mid for t∈[0,0.5], mid→high for t∈[0.5,1].
    let r: number, g: number, b: number;
    if (t <= 0.5) {
      const u = t * 2; // 0..1 within low→mid segment
      r = r0 + (r1 - r0) * u;
      g = g0 + (g1 - g0) * u;
      b = b0 + (b1 - b0) * u;
    } else {
      const u = (t - 0.5) * 2; // 0..1 within mid→high segment
      r = r1 + (r2 - r1) * u;
      g = g1 + (g2 - g1) * u;
      b = b1 + (b2 - b1) * u;
    }
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }

  return { minH: outMin, maxH: outMax };
}
