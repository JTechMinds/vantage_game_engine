/**
 * StatusBar — validation summary, telemetry line, and transient messages.
 *
 * Layer-agnostic. Receives structured errors + telemetry via method calls;
 * never imports any engine layer.
 */

import type { Telemetry, ValidationError } from "./types.ts";
import { PANEL_STRINGS } from "./strings.ts";

/**
 * IEP Phase-1 (spec 2C): the edit-commit rebuild indicator surface.
 * idle hides the busy element; busy shows the Rebuilding copy; long
 * escalates to the long-operation copy. Exposed as a data-state attribute
 * on the element so a CI test can read a falsifiable visible-state timeline
 * (IEP-AC-09).
 */
export type RebuildState = "idle" | "busy" | "long";

export interface StatusBarView {
  root: HTMLElement;
  setValidationSummary: (errors: ValidationError[]) => void;
  setTelemetry: (t: Telemetry | null) => void;
  setMessage: (msg: string | null) => void;
  setGenerating: (on: boolean) => void;
  /** IEP Phase-1: drive the Rebuilding indicator state (spec 2C). */
  setRebuildState: (state: RebuildState) => void;
  /** Read the current rebuild-indicator state (test seam). */
  getRebuildState: () => RebuildState;
  /** Scroll to and focus the control with the given key (from validation click). */
  onValidationErrorClick: ((key: string) => void) | null;
}

export function renderStatusBar(): StatusBarView {
  const root = document.createElement("div");
  root.className = "panel-status";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");

  const validationEl = document.createElement("span");
  validationEl.className = "panel-status__validation";

  const messageEl = document.createElement("span");
  messageEl.className = "panel-status__message";

  const generatingEl = document.createElement("span");
  generatingEl.className = "panel-status__generating";
  generatingEl.textContent = PANEL_STRINGS.generating;
  generatingEl.hidden = true;
  generatingEl.dataset.rebuildState = "idle";

  const telemetryEl = document.createElement("span");
  telemetryEl.className = "panel-status__telemetry";

  root.appendChild(validationEl);
  root.appendChild(messageEl);
  root.appendChild(generatingEl);
  root.appendChild(telemetryEl);

  let errorHandler: ((key: string) => void) | null = null;

  function setValidationSummary(errors: ValidationError[]): void {
    if (errors.length === 0) {
      validationEl.textContent = "";
      validationEl.removeAttribute("tabindex");
      return;
    }
    const n = errors.length;
    validationEl.textContent = `${n} ${n === 1 ? PANEL_STRINGS.invalidParam : PANEL_STRINGS.invalidParams}`;
    validationEl.setAttribute("tabindex", "0");
    validationEl.setAttribute("role", "button");
    validationEl.onclick = () => {
      if (errorHandler && errors.length > 0) errorHandler(errors[0].key);
    };
    validationEl.onkeydown = (e) => {
      if ((e.key === "Enter" || e.key === " ") && errorHandler && errors.length > 0) {
        e.preventDefault();
        errorHandler(errors[0].key);
      }
    };
  }

  function setTelemetry(t: Telemetry | null): void {
    if (!t) {
      telemetryEl.textContent = "";
      return;
    }
    telemetryEl.textContent = `Gen: ${Math.round(t.generationTimeMs)} ms | Tris: ${t.triangleCount} | Tex: ${t.textureCount}`;
  }

  function setMessage(msg: string | null): void {
    messageEl.textContent = msg ?? "";
  }

  let rebuildState: RebuildState = "idle";

  function setGenerating(on: boolean): void {
    // Thin alias over the rebuild-state surface so existing callers (the
    // non-edit generation safety net) keep working unchanged (spec 2C.2).
    setRebuildState(on ? "busy" : "idle");
  }

  function setRebuildState(next: RebuildState): void {
    rebuildState = next;
    if (next === "idle") {
      generatingEl.hidden = true;
      generatingEl.textContent = PANEL_STRINGS.generating;
    } else if (next === "long") {
      generatingEl.hidden = false;
      generatingEl.textContent = PANEL_STRINGS.rebuildingLong;
    } else {
      generatingEl.hidden = false;
      generatingEl.textContent = PANEL_STRINGS.rebuilding;
    }
    generatingEl.dataset.rebuildState = next;
  }

  function getRebuildState(): RebuildState {
    return rebuildState;
  }

  return {
    root,
    setValidationSummary,
    setTelemetry,
    setMessage,
    setGenerating,
    setRebuildState,
    getRebuildState,
    get onValidationErrorClick() { return errorHandler; },
    set onValidationErrorClick(fn: ((key: string) => void) | null) { errorHandler = fn; },
  };
}
