import type {
  GenerationInput,
  GenerationResult,
  Heightfield,
  HeightfieldGenerator,
} from "../types.ts";
import { MATERIAL_CHANNEL_COUNT } from "../types.ts";
import { getBiomeProfile, type BiomeProfile } from "./biome-profiles.ts";
import { fbm, ridged, smoothstep, valueNoise } from "./noise.ts";
import { mixSeed } from "./prng.ts";

/**
 * Default deterministic heightfield generator.
 * Pure: no Math.random, no Date.now, no globals, no I/O. Same seed + same params
 * + same world resolution => identical output.
 *
 * Height pipeline (meters, Y up, world spans -meters/2 .. +meters/2 in X/Z):
 *   base rolling noise -> ridged mountains (mountainAggression)
 *   -> valley carving (valleyAggression) -> river carving (riverAggression)
 *   -> island falloff (water/caribbean) -> elevation scale -> smoothing
 *   -> water regions -> material assignment from height + slope + noise.
 */
export class DeterministicHeightfieldGenerator implements HeightfieldGenerator {
  generate(input: GenerationInput): GenerationResult {
    const { params, worldSize } = input;
    const profile = getBiomeProfile(params.biome);
    const n = worldSize.vertices;
    const meters = worldSize.meters;
    const cell = meters / (n - 1);

    const heights = new Float64Array(n * n);
    const materialField = new Float64Array(n * n * MATERIAL_CHANNEL_COUNT);
    const waterMask = new Uint8Array(n * n);
    const waterDepth = new Float32Array(n * n);

    const seedM = mixSeed(params.seed, 11);
    const seedV = mixSeed(params.seed, 23);
    const seedR = mixSeed(params.seed, 37);
    const seedP = mixSeed(params.seed, 53);

    const mKnob = params.mountainAggression / 10;
    const vKnob = params.valleyAggression / 10;
    const rKnob = params.riverAggression / 10;
    // Elevation 5 is the neutral scale; 0 flattens toward base, 10 doubles.
    const elevScale = 0.2 + (params.elevation / 10) * 1.6;

    const half = meters / 2;
    // Normalized continuous coordinates (0..1 across world) per vertex.
    for (let iz = 0; iz < n; iz++) {
      const vz = iz / (n - 1);
      for (let ix = 0; ix < n; ix++) {
        const vx = ix / (n - 1);
        const idx = iz * n + ix;

        // 1. Base rolling terrain, always gentle-present (never fully flat).
        const base = fbm(vx * profile.baseFreq, vz * profile.baseFreq, seedP, 5);

        // 2. Ridged mountains.
        const ridge = ridged(vx * profile.ridgeFreq, vz * profile.ridgeFreq, seedM, 5);
        const mountain = ridge * ridge * profile.mountainAmp * mKnob;

        // 3. Valleys: inverted smooth mask carves depressions.
        const valleyMask = smoothstep(0.35, 0.65, fbm(vx * 3.1, vz * 3.1, seedV, 4));
        const valley = valleyMask * profile.valleyDepth * vKnob;

        // 4. Rivers: narrow ridged channels carve downward.
        const riverNoise = ridged(vx * 2.2 + 7.31, vz * 2.2 - 4.17, seedR, 3);
        const riverMask = smoothstep(0.82, 0.97, riverNoise) * (1 - valleyMask * 0.35);
        const river = riverMask * profile.riverDepth * rKnob;

        let h = profile.baseHeight + base * profile.baseHeight * 0.6 + mountain - valley - river;

        // 5. Island shape for water-bearing biomes: radial falloff to seabed.
        if (profile.island) {
          const dx = vx - 0.5;
          const dz = vz - 0.5;
          const r = Math.sqrt(dx * dx + dz * dz) * 2; // 0 center -> ~1.41 corner
          const { radius, softness, rimHeight } = profile.island;
          const islandMask = 1 - smoothstep(radius - softness, radius + softness, r);
          const seabed = -profile.baseHeight * 1.5;
          h = seabed + (h + Math.abs(seabed)) * islandMask + rimHeight * islandMask * base * 0.3;
          // Rivers on islands can still carve but cannot punch below seabed.
          h = Math.max(h, seabed);
        }

        // 6. Elevation scale about the biome base.
        h = (h - profile.baseHeight) * elevScale + profile.baseHeight + profile.elevationBias * 2 - 1;

        heights[idx] = h;
      }
    }

    // 7. Smoothing passes: remove grid-scale jaggedness while preserving form.
    this.smoothPass(heights, n, 2);

    // 8. Slopes for material rules (normalized 0..1 against a biome slope scale).
    const slopeScale = 2.2 + profile.mountainAmp * 0.06;
    const slopes = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const idx = iz * n + ix;
        const xl = heights[idx - (ix > 0 ? 1 : 0)];
        const xr = heights[idx + (ix < n - 1 ? 1 : 0)];
        const zl = heights[idx - (iz > 0 ? n : 0)];
        const zr = heights[idx + (iz < n - 1 ? n : 0)];
        const gx = (xr - xl) / (2 * cell);
        const gz = (zr - zl) / (2 * cell);
        slopes[idx] = Math.min(1, Math.sqrt(gx * gx + gz * gz) / slopeScale);
      }
    }

    // Height stats for normalized material thresholds.
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] < hMin) hMin = heights[i];
      if (heights[i] > hMax) hMax = heights[i];
    }
    const span = Math.max(1e-6, hMax - hMin);

    // 9. Water regions.
    const waterLevel = profile.waterLevel;
    let waterCount = 0;
    if (waterLevel !== null) {
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] < waterLevel) {
          waterMask[i] = 1;
          waterDepth[i] = waterLevel - heights[i];
          waterCount++;
        }
      }
    }

    // 10. Material assignment: channels [sand, rock, grass, soil, snow].
    // Normalized height above water (or above min) drives bands; slope drives rock;
    // patch noise breaks bands into natural blends.
    for (let iz = 0; iz < n; iz++) {
      const vz = iz / (n - 1);
      for (let ix = 0; ix < n; ix++) {
        const vx = ix / (n - 1);
        const idx = iz * n + ix;
        const h = heights[idx];
        const slope = slopes[idx];
        const patch = fbm(vx * 9, vz * 9, mixSeed(params.seed, 71), 3);

        const above = waterLevel !== null ? h - waterLevel : h - hMin;
        const norm = Math.min(1, Math.max(0, (h - hMin) / span));

        let sand = 0;
        let rock = 0;
        let grass = 0;
        let soil = 0;
        let snow = 0;

        // Beach/dune band near the water's edge or terrain base.
        const beachBand = profile.sandBand * span;
        if (above < beachBand) {
          sand = smoothstep(beachBand, beachBand * 0.25, above) * (1 - smoothstep(0.4, 0.75, slope));
        }
        // Rock: steep slopes and high ground.
        rock = smoothstep(profile.rockSlope, profile.rockSlope + 0.3, slope);
        rock += smoothstep(0.62, 0.9, norm) * (1 - rock) * 0.8;
        // Grass: low/mid, gentle slopes, biome mix.
        grass = (1 - smoothstep(0.35, 0.7, norm)) * (1 - smoothstep(0.35, 0.7, slope)) * profile.grassMix;
        // Soil: valleys and noisy patches.
        soil = profile.soilMix * smoothstep(0.55, 0.25, norm) * smoothstep(0.3, 0.65, patch);
        // Snow: high peaks, gentle slopes, biome threshold.
        if (profile.snowThreshold !== null) {
          snow =
            smoothstep(profile.snowThreshold, profile.snowThreshold + 0.12, norm) *
            (1 - smoothstep(profile.snowSlopeMax, profile.snowSlopeMax + 0.25, slope));
        }

        // Patch noise blends bands (no hard steps).
        sand *= 0.8 + patch * 0.4;
        grass *= 0.8 + (1 - patch) * 0.4;

        const base = 1 - Math.min(1, sand + rock + grass + soil + snow);
        if (base > 0) {
          // Unclaimed ground defaults to the biome's dominant low material.
          if (profile.grassMix >= 0.5) grass += base;
          else if (profile.sandBand > 0.2) sand += base;
          else rock += base;
        }

        const total = sand + rock + grass + soil + snow || 1;
        const o = idx * MATERIAL_CHANNEL_COUNT;
        materialField[o] = sand / total;
        materialField[o + 1] = rock / total;
        materialField[o + 2] = grass / total;
        materialField[o + 3] = soil / total;
        materialField[o + 4] = snow / total;
      }
    }

    const trianglesPerQuad = 2;
    const triangleCount = (n - 1) * (n - 1) * trianglesPerQuad;

    const heightfield: Heightfield = {
      vertices: n,
      meters,
      heights,
      materialField,
      waterMask,
      waterDepth,
      waterLevel,
      heightMin: hMin,
      heightMax: hMax,
      triangleCount,
      textureCount: profile.textureCount,
    };

    return { heightfield };
  }

  /** Separable box blur applied `passes` times; preserves large-scale form. */
  private smoothPass(target: Float64Array, n: number, passes: number): void {
    const buf = new Float64Array(n * n);
    for (let p = 0; p < passes; p++) {
      // Horizontal
      for (let iz = 0; iz < n; iz++) {
        const row = iz * n;
        for (let ix = 0; ix < n; ix++) {
          const a = target[row + (ix > 0 ? ix - 1 : ix)];
          const b = target[row + ix];
          const c = target[row + (ix < n - 1 ? ix + 1 : ix)];
          buf[row + ix] = (a + 2 * b + c) / 4;
        }
      }
      // Vertical
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
}

/** Convenience: profile export for telemetry consumers. */
export { type BiomeProfile };
