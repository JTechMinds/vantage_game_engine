import type { TerrainEventEmitter, TerrainEventName, TerrainEventPayloadMap } from "./types.ts";

/**
 * Lightweight non-DOM event registry. Handler exceptions are isolated so one
 * bad listener cannot corrupt terrain state or block other listeners.
 */
export class TerrainEventBus implements TerrainEventEmitter {
  private readonly listeners: Map<string, Set<(payload: never) => void>> = new Map();
  private onError: ((error: unknown) => void) | null = null;

  /** Optional sink for isolated handler errors (wired to telemetry by the layer). */
  setHandlerErrorSink(sink: (error: unknown) => void): void {
    this.onError = sink;
  }

  on<E extends TerrainEventName>(
    event: E,
    handler: (payload: TerrainEventPayloadMap[E]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set!.delete(handler as (payload: never) => void);
    };
  }

  emit<E extends TerrainEventName>(event: E, payload: TerrainEventPayloadMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (p: TerrainEventPayloadMap[E]) => void)(payload);
      } catch (err) {
        if (this.onError) this.onError(err);
      }
    }
  }
}
