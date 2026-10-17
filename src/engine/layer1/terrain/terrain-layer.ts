import type {
  DeserializedTerrainState,
  Heightfield,
  HeightfieldGenerator,
  HeightfieldSampler,
  SerializableTerrainState,
  TerrainChangeSource,
  TerrainEventEmitter,
  TerrainEventName,
  TerrainEventPayloadMap,
  TerrainErrorPayload,
  TerrainLayer,
  TerrainLayerOptions,
  TerrainParams,
  TerrainSerializer,
  TerrainSnapshot,
  TerrainTelemetry,
  TerrainWorldSize,
  ValidationIssue,
  ValidationResult,
} from "./types.ts";
import { DEFAULT_TERRAIN_PARAMS, DEFAULT_WORLD_SIZE, GEOMETRY_FIELDS, cloneParams, isGeometryField } from "./params.ts";
import { TerrainErrorCode, validatePatch, validateParams } from "./validation.ts";
import { DeterministicHeightfieldGenerator } from "./generation/index.ts";
import { BilinearHeightfieldSampler } from "./sampling/heightfield.ts";
import { TERRAIN_LAYER_ID, TERRAIN_SCHEMA_VERSION, TerrainSerializationError, VersionedJsonTerrainSerializer } from "./serialization/json.ts";
import { TerrainEventBus } from "./events.ts";
import { TerrainTelemetryAccumulator } from "./telemetry.ts";

/**
 * Public facade and state orchestration for the headless terrain core.
 * Owns validated parameters, the generated heightfield, telemetry, wireframe
 * state, and event emission. Does not own renderer, UI, DOM, camera, physics,
 * entity, or object state.
 */
class TerrainLayerImpl implements TerrainLayer {
  private params: TerrainParams;
  private heightfield: Heightfield | null = null;
  private worldSize: TerrainWorldSize;
  private readonly generator: HeightfieldGenerator;
  private readonly sampler: HeightfieldSampler;
  private readonly serializer: TerrainSerializer;
  private readonly bus: TerrainEventBus;
  private readonly telemetryAcc: TerrainTelemetryAccumulator;
  private displayName: string | undefined;
  private notes: string | undefined;

  constructor(options: TerrainLayerOptions, bus: TerrainEventBus, telemetry: TerrainTelemetryAccumulator) {
    this.worldSize = options.worldSize
      ? Object.freeze({ vertices: options.worldSize.vertices, meters: options.worldSize.meters })
      : DEFAULT_WORLD_SIZE;
    this.generator = options.generator ?? new DeterministicHeightfieldGenerator();
    this.sampler = options.sampler ?? new BilinearHeightfieldSampler();
    this.serializer = options.serializer ?? new VersionedJsonTerrainSerializer();
    this.bus = bus;
    this.telemetryAcc = telemetry;
    this.bus.setHandlerErrorSink((err) => {
      this.recordError({
        code: "HANDLER_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    });
    const initial = validateParams({ ...DEFAULT_TERRAIN_PARAMS });
    // Defaults are valid by construction.
    this.params = initial.normalizedParams ?? { ...DEFAULT_TERRAIN_PARAMS };
  }

  getParams(): Readonly<TerrainParams> {
    return Object.freeze(cloneParams(this.params));
  }

  validate(patch: Partial<TerrainParams>): ValidationResult {
    return validatePatch(this.params, patch as Record<string, unknown>);
  }

  setParams(patch: Partial<TerrainParams>): void {
    const result = this.validate(patch);
    if (!result.valid || result.normalizedParams === undefined) {
      this.failValidation("setParams", result.errors);
      return;
    }
    const previous = this.params;
    const next = result.normalizedParams;
    this.params = next;
    const geometryChanged = GEOMETRY_FIELDS.some((f) => isGeometryField(f) && previous[f] !== next[f]);
    if (geometryChanged) {
      this.runGeneration("setParams");
    } else {
      this.emitChanged("setParams");
    }
  }

  generate(): void {
    this.runGeneration("generate");
  }

  sampleHeight(x: number, z: number): number {
    if (this.heightfield === null) {
      throw new TerrainSerializationError(
        "NOT_GENERATED",
        "sampleHeight requires a generated heightfield; call generate() first",
      );
    }
    return this.sampler.sample(this.heightfield, x, z);
  }

  snapshot(): TerrainSnapshot {
    const hf = this.heightfield;
    const waterVertexCount = hf ? countWater(hf) : 0;
    return {
      schemaVersion: TERRAIN_SCHEMA_VERSION,
      layer: TERRAIN_LAYER_ID,
      generated: hf !== null,
      seed: this.params.seed,
      biome: this.params.biome,
      worldSize: { ...this.worldSize },
      heightMin: hf ? hf.heightMin : 0,
      heightMax: hf ? hf.heightMax : 0,
      waterLevel: hf ? hf.waterLevel : null,
      waterVertexCount,
      waterFraction: hf ? waterVertexCount / (hf.vertices * hf.vertices) : 0,
      triangleCount: hf ? hf.triangleCount : 0,
      textureCount: hf ? hf.textureCount : 0,
      wireframe: this.params.wireframe,
    };
  }

  serialize(): string {
    return this.serializer.serialize(this.serializableState());
  }

  saveConfig(displayName?: string): string {
    if (displayName !== undefined) this.displayName = displayName;
    return this.serializer.serialize(this.serializableState());
  }

  deserialize(json: string): void {
    let state: DeserializedTerrainState;
    try {
      state = this.serializer.deserialize(json);
    } catch (err) {
      const payload: TerrainErrorPayload =
        err instanceof TerrainSerializationError
          ? { code: err.code, message: err.message, field: err.field, expected: err.expected, received: err.received }
          : { code: "DESERIALIZE_FAILED", message: err instanceof Error ? err.message : String(err) };
      this.recordError(payload);
      this.bus.emit("error", payload);
      throw err;
    }
    // Atomic apply: parameters and payload-authoritative world size land
    // together before regeneration, so no observer sees a mixed state.
    if (state.worldSize !== undefined) {
      this.worldSize = Object.freeze({ vertices: state.worldSize.vertices, meters: state.worldSize.meters });
    }
    this.params = state.params;
    if (state.displayName !== undefined) this.displayName = state.displayName;
    if (state.notes !== undefined) this.notes = state.notes;
    this.runGeneration("deserialize");
  }

  loadConfig(json: string): void {
    this.deserialize(json);
  }

  randomize(): void {
    // Platform randomness is permitted ONLY to choose the next seed; heightfield
    // generation itself always consumes the stored seed deterministically.
    const seed = Math.floor(Math.random() * 2147483647);
    this.params = { ...this.params, seed };
    this.runGeneration("randomize");
  }

  reset(): void {
    const fresh = validateParams({ ...DEFAULT_TERRAIN_PARAMS });
    this.params = fresh.normalizedParams ?? { ...DEFAULT_TERRAIN_PARAMS };
    this.runGeneration("reset");
  }

  setWireframe(enabled: boolean): void {
    if (typeof enabled !== "boolean") {
      const payload: TerrainErrorPayload = {
        code: TerrainErrorCode.TYPE,
        message: "wireframe must be a boolean",
        field: "wireframe",
      };
      this.recordError(payload);
      this.bus.emit("error", payload);
      return;
    }
    if (this.params.wireframe === enabled) return;
    this.params = { ...this.params, wireframe: enabled };
    this.emitChanged("setWireframe");
  }

  on<E extends TerrainEventName>(
    event: E,
    handler: (payload: TerrainEventPayloadMap[E]) => void,
  ): () => void {
    return this.bus.on(event, handler);
  }

  telemetry(): TerrainTelemetry {
    return this.telemetryAcc.snapshot();
  }

  private serializableState(): SerializableTerrainState {
    const state: SerializableTerrainState = {
      params: cloneParams(this.params),
      worldSize: { ...this.worldSize },
    };
    if (this.displayName !== undefined) state.displayName = this.displayName;
    if (this.notes !== undefined) state.notes = this.notes;
    return state;
  }

  private runGeneration(source: TerrainChangeSource): void {
    this.bus.emit("generation-started", {
      seed: this.params.seed,
      biome: this.params.biome,
      worldSize: { ...this.worldSize },
    });
    const started = this.telemetryAcc.now();
    try {
      const result = this.generator.generate({ params: cloneParams(this.params), worldSize: this.worldSize });
      this.heightfield = result.heightfield;
      const elapsed = this.telemetryAcc.now() - started;
      this.telemetryAcc.recordGeneration(elapsed, result.heightfield.triangleCount, result.heightfield.textureCount);
      const snapshot = this.snapshot();
      this.bus.emit("generation-complete", { snapshot, telemetry: this.telemetryAcc.snapshot() });
      // terrain-changed accompanies operations that changed public state.
      if (source !== "generate") this.emitChanged(source);
    } catch (err) {
      const payload: TerrainErrorPayload = {
        code: "GENERATION_FAILED",
        message: err instanceof Error ? err.message : String(err),
      };
      this.recordError(payload);
      this.bus.emit("error", payload);
      throw err;
    }
  }

  private emitChanged(source: TerrainChangeSource): void {
    this.bus.emit("terrain-changed", {
      source,
      params: Object.freeze(cloneParams(this.params)),
      seed: this.params.seed,
      biome: this.params.biome,
    });
  }

  private failValidation(operation: string, errors: ValidationIssue[]): void {
    const first = errors[0];
    const payload: TerrainErrorPayload = {
      code: first ? first.code : "VALIDATION_FAILED",
      message: first ? first.message : `invalid parameters for ${operation}`,
      field: first ? first.field : undefined,
    };
    this.recordError(payload);
    this.bus.emit("error", payload);
  }

  private recordError(payload: TerrainErrorPayload): void {
    this.telemetryAcc.recordError(payload);
  }
}

function countWater(hf: Heightfield): number {
  let count = 0;
  for (let i = 0; i < hf.waterMask.length; i++) {
    if (hf.waterMask[i] === 1) count++;
  }
  return count;
}

/**
 * Public factory. Instantiable in plain Node with no DOM, renderer, or UI.
 * Importing this module has no side effects and creates no shared state.
 */
export function createTerrainLayer(options?: TerrainLayerOptions): TerrainLayer {
  const bus = new TerrainEventBus();
  const telemetry = new TerrainTelemetryAccumulator();
  return new TerrainLayerImpl(options ?? {}, bus, telemetry);
}
