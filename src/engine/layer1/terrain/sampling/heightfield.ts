import type { Heightfield, HeightfieldSampler } from "../types.ts";

/**
 * Heightfield sampling with bilinear interpolation.
 *
 * World coordinates: terrain spans [-meters/2, +meters/2] in X and Z,
 * Y is up. Vertex (ix, iz) sits at world x = -half + ix * cell,
 * z = -half + iz * cell, where cell = meters / (vertices - 1).
 *
 * Outside-bounds policy (documented, stable): coordinates are CLAMPED to
 * the nearest world edge and sampled there. sampleHeight never throws,
 * never returns NaN or Infinity for finite inputs, regardless of bounds.
 */
export class BilinearHeightfieldSampler implements HeightfieldSampler {
  sample(heightfield: Heightfield, x: number, z: number): number {
    const n = heightfield.vertices;
    const half = heightfield.meters / 2;
    const cell = heightfield.meters / (n - 1);

    // World -> fractional grid coordinates, clamped to the valid vertex range.
    let gx = (x + half) / cell;
    let gz = (z + half) / cell;
    if (!Number.isFinite(gx)) gx = 0;
    if (!Number.isFinite(gz)) gz = 0;
    gx = Math.min(n - 1, Math.max(0, gx));
    gz = Math.min(n - 1, Math.max(0, gz));

    const ix0 = Math.floor(gx);
    const iz0 = Math.floor(gz);
    const ix1 = Math.min(n - 1, ix0 + 1);
    const iz1 = Math.min(n - 1, iz0 + 1);
    const tx = gx - ix0;
    const tz = gz - iz0;

    const h = heightfield.heights;
    const h00 = h[iz0 * n + ix0];
    const h10 = h[iz0 * n + ix1];
    const h01 = h[iz1 * n + ix0];
    const h11 = h[iz1 * n + ix1];

    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }
}
