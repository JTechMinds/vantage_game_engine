import type {
  BiomeId,
  DeserializedTerrainState,
  SerializableTerrainState,
  TerrainParams,
  TerrainSerializer,
} from "../types.ts";
import { DEFAULT_WORLD_SIZE } from "../params.ts";
import { TerrainErrorCode, validateParams } from "../validation.ts";

export const TERRAIN_SCHEMA_VERSION = "1.0.0";
export const TERRAIN_LAYER_ID = "layer1-terrain";

/** Structured serialization error with a stable machine-readable code. */
export class TerrainSerializationError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly expected?: string;
  readonly received?: string;

  constructor(code: string, message: string, field?: string, expected?: string, received?: string) {
    super(message);
    this.name = "TerrainSerializationError";
    this.code = code;
    this.field = field;
    this.expected = expected;
    this.received = received;
  }
}

function bound(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text !== undefined && text.length > 120 ? `${text.slice(0, 117)}...` : String(text);
}

/**
 * Versioned JSON serializer for terrain configuration (not mesh/heightfield
 * data). Terrain is reconstructed deterministically from seed + parameters.
 */
export class VersionedJsonTerrainSerializer implements TerrainSerializer {
  serialize(state: SerializableTerrainState): string {
    const doc: Record<string, unknown> = {
      schemaVersion: TERRAIN_SCHEMA_VERSION,
      layer: TERRAIN_LAYER_ID,
      createdAt: new Date().toISOString(),
      parameters: { ...state.params },
      seed: state.params.seed,
      biome: state.params.biome,
      wireframe: state.params.wireframe,
      worldSize: { ...state.worldSize },
    };
    if (state.displayName !== undefined) doc.displayName = state.displayName;
    if (state.notes !== undefined) doc.notes = state.notes;
    return JSON.stringify(doc, null, 2);
  }

  deserialize(input: string): DeserializedTerrainState {
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      doc = parsed as Record<string, unknown>;
    } catch (err) {
      throw new TerrainSerializationError(
        TerrainErrorCode.SERIALIZE_INVALID_JSON,
        `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const version = doc.schemaVersion;
    if (version === undefined) {
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_MISSING_FIELD,
        'missing required field "schemaVersion"',
        "schemaVersion",
      );
    }
    if (typeof version !== "string" || version.split(".")[0] !== TERRAIN_SCHEMA_VERSION.split(".")[0]) {
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_UNSUPPORTED_VERSION,
        `unsupported schemaVersion "${bound(version)}"; supported major: ${TERRAIN_SCHEMA_VERSION.split(".")[0]}`,
        "schemaVersion",
        TERRAIN_SCHEMA_VERSION,
        bound(version),
      );
    }

    if (doc.layer === undefined) {
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_MISSING_FIELD,
        'missing required field "layer"',
        "layer",
      );
    }

    const rawParams = doc.parameters;
    if (rawParams === undefined) {
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_MISSING_FIELD,
        'missing required field "parameters"',
        "parameters",
      );
    }
    if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_INVALID_PARAMETER,
        '"parameters" must be an object',
        "parameters",
        "object",
        bound(rawParams),
      );
    }

    const params = rawParams as Record<string, unknown>;
    // seed and biome are required top-level fields too; parameters object is
    // the authoritative source but they must be consistent when present.
    for (const key of ["seed", "biome"]) {
      if (doc[key] === undefined) {
        throw new TerrainSerializationError(
          TerrainErrorCode.DESERIALIZE_MISSING_FIELD,
          `missing required field "${key}"`,
          key,
        );
      }
    }

    const merged: TerrainParams = {
      timeOfDay: (params.timeOfDay as number) ?? 0,
      mountainAggression: (params.mountainAggression as number) ?? 0,
      valleyAggression: (params.valleyAggression as number) ?? 0,
      riverAggression: (params.riverAggression as number) ?? 0,
      elevation: (params.elevation as number) ?? 0,
      windIntensity: (params.windIntensity as number) ?? 0,
      windDirection: (params.windDirection as number) ?? 0,
      biome: (params.biome as BiomeId) ?? (doc.biome as BiomeId),
      seed: (params.seed as number) ?? (doc.seed as number),
      wireframe: typeof params.wireframe === "boolean" ? params.wireframe : doc.wireframe === true,
    };

    const result = validateParams(merged);
    if (!result.valid || result.normalizedParams === undefined) {
      const first = result.errors[0];
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_INVALID_PARAMETER,
        first ? first.message : "invalid parameters",
        first ? first.field : "parameters",
      );
    }

    // Payload worldSize is authoritative (spec: Serialization Boundary). Missing,
    // non-finite, or off-preset payloads are rejected with a structured error so
    // the instance can never silently diverge from the saved world size.
    const ws = doc.worldSize;
    const presets = [256, 512, 1024];
    const wsObj = ws !== null && typeof ws === "object" && !Array.isArray(ws)
      ? ws as { vertices?: unknown; meters?: unknown }
      : undefined;
    const wsVerts = wsObj ? wsObj.vertices : undefined;
    const wsMeters = wsObj ? wsObj.meters : undefined;
    if (
      wsObj === undefined ||
      typeof wsVerts !== "number" || !Number.isFinite(wsVerts) || !presets.includes(wsVerts) ||
      typeof wsMeters !== "number" || !Number.isFinite(wsMeters) || !presets.includes(wsMeters)
    ) {
      throw new TerrainSerializationError(
        TerrainErrorCode.DESERIALIZE_INVALID_WORLD_SIZE,
        "payload worldSize is missing, non-finite, or outside supported presets 256/512/1024",
        "worldSize",
        "{ vertices: 256|512|1024, meters: 256|512|1024 }",
        bound(ws),
      );
    }

    const state: DeserializedTerrainState = {
      params: result.normalizedParams,
      worldSize: { vertices: wsVerts, meters: wsMeters },
    };
    // Unknown future fields are ignored; known optionals are carried through.
    if (typeof doc.displayName === "string") state.displayName = doc.displayName;
    if (typeof doc.notes === "string") state.notes = doc.notes;
    return state;
  }
}

export { DEFAULT_WORLD_SIZE };
