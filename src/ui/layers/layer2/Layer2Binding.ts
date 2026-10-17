/**
 * Layer2Binding — trivial in-memory binding stub for the dummy Layer 2
 * panel (reuse proof, L1-AC-039).
 *
 * Stores two values. No terrain, no engine, no persistence. Implements the
 * shared ApiBinding contract so the dummy panel proves the shell is genuinely
 * reusable without copying terrain logic.
 */

import type { ApiBinding, Telemetry, ValidationError } from "../../panel/index.ts";

export interface Layer2BindingState {
  objectCount: number;
  showGrid: boolean;
}

const DEFAULTS: Layer2BindingState = { objectCount: 10, showGrid: false };

export function createLayer2Binding(): ApiBinding {
  let state: Layer2BindingState = { ...DEFAULTS };
  const listeners = new Set<(event: string, payload: unknown) => void>();

  function emit(event: string, payload: unknown): void {
    for (const fn of listeners) fn(event, payload);
  }

  return {
    getParams(): Record<string, unknown> {
      return { ...state };
    },

    setParams(patch: Record<string, unknown>): void {
      const errors = validatePatch(patch);
      if (errors.length > 0) {
        emit("error", { message: errors[0].message, field: errors[0].key });
        return;
      }
      if (typeof patch.objectCount === "number") state.objectCount = patch.objectCount;
      if (typeof patch.showGrid === "boolean") state.showGrid = patch.showGrid;
      emit("terrain-changed", { source: "setParams" });
    },

    validate(params?: Record<string, unknown>): ValidationError[] {
      return validatePatch(params ?? {});
    },

    generate(): void {
      /* no-op: stub has no geometry */
    },

    randomize(): void {
      state.objectCount = Math.floor(Math.random() * 101);
      emit("terrain-changed", { source: "randomize" });
    },

    reset(): void {
      state = { ...DEFAULTS };
      emit("terrain-changed", { source: "reset" });
    },

    serialize(): string {
      return JSON.stringify({ schemaVersion: "0.0.1", layer: "layer2-stub", parameters: { ...state } });
    },

    deserialize(json: string): void {
      const parsed = JSON.parse(json) as { parameters?: Partial<Layer2BindingState> };
      if (!parsed || typeof parsed !== "object" || !parsed.parameters) {
        throw new Error("invalid layer2 configuration");
      }
      state = { ...DEFAULTS, ...parsed.parameters };
      emit("terrain-changed", { source: "deserialize" });
    },

    setWireframe(on: boolean): void {
      state.showGrid = on;
      emit("terrain-changed", { source: "setWireframe" });
    },

    on(event: string, handler: (payload: unknown) => void): () => void {
      const fn = (e: string, payload: unknown): void => {
        if (e === event) handler(payload);
      };
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    telemetry(): Telemetry {
      return { generationTimeMs: 0, triangleCount: state.objectCount, textureCount: 0 };
    },
  };

  function validatePatch(patch: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = [];
    if ("objectCount" in patch) {
      const v = patch.objectCount;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
        errors.push({ key: "objectCount", message: "Object Count must be between 0 and 100", code: "out-of-range" });
      }
    }
    if ("showGrid" in patch && typeof patch.showGrid !== "boolean") {
      errors.push({ key: "showGrid", message: "Show Grid must be a boolean", code: "invalid-type" });
    }
    return errors;
  }
}
