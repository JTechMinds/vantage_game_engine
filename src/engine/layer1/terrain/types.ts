/**
 * Layer 1 terrain core — shared public and internal type definitions.
 * Types + constants only. Must never import platform, renderer, UI, or Layer 2+ code.
 */

export type BiomeId = "desert" | "highlands" | "alpine" | "water" | "caribbean";

export interface TerrainParams {
  /** Sun/moon position, sky color, lighting, water reflection tone. 0 midnight, 6 sunrise, 12 noon, 18 sunset. */
  timeOfDay: number;
  /** Amplitude/prominence of mountains and ridges. 0 flat/gentle, 10 prominent. */
  mountainAggression: number;
  /** Presence/prominence of valleys and depressions. 0 minimal, 10 deep and frequent. */
  valleyAggression: number;
  /** River/channel carving where the biome supports water. 0 none, 10 strong continuous channels. */
  riverAggression: number;
  /** Overall terrain height scale. Finite, smooth geometry across the full range. */
  elevation: number;
  /** Wind strength (water ripple amplitude/speed, cloud drift). 0 calm, 10 strong. Renderer-facing. */
  windIntensity: number;
  /** Compass degrees. 0 = north-facing drift. Normalized to [0, 360) before storage. */
  windDirection: number;
  /** Biome profile controlling height shaping and material assignment. */
  biome: BiomeId;
  /** Deterministic generation seed. Finite safe integer. */
  seed: number;
  /** Debug wireframe overlay state. Stored on the model; does not affect generation or sampling. */
  wireframe: boolean;
}

export interface TerrainWorldSize {
  vertices: number;
  meters: number;
}

export interface ValidationIssue {
  field: keyof TerrainParams;
  code: string;
  message: string;
  value?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  normalizedParams?: TerrainParams;
}

export interface TerrainErrorPayload {
  code: string;
  message: string;
  field?: string;
  expected?: string;
  received?: string;
}

export interface TerrainTelemetry {
  generationTimeMs: number;
  triangleCount: number;
  textureCount: number;
  lastError: TerrainErrorPayload | null;
}

export interface TerrainSnapshot {
  schemaVersion: string;
  layer: string;
  generated: boolean;
  seed: number;
  biome: BiomeId;
  worldSize: TerrainWorldSize;
  heightMin: number;
  heightMax: number;
  waterLevel: number | null;
  waterVertexCount: number;
  waterFraction: number;
  triangleCount: number;
  textureCount: number;
  wireframe: boolean;
}

export type TerrainChangeSource =
  | "setParams"
  | "randomize"
  | "reset"
  | "deserialize"
  | "load"
  | "generate"
  | "setWireframe";

export interface TerrainEventPayloadMap {
  "terrain-changed": {
    source: TerrainChangeSource;
    params: Readonly<TerrainParams>;
    seed: number;
    biome: BiomeId;
  };
  "generation-started": { seed: number; biome: BiomeId; worldSize: TerrainWorldSize };
  "generation-complete": { snapshot: TerrainSnapshot; telemetry: TerrainTelemetry };
  "error": TerrainErrorPayload;
}

export type TerrainEventName = keyof TerrainEventPayloadMap;

/** Per-vertex surface material channel order used by Heightfield.materialField. */
export const MATERIAL_CHANNELS = ["sand", "rock", "grass", "soil", "snow"] as const;
export type MaterialChannel = (typeof MATERIAL_CHANNELS)[number];
export const MATERIAL_CHANNEL_COUNT = MATERIAL_CHANNELS.length;

/** Internal generated heightfield representation. Never exposed mutably through the public API. */
export interface Heightfield {
  vertices: number;
  meters: number;
  /** Y in meters per vertex, row-major [iz * vertices + ix]. */
  heights: Float64Array;
  /** MATERIAL_CHANNEL_COUNT weights per vertex, same layout as heights. */
  materialField: Float64Array;
  /** 1 where the vertex is covered by water, else 0. */
  waterMask: Uint8Array;
  /** Water depth in meters (0 where dry). */
  waterDepth: Float32Array;
  waterLevel: number | null;
  heightMin: number;
  heightMax: number;
  triangleCount: number;
  textureCount: number;
}

export interface GenerationInput {
  params: TerrainParams;
  worldSize: TerrainWorldSize;
}

export interface GenerationResult {
  heightfield: Heightfield;
}

export interface HeightfieldGenerator {
  generate(input: GenerationInput): GenerationResult;
}

export interface HeightfieldSampler {
  sample(heightfield: Heightfield, x: number, z: number): number;
}

export interface SerializableTerrainState {
  params: TerrainParams;
  worldSize: TerrainWorldSize;
  displayName?: string;
  notes?: string;
}

export interface DeserializedTerrainState {
  params: TerrainParams;
  /** Authoritative world size from the payload; applied atomically on successful restore. */
  worldSize?: TerrainWorldSize;
  displayName?: string;
  notes?: string;
}

export interface TerrainSerializer {
  serialize(state: SerializableTerrainState): string;
  deserialize(input: string): DeserializedTerrainState;
}

export interface TerrainEventEmitter {
  on<E extends TerrainEventName>(event: E, handler: (payload: TerrainEventPayloadMap[E]) => void): () => void;
  emit<E extends TerrainEventName>(event: E, payload: TerrainEventPayloadMap[E]): void;
}

/** Public Layer 1 terrain facade. Source of truth for terrain state. */
export interface TerrainLayer {
  getParams(): Readonly<TerrainParams>;
  setParams(patch: Partial<TerrainParams>): void;
  validate(patch: Partial<TerrainParams>): ValidationResult;
  generate(): void;
  sampleHeight(x: number, z: number): number;
  snapshot(): TerrainSnapshot;
  serialize(): string;
  deserialize(json: string): void;
  saveConfig(displayName?: string): string;
  loadConfig(json: string): void;
  randomize(): void;
  reset(): void;
  setWireframe(enabled: boolean): void;
  on<E extends TerrainEventName>(event: E, handler: (payload: TerrainEventPayloadMap[E]) => void): () => void;
  telemetry(): TerrainTelemetry;
}

/** Optional injected dependencies. Defaults supplied by createTerrainLayer(). */
export interface TerrainLayerOptions {
  generator?: HeightfieldGenerator;
  serializer?: TerrainSerializer;
  sampler?: HeightfieldSampler;
  eventEmitter?: TerrainEventEmitter;
  worldSize?: TerrainWorldSize;
}
