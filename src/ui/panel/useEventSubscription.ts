/**
 * Event subscription lifecycle for the reusable panel.
 *
 * Subscribes to the bound API's event stream on mount and returns a detach
 * function that tears every subscription down (idempotent). The shell never
 * knows concrete event payloads — handlers receive `unknown` and the panel
 * definition's binding owns any interpretation.
 */

import type { ApiBinding } from "./types.ts";

export interface PanelEventHandlers {
  /** `terrain-changed` — public state changed; re-read params. */
  onStateChanged: () => void;
  /** `generation-started` — show generating indicator. */
  onGenerationStarted: () => void;
  /** `generation-complete` — hide indicator, update telemetry. */
  onGenerationComplete: () => void;
  /** `error` — show error in status bar. */
  onError: (payload: unknown) => void;
}

export function attachEventSubscription(
  binding: ApiBinding,
  handlers: PanelEventHandlers,
): () => void {
  const unsubscribers: Array<() => void> = [];
  let detached = false;

  const subscribe = (event: string, handler: (payload: unknown) => void): void => {
    unsubscribers.push(binding.on(event, handler));
  };

  subscribe("terrain-changed", () => handlers.onStateChanged());
  subscribe("generation-started", () => handlers.onGenerationStarted());
  subscribe("generation-complete", () => handlers.onGenerationComplete());
  subscribe("error", (payload) => handlers.onError(payload));

  return () => {
    if (detached) return;
    detached = true;
    for (const off of unsubscribers) off();
    unsubscribers.length = 0;
  };
}
