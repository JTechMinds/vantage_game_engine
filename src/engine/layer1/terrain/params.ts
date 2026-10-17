import type { BiomeId, TerrainParams, TerrainWorldSize } from "./types.ts";

export const BIOME_IDS: readonly BiomeId[] = ["desert", "highlands", "alpine", "water", "caribbean"];

/** Supported world-size presets: 256 = fast small-test, 512 = default acceptance, 1024 = stretch. */
export const WORLD_SIZE_PRESETS: readonly TerrainWorldSize[] = Object.freeze([
  Object.freeze({ vertices: 256, meters: 256 }),
  Object.freeze({ vertices: 512, meters: 512 }),
  Object.freeze({ vertices: 1024, meters: 1024 }),
]);

/** Default world size per spec (resolved): 512x512 vertices over 512x512 meters. 256 is the fast small-test preset; 1024 the stretch preset. */
export const DEFAULT_WORLD_SIZE: Readonly<TerrainWorldSize> = Object.freeze({ vertices: 512, meters: 512 });

/**
 * Default parameter object — reset target. Frozen so consumers cannot mutate shared defaults.
 */
export const DEFAULT_TERRAIN_PARAMS: Readonly<TerrainParams> = Object.freeze({
  timeOfDay: 10,
  mountainAggression: 4,
  valleyAggression: 3,
  riverAggression: 2,
  elevation: 5,
  windIntensity: 3,
  windDirection: 180,
  biome: "highlands",
  seed: 1,
  wireframe: false,
});

/** Fields whose change requires a geometry rebuild. */
export const GEOMETRY_FIELDS: readonly (keyof TerrainParams)[] = Object.freeze([
  "mountainAggression",
  "valleyAggression",
  "riverAggression",
  "elevation",
  "biome",
  "seed",
]);

/** Fields that update state without geometry regeneration (renderer-facing). */
export const RENDERER_FIELDS: readonly (keyof TerrainParams)[] = Object.freeze([
  "timeOfDay",
  "windIntensity",
  "windDirection",
  "wireframe",
]);

export function isGeometryField(field: keyof TerrainParams): boolean {
  return GEOMETRY_FIELDS.includes(field);
}

export function cloneParams(params: TerrainParams): TerrainParams {
  return {
    timeOfDay: params.timeOfDay,
    mountainAggression: params.mountainAggression,
    valleyAggression: params.valleyAggression,
    riverAggression: params.riverAggression,
    elevation: params.elevation,
    windIntensity: params.windIntensity,
    windDirection: params.windDirection,
    biome: params.biome,
    seed: params.seed,
    wireframe: params.wireframe,
  };
}

/** Normalize wind direction into [0, 360). */
export function normalizeWindDirection(value: number): number {
  return ((value % 360) + 360) % 360;
}
