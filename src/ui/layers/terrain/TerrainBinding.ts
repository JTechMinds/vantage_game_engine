/**
 * TerrainBinding — wires an M-T1 TerrainLayer instance to the reusable
 * panel's ApiBinding contract.
 *
 * This is the ONLY terrain panel module that knows M-T1 method names and
 * event names. It imports the PUBLIC API path only (L1-AC-123) and never
 * touches heightfield arrays, generator internals, or renderer state.
 * All parameter changes go through setParams (L1-AC-035).
 */

import { createTerrainLayer } from "../../../engine/layer1/terrain/index.ts";
import type { TerrainLayer, TerrainEventName } from "../../../engine/layer1/terrain/index.ts";
import type { ApiBinding, Telemetry, ValidationError } from "../../panel/index.ts";

export type TerrainFactory = () => TerrainLayer;

type IssueCode = ValidationError["code"];

function mapCode(code: string): IssueCode {
  switch (code) {
    case "range":
      return "out-of-range";
    case "type":
    case "integer":
      return "invalid-type";
    case "enum":
      return "invalid-enum";
    case "unknown-field":
      return "unknown-field";
    default:
      return "custom";
  }
}

/**
 * UI text inputs emit strings; M-T1 requires a numeric seed. Coerce
 * finite-numeric strings to numbers before validation so a typed seed
 * behaves like a typed number without aliasing the field.
 */
function normalizePatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (typeof patch.seed === "string") {
    const n = Number(patch.seed);
    if (patch.seed.trim() !== "" && Number.isFinite(n)) {
      return { ...patch, seed: n };
    }
  }
  return patch;
}

/**
 * Creates the ApiBinding for the terrain panel.
 *
 * `factory` is injectable so tests can provide deterministic layers
 * (custom worldSize, stubs). Production uses createTerrainLayer().
 */
export function createTerrainBinding(factory: TerrainFactory = () => createTerrainLayer()): ApiBinding {
  const layer: TerrainLayer = factory();

  return {
    getParams(): Record<string, unknown> {
      return { ...layer.getParams() };
    },

    setParams(patch: Record<string, unknown>): void {
      // Public API only; atomic semantics owned by M-T1.
      layer.setParams(normalizePatch(patch));
    },

    validate(params?: Record<string, unknown>): ValidationError[] {
      const result = layer.validate(normalizePatch(params ?? {}) as never);
      return result.errors.map((issue) => ({
        key: String(issue.field),
        message: issue.message,
        code: mapCode(issue.code),
      }));
    },

    generate(): void {
      layer.generate();
    },

    randomize(): void {
      layer.randomize();
    },

    reset(): void {
      layer.reset();
    },

    serialize(): string {
      return layer.serialize();
    },

    deserialize(json: string): void {
      // Throws TerrainSerializationError on invalid input; the shell's load
      // handler catches and reports it without corrupting terrain state.
      layer.deserialize(json);
    },

    setWireframe(on: boolean): void {
      layer.setWireframe(on);
    },

    on(event: string, handler: (payload: unknown) => void): () => void {
      // Event names match M-T1 exactly (terrain-changed, generation-started,
      // generation-complete, error). Unknown events are no-op subscriptions.
      const known: readonly TerrainEventName[] = [
        "terrain-changed",
        "generation-started",
        "generation-complete",
        "error",
      ];
      if (!known.includes(event as TerrainEventName)) return () => {};
      return layer.on(event as TerrainEventName, handler as never);
    },

    telemetry(): Telemetry {
      const t = layer.telemetry();
      return {
        generationTimeMs: t.generationTimeMs,
        triangleCount: t.triangleCount,
        textureCount: t.textureCount,
      };
    },
  };
}
