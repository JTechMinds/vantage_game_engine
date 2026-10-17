import type { BiomeId, MaterialChannel } from "../types.ts";
import { MATERIAL_CHANNELS } from "../types.ts";

/**
 * Pure biome height + material profile data.
 * Each biome changes BOTH the height shaping and the material assignment.
 * Profiles are data; the generator applies them deterministically.
 */
export interface BiomeProfile {
  readonly id: BiomeId;
  /** Base terrain height in meters at elevation=5 before knob shaping. */
  readonly baseHeight: number;
  /** Mountain amplitude in meters at mountainAggression=10. */
  readonly mountainAmp: number;
  /** Ridge noise frequency (cycles across the world). */
  readonly ridgeFreq: number;
  /** Base rolling-noise frequency. */
  readonly baseFreq: number;
  /** Valley depth in meters at valleyAggression=10. */
  readonly valleyDepth: number;
  /** River carve depth in meters at riverAggression=10. */
  readonly riverDepth: number;
  /** Water surface height in meters, or null when the biome has no water. */
  readonly waterLevel: number | null;
  /** Fraction of the biome default elevation offset (0..1) shifting terrain up/down. */
  readonly elevationBias: number;
  /** Radial island falloff: terrain sinks toward water outside this normalized radius. Null = no island shape. */
  readonly island: null | { readonly radius: number; readonly softness: number; readonly rimHeight: number };
  /** Normalized height (0..1 of biome height range) where snow begins; null = no snow. */
  readonly snowThreshold: number | null;
  /** Max normalized slope where snow can settle (steeper = exposed rock). */
  readonly snowSlopeMax: number;
  /** Normalized height above water where sand stops dominating (beach/dune band). */
  readonly sandBand: number;
  /** Normalized slope at which rock starts to dominate. */
  readonly rockSlope: number;
  /** Weight of soil patches in low areas (0..1). */
  readonly soilMix: number;
  /** Weight of grass in low/mid areas (0..1). */
  readonly grassMix: number;
  /** Number of PBR texture slots this biome's material profile requires. */
  readonly textureCount: number;
}

export const BIOME_PROFILES: Readonly<Record<BiomeId, BiomeProfile>> = Object.freeze({
  desert: Object.freeze({
    id: "desert",
    baseHeight: 6,
    mountainAmp: 26,
    ridgeFreq: 3,
    baseFreq: 5,
    valleyDepth: 10,
    riverDepth: 6,
    waterLevel: null,
    elevationBias: 0.4,
    island: null,
    snowThreshold: 0.92,
    snowSlopeMax: 0.55,
    sandBand: 0.45,
    rockSlope: 0.55,
    soilMix: 0.25,
    grassMix: 0.02,
    textureCount: 3,
  }),
  highlands: Object.freeze({
    id: "highlands",
    baseHeight: 10,
    mountainAmp: 34,
    ridgeFreq: 4,
    baseFreq: 5,
    valleyDepth: 16,
    riverDepth: 10,
    waterLevel: null,
    elevationBias: 0.5,
    island: null,
    snowThreshold: 0.85,
    snowSlopeMax: 0.5,
    sandBand: 0.08,
    rockSlope: 0.6,
    soilMix: 0.35,
    grassMix: 0.9,
    textureCount: 4,
  }),
  alpine: Object.freeze({
    id: "alpine",
    baseHeight: 28,
    mountainAmp: 90,
    ridgeFreq: 5,
    baseFreq: 6,
    valleyDepth: 26,
    riverDepth: 14,
    waterLevel: null,
    elevationBias: 0.65,
    island: null,
    snowThreshold: 0.55,
    snowSlopeMax: 0.62,
    sandBand: 0.04,
    rockSlope: 0.45,
    soilMix: 0.15,
    grassMix: 0.25,
    textureCount: 4,
  }),
  water: Object.freeze({
    id: "water",
    baseHeight: 2,
    mountainAmp: 30,
    ridgeFreq: 3,
    baseFreq: 4,
    valleyDepth: 20,
    riverDepth: 12,
    waterLevel: 0,
    elevationBias: 0.5,
    island: { radius: 0.62, softness: 0.28, rimHeight: 10 },
    snowThreshold: 0.8,
    snowSlopeMax: 0.5,
    sandBand: 0.18,
    rockSlope: 0.6,
    soilMix: 0.2,
    grassMix: 0.4,
    textureCount: 5,
  }),
  caribbean: Object.freeze({
    id: "caribbean",
    baseHeight: 3,
    mountainAmp: 24,
    ridgeFreq: 3,
    baseFreq: 4,
    valleyDepth: 8,
    riverDepth: 6,
    waterLevel: 0,
    elevationBias: 0.45,
    island: { radius: 0.55, softness: 0.22, rimHeight: 12 },
    snowThreshold: null,
    snowSlopeMax: 1,
    sandBand: 0.3,
    rockSlope: 0.65,
    soilMix: 0.12,
    grassMix: 0.6,
    textureCount: 5,
  }),
});

export function getBiomeProfile(biome: BiomeId): BiomeProfile {
  return BIOME_PROFILES[biome];
}

export { MATERIAL_CHANNELS };
export type { MaterialChannel };
