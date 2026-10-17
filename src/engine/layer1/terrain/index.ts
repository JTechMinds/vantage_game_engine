/**
 * Layer 1 terrain — public API surface.
 *
 * This barrel is the stable public entry point for the headless terrain core.
 * It re-exports ONLY public symbols: the factory, the terrain interface, and
 * the public parameter/telemetry/event types. Internal heightfield arrays,
 * noise helpers, biome internals, and renderer helpers are never re-exported.
 *
 * Importing this module has no side effects and creates no shared state.
 */

export { createTerrainLayer } from "./terrain-layer.ts";

export type {
  BiomeId,
  TerrainLayer,
  TerrainLayerOptions,
  TerrainParams,
  TerrainSnapshot,
  TerrainTelemetry,
  TerrainEventName,
  TerrainEventPayloadMap,
  TerrainWorldSize,
  TerrainErrorPayload,
  TerrainChangeSource,
  ValidationIssue,
  ValidationResult,
} from "./types.ts";

export { DEFAULT_TERRAIN_PARAMS, DEFAULT_WORLD_SIZE, WORLD_SIZE_PRESETS } from "./params.ts";
export { TerrainErrorCode } from "./validation.ts";

export type { ValidationError } from "./error-compat.ts";
