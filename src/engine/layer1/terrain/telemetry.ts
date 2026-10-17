import type { TerrainErrorPayload, TerrainTelemetry } from "./types.ts";

/**
 * Telemetry accumulator for the most recent generation / error state.
 * Monotonic clock source is injectable for tests; defaults to performance.now
 * when present, falling back to Date.now (both standard-library, no DOM).
 */
export type Clock = () => number;

const defaultClock: Clock =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

export class TerrainTelemetryAccumulator {
  private generationTimeMs = 0;
  private triangleCount = 0;
  private textureCount = 0;
  private lastError: TerrainErrorPayload | null = null;
  private readonly clock: Clock;

  constructor(clock: Clock = defaultClock) {
    this.clock = clock;
  }

  now(): number {
    return this.clock();
  }

  recordGeneration(elapsedMs: number, triangleCount: number, textureCount: number): void {
    this.generationTimeMs = elapsedMs;
    this.triangleCount = triangleCount;
    this.textureCount = textureCount;
  }

  recordError(error: TerrainErrorPayload): void {
    this.lastError = { ...error };
  }

  snapshot(): TerrainTelemetry {
    return {
      generationTimeMs: this.generationTimeMs,
      triangleCount: this.triangleCount,
      textureCount: this.textureCount,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }
}
