import { fbm, ridged, smoothstep } from "../terrain/generation/noise.ts";
import { getBiomeProfile } from "../terrain/generation/biome-profiles.ts";
import { mixSeed } from "../terrain/generation/prng.ts";
import type { TerrainParams } from "../terrain/types.ts";

/**
 * IEP Phase-2 (spec-interactive-edit-preview-phase2.md §2A / §4.2): a height-only
 * regeneration used to drive the disposable live preview during an interactive
 * edit. It mirrors the deterministic generator's HEIGHT pipeline exactly (base
 * fbm -> ridged mountains -> valleys -> rivers -> island falloff -> elevation
 * scale -> smoothing) so the preview is a faithful cheap view of the pending
 * params, but it SKIPS the material-field, water-region, and normal-assignment
 * passes, which are the dominant per-vertex cost and are not displayed on the
 * stripped unlit preview mesh. It also runs at a reduced grid (coarse substrate),
 * not the full worldSize.vertices.
 *
 * This module is engine-internal. It never calls runGeneration, never emits
 * generation-started/generation-complete, and never touches committed buffers.
 * It is a pure function of (params, worldMeters, gridN).
 */
export interface PreviewHeights {
  /** Row-major gridN*gridN height field (world Y, meters). */
  readonly heights: Float64Array;
  readonly gridN: number;
  readonly worldMeters: number;
}

/**
 * Evaluate terrain HEIGHT at a reduced gridN x gridN lattice over a
 * worldMeters-square world for the given (possibly un-committed) params.
 *
 * Coordinate convention matches mesh.ts: normalized 0..1 per vertex, world
 * position = (u - 0.5) * worldMeters, so the eval and the committed mesh agree
 * on where each vertex sits. The noise is sampled in the same normalized space
 * as the full generator, so a preview vertex lands on the same height the full
 * build would produce at that (u,v), modulo the reduced grid's smoothing scale.
 */
export function generatePreviewHeights(
  params: TerrainParams,
  worldMeters: number,
  gridN: number,
): PreviewHeights {
  const profile = getBiomeProfile(params.biome);
  const n = Math.max(2, Math.floor(gridN));
  const heights = new Float64Array(n * n);

  const seedM = mixSeed(params.seed, 11);
  const seedV = mixSeed(params.seed, 23);
  const seedR = mixSeed(params.seed, 37);
  const seedP = mixSeed(params.seed, 53);

  const mKnob = params.mountainAggression / 10;
  const vKnob = params.valleyAggression / 10;
  const rKnob = params.riverAggression / 10;
  const elevScale = 0.2 + (params.elevation / 10) * 1.6;

  for (let iz = 0; iz < n; iz++) {
    const vz = iz / (n - 1);
    for (let ix = 0; ix < n; ix++) {
      const vx = ix / (n - 1);
      const idx = iz * n + ix;

      const base = fbm(vx * profile.baseFreq, vz * profile.baseFreq, seedP, 5);
      const ridge = ridged(vx * profile.ridgeFreq, vz * profile.ridgeFreq, seedM, 5);
      const mountain = ridge * ridge * profile.mountainAmp * mKnob;
      const valleyMask = smoothstep(0.35, 0.65, fbm(vx * 3.1, vz * 3.1, seedV, 4));
      const valley = valleyMask * profile.valleyDepth * vKnob;
      const riverNoise = ridged(vx * 2.2 + 7.31, vz * 2.2 - 4.17, seedR, 3);
      const riverMask = smoothstep(0.82, 0.97, riverNoise) * (1 - valleyMask * 0.35);
      const river = riverMask * profile.riverDepth * rKnob;

      let h = profile.baseHeight + base * profile.baseHeight * 0.6 + mountain - valley - river;

      if (profile.island) {
        const dx = vx - 0.5;
        const dz = vz - 0.5;
        const r = Math.sqrt(dx * dx + dz * dz) * 2;
        const { radius, softness, rimHeight } = profile.island;
        const islandMask = 1 - smoothstep(radius - softness, radius + softness, r);
        const seabed = -profile.baseHeight * 1.5;
        h = seabed + (h + Math.abs(seabed)) * islandMask + rimHeight * islandMask * base * 0.3;
        h = Math.max(h, seabed);
      }

      h = (h - profile.baseHeight) * elevScale + profile.baseHeight + profile.elevationBias * 2 - 1;
      heights[idx] = h;
    }
  }

  // Same separable box-blur the full generator applies (2 passes), so the
  // preview's large-scale form matches; grid-scale detail is intentionally
  // coarser because the grid itself is coarse.
  smoothPass(heights, n, 2);

  return { heights, gridN: n, worldMeters };
}

/** Separable box blur (height-only), mirrors deterministic-generator.smoothPass. */
function smoothPass(target: Float64Array, n: number, passes: number): void {
  const buf = new Float64Array(n * n);
  for (let p = 0; p < passes; p++) {
    for (let iz = 0; iz < n; iz++) {
      const row = iz * n;
      for (let ix = 0; ix < n; ix++) {
        const a = target[row + (ix > 0 ? ix - 1 : ix)];
        const b = target[row + ix];
        const c = target[row + (ix < n - 1 ? ix + 1 : ix)];
        buf[row + ix] = (a + 2 * b + c) / 4;
      }
    }
    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) {
        const a = buf[(iz > 0 ? iz - 1 : iz) * n + ix];
        const b = buf[iz * n + ix];
        const c = buf[(iz < n - 1 ? iz + 1 : iz) * n + ix];
        target[iz * n + ix] = (a + 2 * b + c) / 4;
      }
    }
  }
}
