import type { BiomeId, TerrainParams, ValidationIssue, ValidationResult } from "./types.ts";
import { BIOME_IDS, cloneParams, normalizeWindDirection } from "./params.ts";

/** Stable machine-readable validation error codes. */
export const TerrainErrorCode = {
  UNKNOWN_FIELD: "unknown-field",
  REQUIRED: "required",
  TYPE: "type",
  RANGE: "range",
  ENUM: "enum",
  INTEGER: "integer",
  SERIALIZE_INVALID_JSON: "SERIALIZE_INVALID_JSON",
  DESERIALIZE_MISSING_FIELD: "DESERIALIZE_MISSING_FIELD",
  DESERIALIZE_INVALID_PARAMETER: "DESERIALIZE_INVALID_PARAMETER",
  DESERIALIZE_UNSUPPORTED_VERSION: "DESERIALIZE_UNSUPPORTED_VERSION",
  DESERIALIZE_INVALID_WORLD_SIZE: "DESERIALIZE_INVALID_WORLD_SIZE",
} as const;

export type TerrainErrorCodeValue = (typeof TerrainErrorCode)[keyof typeof TerrainErrorCode];

const PARAM_FIELDS: readonly (keyof TerrainParams)[] = [
  "timeOfDay",
  "mountainAggression",
  "valleyAggression",
  "riverAggression",
  "elevation",
  "windIntensity",
  "windDirection",
  "biome",
  "seed",
  "wireframe",
];

const NUMERIC_RANGE: Partial<Record<keyof TerrainParams, [number, number, boolean]>> = {
  // [min, max, maxInclusive]
  timeOfDay: [0, 24, false],
  mountainAggression: [0, 10, true],
  valleyAggression: [0, 10, true],
  riverAggression: [0, 10, true],
  elevation: [0, 10, true],
  windIntensity: [0, 10, true],
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateNumeric(
  field: keyof TerrainParams,
  value: unknown,
  errors: ValidationIssue[],
): number | undefined {
  if (value === null || value === undefined) {
    errors.push({ field, code: TerrainErrorCode.REQUIRED, message: `${field} is required`, value });
    return undefined;
  }
  if (!isFiniteNumber(value)) {
    errors.push({
      field,
      code: TerrainErrorCode.TYPE,
      message: `${field} must be a finite number`,
      value,
    });
    return undefined;
  }
  const bounds = NUMERIC_RANGE[field];
  if (bounds) {
    const [min, max, maxInclusive] = bounds;
    const ok = value >= min && (maxInclusive ? value <= max : value < max);
    if (!ok) {
      const rangeText = maxInclusive ? `between ${min} and ${max}` : `between ${min} and less than ${max}`;
      errors.push({
        field,
        code: TerrainErrorCode.RANGE,
        message: `${field} must be ${rangeText}`,
        value,
      });
      return undefined;
    }
  }
  return value;
}

/**
 * Validate a complete parameter candidate. Returns normalized params
 * (windDirection in [0, 360)) only when valid.
 */
export function validateParams(candidate: TerrainParams): ValidationResult {
  const errors: ValidationIssue[] = [];
  const out: TerrainParams = cloneParams(candidate);

  out.timeOfDay = validateNumeric("timeOfDay", candidate.timeOfDay, errors) ?? candidate.timeOfDay;
  out.mountainAggression =
    validateNumeric("mountainAggression", candidate.mountainAggression, errors) ?? candidate.mountainAggression;
  out.valleyAggression =
    validateNumeric("valleyAggression", candidate.valleyAggression, errors) ?? candidate.valleyAggression;
  out.riverAggression =
    validateNumeric("riverAggression", candidate.riverAggression, errors) ?? candidate.riverAggression;
  out.elevation = validateNumeric("elevation", candidate.elevation, errors) ?? candidate.elevation;
  out.windIntensity = validateNumeric("windIntensity", candidate.windIntensity, errors) ?? candidate.windIntensity;

  // windDirection: any finite number accepted; normalized into [0, 360).
  if (candidate.windDirection === null || candidate.windDirection === undefined) {
    errors.push({
      field: "windDirection",
      code: TerrainErrorCode.REQUIRED,
      message: "windDirection is required",
      value: candidate.windDirection,
    });
  } else if (!isFiniteNumber(candidate.windDirection)) {
    errors.push({
      field: "windDirection",
      code: TerrainErrorCode.TYPE,
      message: "windDirection must be a finite number",
      value: candidate.windDirection,
    });
  } else {
    out.windDirection = normalizeWindDirection(candidate.windDirection);
  }

  if (typeof candidate.biome !== "string" || !BIOME_IDS.includes(candidate.biome as BiomeId)) {
    errors.push({
      field: "biome",
      code: TerrainErrorCode.ENUM,
      message: `biome must be one of: ${BIOME_IDS.join(", ")}`,
      value: candidate.biome,
    });
  } else {
    out.biome = candidate.biome as BiomeId;
  }

  if (candidate.seed === null || candidate.seed === undefined) {
    errors.push({ field: "seed", code: TerrainErrorCode.REQUIRED, message: "seed is required", value: candidate.seed });
  } else if (!isFiniteNumber(candidate.seed)) {
    errors.push({ field: "seed", code: TerrainErrorCode.TYPE, message: "seed must be a finite number", value: candidate.seed });
  } else if (!Number.isSafeInteger(candidate.seed)) {
    errors.push({
      field: "seed",
      code: TerrainErrorCode.INTEGER,
      message: "seed must be a finite safe integer",
      value: candidate.seed,
    });
  } else {
    out.seed = candidate.seed;
  }

  if (typeof candidate.wireframe !== "boolean") {
    errors.push({
      field: "wireframe",
      code: TerrainErrorCode.TYPE,
      message: "wireframe must be a boolean",
      value: candidate.wireframe,
    });
  } else {
    out.wireframe = candidate.wireframe;
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, errors: [], normalizedParams: out };
}

/**
 * Validate a partial patch against a base parameter set: reject unknown
 * top-level fields, validate provided fields, then validate the merged set.
 */
export function validatePatch(base: TerrainParams, patch: Record<string, unknown>): ValidationResult {
  const errors: ValidationIssue[] = [];

  for (const key of Object.keys(patch)) {
    if (!PARAM_FIELDS.includes(key as keyof TerrainParams)) {
      errors.push({
        field: key as keyof TerrainParams,
        code: TerrainErrorCode.UNKNOWN_FIELD,
        message: `unknown field "${key}"`,
        value: patch[key],
      });
    }
  }

  // Validate provided fields individually before merging so per-field type
  // errors surface against the patch values.
  const merged = cloneParams(base);
  for (const key of PARAM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const value = patch[key];
      if (key === "wireframe") {
        if (typeof value !== "boolean") {
          errors.push({ field: key, code: TerrainErrorCode.TYPE, message: "wireframe must be a boolean", value });
        } else {
          merged.wireframe = value;
        }
      } else if (key === "biome") {
        if (typeof value !== "string" || !BIOME_IDS.includes(value as BiomeId)) {
          errors.push({
            field: key,
            code: TerrainErrorCode.ENUM,
            message: `biome must be one of: ${BIOME_IDS.join(", ")}`,
            value,
          });
        } else {
          merged.biome = value as BiomeId;
        }
      } else if (key === "seed") {
        if (!isFiniteNumber(value)) {
          errors.push({ field: key, code: TerrainErrorCode.TYPE, message: "seed must be a finite number", value });
        } else if (!Number.isSafeInteger(value)) {
          errors.push({
            field: key,
            code: TerrainErrorCode.INTEGER,
            message: "seed must be a finite safe integer",
            value,
          });
        } else {
          merged.seed = value;
        }
      } else if (key === "windDirection") {
        if (!isFiniteNumber(value)) {
          errors.push({
            field: key,
            code: TerrainErrorCode.TYPE,
            message: "windDirection must be a finite number",
            value,
          });
        } else {
          merged.windDirection = normalizeWindDirection(value);
        }
      } else {
        const before = errors.length;
        const parsed = validateNumeric(key, value, errors);
        if (parsed !== undefined && errors.length === before) {
          (merged as unknown as Record<string, number>)[key] = parsed;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return validateParams(merged);
}
