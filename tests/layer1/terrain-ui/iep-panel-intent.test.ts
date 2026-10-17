/**
 * IEP Phase-1 panel-level gates (spec-interactive-edit-preview-phase1.md §6).
 *
 * Runs under node --test with a jsdom DOM. The commit-signal here is the
 * binding's setParams + generation-complete count; the renderer counter test
 * (iep-commit-counter.test.ts) proves these are 1:1 with commitRebuildCount on
 * the real engine, so counting them against a synchronous event-emitting
 * binding is honest and fast (no full mesh build per event).
 *
 * ACs asserted: IEP-AC-01 (in-drag flatness), IEP-AC-02 (one commit per intent
 * for N=5/25/100 + keyboard), IEP-AC-04 (cancel => zero rebuild + revert, both
 * Escape and Cancel-control paths), IEP-AC-09/G6 (indicator visible-state
 * timeline brackets generation-started->generation-complete, escalation via
 * forced delay, Cancel hit-testable during commit, event-only), and the
 * IEP-AC-03 CI proxy (no full-regen call on the drag path).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, createMemoryStorage, click, pressKey, fireChange, type TestDom } from "./dom-helper.ts";
import { mountPanel } from "../../../src/ui/panel/index.ts";
import type { ApiBinding, PanelDef, PanelHandle, Telemetry, ValidationError } from "../../../src/ui/panel/index.ts";

let dom: TestDom;
beforeEach(() => { dom = setupDom(); });
afterEach(() => dom.cleanup());

/**
 * Binding that models the M-T1 synchronous engine: setParams emits
 * generation-started, applies, then generation-complete in the same call.
 * Tracks call counts so the ACs can assert deltas without a real mesh build.
 */
function syncBinding(initial: Record<string, unknown> = { elevation: 5 }) {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0, generationStarted: 0, generationComplete: 0 };
  const binding: ApiBinding & { calls: string[]; state: Record<string, unknown>; counts: typeof counts } = {
    calls, state, counts,
    getParams: () => ({ ...state }),
    setParams(patch) {
      calls.push(`setParams:${JSON.stringify(patch)}`);
      const errors = binding.validate(patch);
      if (errors.length > 0) { emit("error", { message: errors[0].message, field: errors[0].key }); return; }
      emit("generation-started", {});
      counts.setParams++;
      Object.assign(state, patch);
      emit("generation-complete", {});
      emit("terrain-changed", { source: "setParams" });
    },
    validate(params) {
      const errors: ValidationError[] = [];
      if ("elevation" in params && (typeof params.elevation !== "number" || params.elevation < 0 || params.elevation > 10)) {
        errors.push({ key: "elevation", message: "out of range", code: "out-of-range" });
      }
      return errors;
    },
    generate() {}, randomize() {}, reset() {},
    serialize() { return JSON.stringify({ schemaVersion: "1.0.0", parameters: { ...state } }); },
    deserialize() {}, setWireframe() {},
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)!.delete(handler);
    },
    telemetry(): Telemetry { return { generationTimeMs: 42, triangleCount: 100, textureCount: 2 }; },
  };
  function emit(event: string, payload: unknown): void {
    if (event === "generation-started") counts.generationStarted++;
    if (event === "generation-complete") counts.generationComplete++;
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }
  return binding;
}

function panelDef(binding: ApiBinding): PanelDef {
  return {
    title: "IEP Panel",
    sections: [{ id: "main", label: "Main" }],
    controls: [
      { key: "elevation", label: "Elevation", type: "slider", section: "main", order: 1, min: 0, max: 10, step: 0.1, default: 5, regenerates: true },
    ],
    actions: ["reset"],
    binding,
  };
}

function mount(def: PanelDef): { handle: PanelHandle; container: HTMLElement } {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  return { handle: mountPanel(def, { container }), container };
}

function slider(handle: PanelHandle): HTMLInputElement {
  return handle.root.querySelector<HTMLInputElement>('input[data-control-key="elevation"]')!;
}

function dragSweep(el: HTMLInputElement, values: string[]): void {
  for (const v of values) { el.value = v; fireChange(el, "input"); }
}

test("IEP-AC-01: in-drag input sweep moves the commit-signal by 0 (no regen per event), including a wait past the old debounce", async () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const before = { ...binding.counts };
  dragSweep(el, ["1", "2", "3", "4", "6"]);
  assert.equal(binding.counts.setParams, before.setParams, "no setParams during drag");
  assert.equal(binding.counts.generationComplete, before.generationComplete, "no generation-complete during drag");
  assert.equal(binding.counts.generationStarted, before.generationStarted, "no generation-started during drag");
  await new Promise((r) => setTimeout(r, 80)); // past the removed 50 ms debounce
  assert.equal(binding.counts.setParams, before.setParams, "still no timer-driven commit");
  handle.unmount();
});

test("IEP-AC-02: one committed rebuild per intent for N=5/25/100 (rapid-drag coalescing)", () => {
  for (const N of [5, 25, 100]) {
    const binding = syncBinding();
    const { handle } = mount(panelDef(binding));
    const el = slider(handle);
    const before = { ...binding.counts };
    const values = Array.from({ length: N }, (_, i) => String(Math.min(10, 1 + i * 0.1)));
    dragSweep(el, values);
    fireChange(el, "change"); // release stages the batch
    click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // OK commits once (same single-commit guarantee)
    assert.equal(binding.counts.setParams - before.setParams, 1, `N=${N}: exactly one commit`);
    assert.equal(binding.counts.generationComplete - before.generationComplete, 1, `N=${N}: one generation-complete`);
    handle.unmount();
  }
});

test("IEP-AC-02: keyboard arrow sequence coalesces to one commit after the idle-timeout", async () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const before = { ...binding.counts };
  for (let i = 0; i < 5; i++) pressKey(el, "ArrowRight");
  assert.equal(binding.counts.setParams, before.setParams, "keyboard steps do not commit mid-sequence");
  await new Promise((r) => setTimeout(r, 400)); // past IDLE_COMMIT_MS (300): idle STAGES (D14)
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // explicit OK commits once
  assert.equal(binding.counts.setParams - before.setParams, 1, "one commit after the idle-timeout");
  assert.equal(binding.counts.generationComplete - before.generationComplete, 1, "one generation-complete");
  handle.unmount();
});

test("IEP-AC-04 (Escape): cancel mid-drag => zero rebuild + revert params and slider display", () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const before = { ...binding.counts };
  dragSweep(el, ["2", "3", "4"]);
  const committedBefore = binding.getParams().elevation;
  // Escape bubbles to the panel root; edit-cancel takes precedence over close.
  handle.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(binding.counts.setParams, before.setParams, "cancel fires no setParams");
  assert.equal(binding.counts.generationComplete, before.generationComplete, "cancel fires no generation-complete");
  assert.equal(binding.getParams().elevation, committedBefore, "getParams unchanged from committed");
  assert.equal(Number(el.value), committedBefore, "slider display reverted to committed");
  assert.equal(handle.root.dataset.editState, "committed", "state back to committed");
  handle.unmount();
});

test("IEP-AC-04 (Cancel control): cancel mid-drag => zero rebuild + revert", () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const before = { ...binding.counts };
  dragSweep(el, ["2", "3", "4"]);
  const cancelBtn = handle.root.querySelector<HTMLButtonElement>('button[data-role="cancel-edit"]')!;
  assert.equal(cancelBtn.hidden, false, "Cancel control visible during drag");
  click(cancelBtn);
  assert.equal(binding.counts.setParams, before.setParams, "cancel fires no setParams");
  assert.equal(binding.counts.generationComplete, before.generationComplete, "cancel fires no generation-complete");
  assert.equal(binding.getParams().elevation, 5, "getParams unchanged");
  assert.equal(Number(el.value), 5, "slider reverted");
  assert.equal(cancelBtn.hidden, true, "Cancel hidden once committed");
  handle.unmount();
});

test("IEP-AC-09/G6: indicator visible-state brackets generation-started -> generation-complete (sync engine)", () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const genEl = handle.root.querySelector<HTMLElement>('.panel-status__generating')!;
  assert.equal(genEl.dataset.rebuildState, "idle", "indicator idle at rest");
  dragSweep(el, ["3", "4", "8"]);
  fireChange(el, "change"); // release stages
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // OK commits; sync engine emits start+complete inside
  // After the committed frame lands, the indicator has cleared (never lingers).
  assert.equal(genEl.dataset.rebuildState, "idle", "indicator cleared after generation-complete");
  assert.equal(handle.root.dataset.editState, "committed", "state committed after commit");
  handle.unmount();
});

test("IEP-AC-09/G6: forced-delay (async) rebuild shows busy, escalates to long, clears on complete; Cancel hit-testable during commit", async () => {
  // Async binding: setParams emits generation-started ONLY; complete is manual.
  const state: Record<string, unknown> = { elevation: 5 };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let completeCount = 0;
  const emit = (ev: string, p: unknown) => { for (const fn of listeners.get(ev) ?? []) fn(p); };
  const binding: ApiBinding = {
    getParams: () => ({ ...state }),
    setParams(patch) { Object.assign(state, patch); emit("generation-started", {}); },
    validate: () => [], generate() {}, randomize() {}, reset() {},
    serialize() { return "{}"; }, deserialize() {}, setWireframe() {},
    on(ev, h) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(h); return () => listeners.get(ev)!.delete(h); },
    telemetry(): Telemetry { return { generationTimeMs: 42, triangleCount: 100, textureCount: 2 }; },
  };
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const genEl = handle.root.querySelector<HTMLElement>('.panel-status__generating')!;
  dragSweep(el, ["6", "7", "9"]);
  fireChange(el, "change"); // release stages
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // OK commits; start emitted, complete withheld => stays committing
  assert.equal(genEl.dataset.rebuildState, "busy", "busy indicator while committing");
  const cancelBtn = handle.root.querySelector<HTMLButtonElement>('button[data-role="cancel-edit"]')!;
  assert.equal(cancelBtn.hidden, false, "Cancel hit-testable during the committing window");
  // Force escalation past the long-op threshold (600 ms) by waiting for the timer.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(genEl.dataset.rebuildState, "long", "escalated to long-operation state past threshold");
  // Now land the committed frame; indicator clears.
  completeCount++;
  emit("generation-complete", {});
  assert.equal(genEl.dataset.rebuildState, "idle", "indicator clears on generation-complete");
  assert.equal(handle.root.dataset.editState, "committed", "state committed after the async complete");
  assert.ok(completeCount === 1);
  handle.unmount();
});

test("IEP-AC-03 CI proxy: no full-regeneration call occurs on the drag path (no ~448 ms stall source)", () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  // A continuous drag of 100 events must produce zero setParams on the layer.
  const values = Array.from({ length: 100 }, (_, i) => String(Math.min(10, 1 + i * 0.05)));
  dragSweep(el, values);
  assert.equal(binding.counts.setParams, 0, "no full-resolution regen call during a continuous drag");
  handle.unmount();
});
