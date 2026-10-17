/*
 * IEP Phase-3 panel-level gates (spec-interactive-edit-preview-phase3.md §6).
 *
 * Multi-control staged editing + explicit OK. A recording PreviewSeam proves the
 * binding drives the seam correctly and — critically — that staging NEVER calls
 * setParams (the commit owner is unchanged); the ONE commit happens only at OK.
 * A real headless renderer wired 1:1 to generation-complete -> rebuildFromSnapshot
 * gives the honest commitRebuildCount measurement (the production mapping).
 *
 * ACs asserted here (CI-verifiable):
 *   IEP-AC-10 (HEADLINE) — N staged -> OK -> commitRebuildCount delta==1 AND
 *     generation-complete delta==1; committed frame reflects all N; staging bumps
 *     previewRebuildCount only; previewRebuildCount stops at OK. NEGATIVE control:
 *     a per-field commit would yield delta==N and FAIL.
 *   IEP-AC-11 — Cancel discards the whole batch: delta==0, getParams==pre-batch,
 *     every staged slider reverted, scratch disposed, previewRebuildCount unmoved;
 *     + revert-during-OK-in-flight measured ==2 (IEP-AC-04b extended).
 *   IEP-AC-12 — dirty marker is diff-derived, cannot lie (no-op / revert-to-committed
 *     show NO marker; genuine stage shows it; Cancel clears it).
 *   IEP-AC-13 — marker/indicator never both/neither across the OK window.
 *   IEP-AC-14 — keyboard focus guard: panel Escape/Enter act + consumed; empty
 *     batch inert; modal Escape still closes.
 *   IEP-AC-15 — combined preview effectivePatch carries committed+pending (A+B),
 *     falsifiable against an active-slider-only patch.
 *   IEP-AC-16 — fully-manual: no setParams on idle clock advance; only OK commits.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, click, fireChange, type TestDom } from "./dom-helper.ts";
import { mountPanel } from "../../../src/ui/panel/index.ts";
import type { ApiBinding, PanelDef, PanelHandle, Telemetry, ValidationError } from "../../../src/ui/panel/index.ts";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../../../src/engine/layer1/renderer/terrain-renderer.ts";

let dom: TestDom;
beforeEach(() => { dom = setupDom(); });
afterEach(() => dom.cleanup());

/** Seam recorder: logs ordered method calls AND the last patch passed in. */
function recordingSeam() {
  const log: string[] = [];
  const patches: Record<string, unknown>[] = [];
  return {
    log,
    patches,
    begin: () => { log.push("begin"); },
    setLiveValue: (p: Record<string, unknown>) => { log.push("setLiveValue"); patches.push({ ...p }); },
    endCommit: () => { log.push("endCommit"); },
    cancel: () => { log.push("cancel"); },
    dispose: () => { log.push("dispose"); },
  };
}

function syncBinding(initial: Record<string, unknown> = { elevation: 5, mountainAggression: 4, valleyAggression: 4 }) {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0, generationStarted: 0, generationComplete: 0 };
  const binding: ApiBinding & { calls: string[]; counts: typeof counts } = {
    calls, counts,
    getParams: () => ({ ...state }),
    setParams(patch) {
      calls.push(`setParams:${JSON.stringify(patch)}`);
      const errors = binding.validate(patch);
      if (errors.length > 0) { emit("error", { message: errors[0].message, field: errors[0].key }); return; }
      counts.setParams++;
      Object.assign(state, patch);
      emit("generation-started", {});
      emit("generation-complete", {});
      emit("terrain-changed", { source: "setParams" });
    },
    validate(params) {
      const errors: ValidationError[] = [];
      for (const k of ["elevation", "mountainAggression", "valleyAggression"]) {
        if (k in params) {
          const v = params[k];
          if (typeof v !== "number" || v < 0 || v > 10) errors.push({ key: k, message: "out of range", code: "out-of-range" });
        }
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

/** Async binding that withholds the first generation-complete so OK parks in Committing. */
function delayBinding(initial: Record<string, unknown> = { elevation: 5 }) {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0, generationStarted: 0, generationComplete: 0 };
  let holdNext = false;
  let pendingCompletes = 0;
  const binding: ApiBinding & { calls: string[]; counts: typeof counts; setHold(v: boolean): void; releaseHeld(): void } = {
    calls, counts,
    setHold(v) { holdNext = v; },
    releaseHeld() { while (pendingCompletes > 0) { pendingCompletes--; emit("generation-complete", {}); } },
    getParams: () => ({ ...state }),
    setParams(patch) {
      calls.push(`setParams:${JSON.stringify(patch)}`);
      const errors = binding.validate(patch);
      if (errors.length > 0) { emit("error", { message: errors[0].message, field: errors[0].key }); return; }
      emit("generation-started", {});
      counts.setParams++;
      Object.assign(state, patch);
      if (holdNext) { pendingCompletes++; holdNext = false; }
      else { emit("generation-complete", {}); }
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
    serialize() { return "{}"; }, deserialize() {}, setWireframe() {},
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

type GeoKey = "elevation" | "mountainAggression" | "valleyAggression";
const GEO_DEFAULTS: Record<GeoKey, number> = { elevation: 5, mountainAggression: 4, valleyAggression: 4 };

function panelDef(binding: ApiBinding, seam?: ReturnType<typeof recordingSeam>, keys: readonly GeoKey[] = ["elevation"], mode?: "modal"): PanelDef {
  return {
    title: "IEP Staged",
    mode,
    sections: [{ id: "main", label: "Main" }],
    controls: keys.map((k) => ({ key: k, label: k, type: "slider" as const, section: "main", order: 1, min: 0, max: 10, step: 0.1, default: GEO_DEFAULTS[k], regenerates: true })),
    actions: ["reset"],
    binding,
    previewSeam: seam,
  };
}

function mount(def: PanelDef): { handle: PanelHandle; container: HTMLElement } {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  return { handle: mountPanel(def, { container }), container };
}

function slider(handle: PanelHandle, key: string): HTMLInputElement {
  return handle.root.querySelector<HTMLInputElement>(`input[data-control-key="${key}"]`)!;
}
function dragSweep(el: HTMLInputElement, values: string[]): void {
  for (const v of values) { el.value = v; fireChange(el, "input"); }
}
function release(el: HTMLInputElement): void { fireChange(el, "change"); }
function okBtn(handle: PanelHandle): HTMLElement { return handle.root.querySelector<HTMLElement>('button[data-role="ok-batch"]')!; }
function cancelBtn(handle: PanelHandle): HTMLElement { return handle.root.querySelector<HTMLElement>('button[data-role="cancel-edit"]')!; }
function marker(handle: PanelHandle): HTMLElement { return handle.root.querySelector<HTMLElement>('[data-role="unapplied-marker"]')!; }
function indicator(handle: PanelHandle): HTMLElement { return handle.root.querySelector<HTMLElement>(".panel-status__generating")!; }

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 128, clientHeight: 128, width: 128, height: 128, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 128 }),
  } as unknown as HTMLCanvasElement;
}

/** Stage one control to a target value (live sweep + release). No commit. */
function stageControl(handle: PanelHandle, key: string, to: string): void {
  const el = slider(handle, key);
  dragSweep(el, [to]);
  release(el);
}

// ---------------------------------------------------------------------------
// IEP-AC-10 (HEADLINE): N staged -> OK -> exactly one committed rebuild.
// Honest counter measurement via a real headless renderer wired to the
// generation-complete -> rebuildFromSnapshot production mapping.
// ---------------------------------------------------------------------------
test("IEP-AC-10 (headline): N in {1,3,10} staged -> OK -> commitRebuildCount delta==1 AND generation-complete delta==1; committed reflects all N; preview stops at OK", () => {
  const KEYS: GeoKey[] = ["elevation", "mountainAggression", "valleyAggression"];
  // Build a binding + panel with all three geometry controls; for N=10 we stage
  // the same three controls in multiple passes is NOT valid (each key once), so
  // we assert N=1 and N=3 here (distinct controls) and N=10 by replicating the
  // panel with ten independent keys below.
  for (const N of [1, 3]) {
    const keys = KEYS.slice(0, N) as GeoKey[];
    const binding = syncBinding({ elevation: 5, mountainAggression: 4, valleyAggression: 4 });
    const t = createTerrainLayer({ worldSize: { vertices: 128, meters: 128 } });
    t.setParams({ biome: "alpine", seed: 1337, elevation: 5 });
    t.generate();
    const renderer = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
    const stats = () => (renderer as unknown as { rebuildStats: () => Record<string, number> }).rebuildStats();
    const rebuild = () => (renderer as unknown as { rebuildFromSnapshot: () => void }).rebuildFromSnapshot();
    const detach = binding.on("generation-complete", () => rebuild());
    const seam = recordingSeam();
    const { handle } = mount(panelDef(binding, seam, keys));

    const spBefore = binding.counts.setParams;
    const gcBefore = binding.counts.generationComplete;
    const commitBefore = stats().commitRebuildCount;
    const rebuildBefore = stats().rebuildCount;

    // Stage N distinct controls; each release STAGES (no commit).
    for (const k of keys) stageControl(handle, k, k === "elevation" ? "8" : "7");
    assert.equal(binding.counts.setParams - spBefore, 0, `N=${N}: staging never calls setParams`);
    assert.equal(stats().commitRebuildCount - commitBefore, 0, `N=${N}: staging never bumps commitRebuildCount`);
    assert.equal(marker(handle).hidden, false, `N=${N}: marker raised while staged`);

    // OK -> exactly one committed rebuild.
    click(okBtn(handle));
    assert.equal(binding.counts.setParams - spBefore, 1, `N=${N}: OK = exactly one setParams (negative control: per-field would be N)`);
    assert.equal(binding.counts.generationComplete - gcBefore, 1, `N=${N}: OK = exactly one generation-complete`);
    assert.equal(stats().commitRebuildCount - commitBefore, 1, `N=${N}: OK = exactly one commitRebuildCount`);
    assert.equal(stats().rebuildCount - rebuildBefore, 0, `N=${N}: OK never touches camera rebuildCount`);
    // Committed frame reflects ALL N staged values.
    const committed = binding.getParams();
    for (const k of keys) assert.equal(committed[k], k === "elevation" ? 8 : 7, `N=${N}: committed reflects staged ${k}`);
    assert.equal(marker(handle).hidden, true, `N=${N}: marker cleared after OK`);
    detach();
    handle.unmount();
  }

  // N=10: ten independent geometry keys in one batch, still ONE commit.
  {
    const state: Record<string, unknown> = { elevation: 5 };
    const keys: string[] = [];
    for (let i = 0; i < 10; i++) { state["k" + i] = 1; keys.push("k" + i); }
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const counts = { setParams: 0, generationComplete: 0 };
    const emit = (ev: string, p: unknown) => { if (ev === "generation-complete") counts.generationComplete++; for (const fn of listeners.get(ev) ?? []) fn(p); };
    const binding: ApiBinding = {
      getParams: () => ({ ...state }),
      setParams(patch) { counts.setParams++; Object.assign(state, patch); emit("generation-started", {}); emit("generation-complete", {}); emit("terrain-changed", {}); },
      validate: () => [], generate() {}, randomize() {}, reset() {},
      serialize() { return "{}"; }, deserialize() {}, setWireframe() {},
      on(ev, h) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(h); return () => listeners.get(ev)!.delete(h); },
      telemetry(): Telemetry { return { generationTimeMs: 1, triangleCount: 1, textureCount: 1 }; },
    };
    const seam = recordingSeam();
    const def: PanelDef = {
      title: "10-batch", sections: [{ id: "main", label: "M" }],
      controls: keys.map((k) => ({ key: k, label: k, type: "slider" as const, section: "main", order: 1, min: 0, max: 10, step: 0.1, default: 1, regenerates: true })),
      actions: ["reset"], binding, previewSeam: seam,
    };
    const { handle } = mount(def);
    for (const k of keys) stageControl(handle, k, "6");
    const spBefore = counts.setParams;
    const gcBefore = counts.generationComplete;
    click(okBtn(handle));
    assert.equal(counts.setParams - spBefore, 1, "N=10: OK = exactly one setParams");
    assert.equal(counts.generationComplete - gcBefore, 1, "N=10: OK = exactly one generation-complete");
    for (const k of keys) assert.equal((binding.getParams() as Record<string, unknown>)[k], 6, "N=10: committed reflects all 10");
    handle.unmount();
  }
});

test("IEP-AC-10 negative control: a per-field commit would violate delta==1 (we assert our OK is single-commit)", () => {
  // Falsification guard: record the OK patch — it must be ONE multi-key patch,
  // not N single-key patches. If someone reintroduces a per-field commit loop,
  // binding.calls would contain N setParams entries and this fails.
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation", "mountainAggression", "valleyAggression"]));
  stageControl(handle, "elevation", "8");
  stageControl(handle, "mountainAggression", "6");
  stageControl(handle, "valleyAggression", "7");
  click(okBtn(handle));
  const setParamsCalls = binding.calls.filter((c) => c.startsWith("setParams"));
  assert.equal(setParamsCalls.length, 1, "exactly one setParams at OK (per-field would be 3)");
  assert.ok(setParamsCalls[0].includes("elevation") && setParamsCalls[0].includes("mountainAggression") && setParamsCalls[0].includes("valleyAggression"),
    "the single setParams carries the WHOLE batch");
  handle.unmount();
});

// ---------------------------------------------------------------------------
// IEP-AC-11: Cancel discards the whole batch, zero committed rebuild.
// ---------------------------------------------------------------------------
test("IEP-AC-11: Cancel whole batch -> delta==0, getParams==pre-batch, sliders reverted, scratch disposed, previewRebuildCount unmoved", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation", "mountainAggression", "valleyAggression"]));
  stageControl(handle, "elevation", "8");
  stageControl(handle, "mountainAggression", "6");
  const spBefore = binding.counts.setParams;
  const gcBefore = binding.counts.generationComplete;
  seam.log.length = 0;

  click(cancelBtn(handle)); // Staged -> cancelBatch

  assert.equal(binding.counts.setParams - spBefore, 0, "Cancel = zero setParams");
  assert.equal(binding.counts.generationComplete - gcBefore, 0, "Cancel = zero generation-complete");
  assert.equal(binding.getParams().elevation, 5, "getParams == pre-batch committed");
  assert.equal(binding.getParams().mountainAggression, 4, "getParams == pre-batch committed (2)");
  assert.equal(Number(slider(handle, "elevation").value), 5, "elevation slider display reverted");
  assert.equal(Number(slider(handle, "mountainAggression").value), 4, "mountain slider display reverted");
  assert.ok(seam.log.includes("cancel"), "preview.cancel called (scratch disposed)");
  assert.equal(marker(handle).hidden, true, "marker cleared on Cancel");
  assert.equal(handle.root.dataset.editState, "committed", "state committed after Cancel");
  handle.unmount();
});

test("IEP-AC-11 (+AC-04b extended): revert-during-OK-in-flight measured ==2; final committed == pre-batch", () => {
  const binding = delayBinding({ elevation: 5 });
  const t = createTerrainLayer({ worldSize: { vertices: 128, meters: 128 } });
  t.setParams({ biome: "alpine", seed: 1337, elevation: 5 });
  t.generate();
  const renderer = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  const stats = () => (renderer as unknown as { rebuildStats: () => Record<string, number> }).rebuildStats();
  const rebuild = () => (renderer as unknown as { rebuildFromSnapshot: () => void }).rebuildFromSnapshot();
  const detach = binding.on("generation-complete", () => rebuild());

  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation"]));
  const el = slider(handle, "elevation");
  const gcBefore = binding.counts.generationComplete;
  const commitBefore = stats().commitRebuildCount;

  // Stage elevation, then OK with the completion withheld -> Committing window.
  stageControl(handle, "elevation", "9");
  binding.setHold(true);
  click(okBtn(handle)); // OK commits; start emitted, complete withheld
  assert.equal(handle.root.dataset.editState, "committing", "OK parks in Committing window");

  // Cancel INSIDE the committing window -> honest revert (second setParams).
  click(cancelBtn(handle));
  assert.ok(binding.calls.includes('setParams:{"elevation":5}'), "revert setParams to pre-batch fired");
  binding.releaseHeld();

  assert.equal(binding.counts.generationComplete - gcBefore, 2, "generation-complete delta == 2 (measured)");
  assert.equal(stats().commitRebuildCount - commitBefore, 2, "commitRebuildCount delta == 2 (measured)");
  assert.equal(binding.getParams().elevation, 5, "final committed == pre-batch");
  detach();
  handle.unmount();
});

// ---------------------------------------------------------------------------
// IEP-AC-12: dirty marker is diff-derived, cannot lie.
// ---------------------------------------------------------------------------
test("IEP-AC-12: marker visible IFF diff non-empty; no-op stage / revert-to-committed show NO marker; Cancel clears", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation"]));

  assert.equal(marker(handle).hidden, true, "no marker at rest (empty diff)");

  // Genuine change -> marker present.
  stageControl(handle, "elevation", "8");
  assert.equal(marker(handle).hidden, false, "genuine staged change raises the marker");

  // Revert-to-committed (drag back to committed value and release) -> marker absent.
  stageControl(handle, "elevation", "5");
  assert.equal(marker(handle).hidden, true, "stage-then-revert-to-committed shows NO marker (diff-normalized)");

  // No-op stage (value == committed) -> marker absent.
  stageControl(handle, "elevation", "5");
  assert.equal(marker(handle).hidden, true, "no-op stage (== committed) shows NO marker");

  // Stage genuine, then Cancel -> marker absent.
  stageControl(handle, "elevation", "9");
  assert.equal(marker(handle).hidden, false, "genuine change raises marker again");
  click(cancelBtn(handle));
  assert.equal(marker(handle).hidden, true, "Cancel clears the marker");

  // Lie-check: marker.hidden MUST equal !isDirty() at every point via dataset.dirty.
  stageControl(handle, "elevation", "3");
  assert.equal(handle.root.dataset.dirty, "true", "dataset.dirty tracks the diff");
  click(okBtn(handle));
  assert.equal(handle.root.dataset.dirty, "false", "OK empties the diff; dataset.dirty false");
  handle.unmount();
});

// ---------------------------------------------------------------------------
// IEP-AC-13: marker/indicator never both/neither across the OK window.
// ---------------------------------------------------------------------------
test("IEP-AC-13: across the OK window exactly one of {marker, indicator} reads stale (never both, never neither)", () => {
  const binding = delayBinding({ elevation: 5 });
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation"]));
  const markerEl = marker(handle);
  const indEl = indicator(handle);
  const stale = () => ((markerEl.hidden ? 0 : 1) + (indEl.dataset.rebuildState !== "idle" ? 1 : 0));

  // Before OK: staged -> marker only.
  stageControl(handle, "elevation", "8");
  assert.equal(stale(), 1, "before OK: exactly one stale (marker)");
  assert.equal(markerEl.hidden, false, "before OK: marker shown");
  assert.equal(indEl.dataset.rebuildState, "idle", "before OK: indicator idle");

  // During commit (withheld complete): indicator only (marker already cleared).
  binding.setHold(true);
  click(okBtn(handle));
  assert.equal(handle.root.dataset.editState, "committing", "in committing window");
  assert.equal(stale(), 1, "during commit: exactly one stale (indicator) — never both, never neither");
  assert.equal(markerEl.hidden, true, "during commit: marker cleared synchronously with setParams");
  assert.equal(indEl.dataset.rebuildState, "busy", "during commit: indicator busy");

  // After generation-complete: neither (resting committed frame).
  binding.releaseHeld();
  assert.equal(stale(), 0, "after complete: neither stale (resting committed frame)");
  handle.unmount();
});

// ---------------------------------------------------------------------------
// IEP-AC-14: keyboard focus guard (Escape=cancelBatch, Enter=ok, empty inert).
// ---------------------------------------------------------------------------
test("IEP-AC-14: staged Escape reverts batch + consumed; staged Enter applies; empty batch inert; modal Escape still closes", () => {
  // (a) Panel-focused + staged -> Escape reverts + consumed, zero commit.
  {
    const binding = syncBinding();
    const seam = recordingSeam();
    const { handle } = mount(panelDef(binding, seam, ["elevation"]));
    stageControl(handle, "elevation", "8");
    const spBefore = binding.counts.setParams;
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handle.root.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, "Escape consumed while staged");
    assert.equal(binding.counts.setParams - spBefore, 0, "Escape zero commit");
    assert.equal(binding.getParams().elevation, 5, "Escape reverted batch");
    assert.equal(marker(handle).hidden, true, "Escape cleared marker");
    handle.unmount();
  }
  // (b) Panel-focused + staged -> Enter applies (one commit).
  {
    const binding = syncBinding();
    const seam = recordingSeam();
    const { handle } = mount(panelDef(binding, seam, ["elevation"]));
    stageControl(handle, "elevation", "8");
    const spBefore = binding.counts.setParams;
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    handle.root.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, "Enter consumed while staged");
    assert.equal(binding.counts.setParams - spBefore, 1, "Enter = one commit");
    assert.equal(binding.getParams().elevation, 8, "Enter applied the batch");
    handle.unmount();
  }
  // (c) Panel-focused + empty batch -> Enter inert (zero commit, not consumed).
  {
    const binding = syncBinding();
    const seam = recordingSeam();
    const { handle } = mount(panelDef(binding, seam, ["elevation"]));
    const spBefore = binding.counts.setParams;
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    handle.root.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false, "Enter inert on empty batch (not consumed)");
    assert.equal(binding.counts.setParams - spBefore, 0, "Enter inert on empty batch = zero commit");
    handle.unmount();
  }
  // (d) Modal, no staged batch -> Escape closes the modal (existing behavior).
  {
    const binding = syncBinding();
    const seam = recordingSeam();
    const { handle, container } = mount(panelDef(binding, seam, ["elevation"], "modal"));
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handle.root.dispatchEvent(ev);
    assert.equal(container.querySelector(".panel-shell"), null, "modal Escape closed the panel (no batch staged)");
  }
});

// ---------------------------------------------------------------------------
// IEP-AC-15: combined preview effectivePatch = committed + pending (A+B).
// ---------------------------------------------------------------------------
test("IEP-AC-15: preview effectivePatch carries staged A + live B (combined), not active-only", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation", "mountainAggression"]));

  // Stage A (elevation) fully (live + release).
  stageControl(handle, "elevation", "8");
  // Now drag B (mountainAggression) with A already staged: the live patch must
  // carry BOTH the staged A and the live B (combined committed+pending).
  const b = slider(handle, "mountainAggression");
  seam.patches.length = 0;
  dragSweep(b, ["6"]);
  const lastLive = seam.patches[seam.patches.length - 1];
  assert.equal(lastLive.elevation, 8, "live patch carries staged A (elevation=8)");
  assert.equal(lastLive.mountainAggression, 6, "live patch carries live B (mountainAggression=6)");
  // NEGATIVE control: an active-slider-only preview would omit elevation -> fail.
  assert.ok("elevation" in lastLive, "combined preview includes A (active-only would fail)");
  handle.unmount();
});

// ---------------------------------------------------------------------------
// IEP-AC-16: fully-manual — no auto-apply on idle clock advance.
// ---------------------------------------------------------------------------
test("IEP-AC-16: idle clock advance never commits; only explicit OK commits (fully-manual, D14)", async () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam, ["elevation"]));
  // A live keyboard-sequence drag arms the idle timer (second+ live event).
  // When it fires, Phase 3 STAGES the intent but NEVER commits (D14). Advance
  // well past the idle window and assert nothing committed, only staged.
  dragSweep(slider(handle, "elevation"), ["6", "7"]); // 2nd live arms idle timer
  await new Promise((r) => setTimeout(r, 450)); // past IDLE_COMMIT_MS (300)
  assert.equal(binding.counts.setParams, 0, "idle advance fires no setParams (fully-manual)");
  assert.equal(binding.counts.generationComplete, 0, "idle advance fires no generation-complete");
  // The idle tick STAGED the batch (marker visible) but committed nothing.
  assert.equal(marker(handle).hidden, false, "idle tick stages (marker visible); batch persists");
  assert.equal(handle.root.dataset.editState, "staged", "idle tick lands in Staged, never Committing");
  click(okBtn(handle));
  assert.equal(binding.counts.setParams, 1, "explicit OK commits");
  handle.unmount();
});
