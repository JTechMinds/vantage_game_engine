/**
 * ControlRenderer — renders a single control from a ControlDef.
 *
 * Vanilla DOM, framework-generic. Knows nothing about any specific engine
 * layer; it only reads the declarative ControlDef schema and emits
 * (key, value) change events through the callback it was given.
 *
 * Keyboard accessibility (spec §2.9): sliders respond to Arrow keys (±step),
 * PageUp/PageDown (±10×step), Home/End (min/max); toggles respond to
 * Space/Enter. These are handled explicitly (with preventDefault) so the
 * behavior is deterministic in tests and browsers alike. Selects keep native
 * arrow/type-ahead behavior. All controls expose aria-label from the schema
 * `label`; errors wire aria-invalid + aria-describedby.
 */

import type { ControlDef, ValidationError } from "./types.ts";

export type ControlChangeHandler = (
  key: string,
  value: string | number | boolean,
  opts?: { immediate?: boolean; phase?: "start" | "live" | "end" },
) => void;

export interface ControlView {
  root: HTMLElement;
  input: HTMLElement;
  setValue: (value: unknown) => void;
  setError: (error: ValidationError | null) => void;
  setVisible: (visible: boolean) => void;
  setDisabled: (disabled: boolean) => void;
}

function coerceNumeric(raw: string, def: ControlDef): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : ((def.default as number) ?? 0);
}

/** Round to the decimal precision implied by the control's step. */
function roundToStep(value: number, step: number, min: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  const aligned = min + Math.round((value - min) / step) * step;
  return Number(aligned.toFixed(decimals));
}

export function renderControl(
  def: ControlDef,
  onChange: ControlChangeHandler,
): ControlView {
  const row = document.createElement("div");
  row.className = "panel-control";
  row.dataset.key = def.key;

  const label = document.createElement("label");
  label.className = "panel-control__label";
  label.textContent = def.label + (def.unit ? ` (${def.unit})` : "");
  if (def.tooltip) label.title = def.tooltip;

  const errorEl = document.createElement("div");
  errorEl.className = "panel-control__error";
  errorEl.setAttribute("role", "alert");
  errorEl.hidden = true;
  const errorId = `panel-err-${def.key}`;
  errorEl.id = errorId;

  let input: HTMLElement;

  switch (def.type) {
    case "slider": {
      const el = document.createElement("input");
      el.type = "range";
      const min = def.min ?? 0;
      const max = def.max ?? 100;
      const step = def.step ?? 1;
      el.min = String(min);
      el.max = String(max);
      el.step = String(step);
      el.value = String(def.default ?? min);
      el.className = "panel-control__slider";
      el.addEventListener("input", () => {
        // Live drag. A regenerates slider emits the live phase so the binding
        // records the value WITHOUT committing (IEP spec 2A/4.1); appearance-
        // only controls keep their immediate live behavior (no opts).
        if (def.regenerates === true) {
          onChange(def.key, coerceNumeric(el.value, def), { phase: "live" });
        } else {
          onChange(def.key, coerceNumeric(el.value, def));
        }
      });
      el.addEventListener("change", () => {
        // Release: force-apply the final value immediately.
        onChange(def.key, coerceNumeric(el.value, def), { immediate: true });
      });
      // Explicit keyboard handling (deterministic in jsdom + browsers).
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        const current = coerceNumeric(el.value, def);
        let next: number | null = null;
        switch (e.key) {
          case "ArrowRight":
          case "ArrowUp":
            next = current + step;
            break;
          case "ArrowLeft":
          case "ArrowDown":
            next = current - step;
            break;
          case "PageUp":
            next = current + 10 * step;
            break;
          case "PageDown":
            next = current - 10 * step;
            break;
          case "Home":
            next = min;
            break;
          case "End":
            next = max;
            break;
        }
        if (next === null) return;
        e.preventDefault(); // suppress native handling; we apply ourselves
        const clamped = Math.min(max, Math.max(min, roundToStep(next, step, min)));
        el.value = String(clamped);
        if (def.regenerates === true) {
          // Keyboard sequence: live phase per step; idle-timeout commits once.
          onChange(def.key, clamped, { phase: "live" });
        } else {
          onChange(def.key, clamped, { immediate: true });
        }
      });
      input = el;
      break;
    }
    case "number": {
      const el = document.createElement("input");
      el.type = "number";
      if (def.min !== undefined) el.min = String(def.min);
      if (def.max !== undefined) el.max = String(def.max);
      if (def.step !== undefined) el.step = String(def.step);
      el.value = String(def.default ?? "");
      el.className = "panel-control__number";
      el.addEventListener("change", () => {
        onChange(def.key, coerceNumeric(el.value, def), { immediate: true });
      });
      input = el;
      break;
    }
    case "select": {
      const el = document.createElement("select");
      el.className = "panel-control__select";
      for (const opt of def.options ?? []) {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = opt.label;
        el.appendChild(o);
      }
      el.value = String(def.default ?? "");
      el.addEventListener("change", () => {
        const match = (def.options ?? []).find((o) => String(o.value) === el.value);
        onChange(def.key, match ? match.value : el.value, { immediate: true });
      });
      input = el;
      break;
    }
    case "toggle": {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.checked = def.defaultBool === true;
      el.className = "panel-control__toggle";
      el.addEventListener("change", () => {
        onChange(def.key, el.checked, { immediate: true });
      });
      // Deterministic Space/Enter across environments; preventDefault keeps
      // the native toggle from double-firing in real browsers.
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          el.checked = !el.checked;
          onChange(def.key, el.checked, { immediate: true });
        }
      });
      input = el;
      break;
    }
    case "text": {
      const el = document.createElement("input");
      el.type = "text";
      el.value = String(def.default ?? "");
      el.className = "panel-control__text";
      el.addEventListener("change", () => {
        onChange(def.key, el.value, { immediate: true });
      });
      input = el;
      break;
    }
    case "button": {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "panel-control__button";
      el.addEventListener("click", () => onChange(def.key, true, { immediate: true }));
      input = el;
      break;
    }
    default: {
      const el = document.createElement("span");
      el.textContent = `unknown control: ${def.type}`;
      input = el;
    }
  }

  input.setAttribute("aria-label", def.label);
  input.dataset.controlKey = def.key;

  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(errorEl);

  function setValue(value: unknown): void {
    if (def.type === "toggle") {
      (input as HTMLInputElement).checked = value === true;
    } else if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
      if (String(input.value) !== String(value ?? "")) input.value = String(value ?? "");
    } else if (input instanceof HTMLButtonElement) {
      input.textContent = String(value ?? "");
    }
  }

  function setError(error: ValidationError | null): void {
    if (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
    } else {
      errorEl.textContent = "";
      errorEl.hidden = true;
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }

  function setVisible(visible: boolean): void {
    row.hidden = !visible;
  }

  function setDisabled(disabled: boolean): void {
    (input as HTMLInputElement).disabled = disabled;
  }

  return { root: row, input, setValue, setError, setVisible, setDisabled };
}
