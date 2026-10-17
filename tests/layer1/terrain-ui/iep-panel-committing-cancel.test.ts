/**
 * IEP Phase-2 blocker fix (Sarah cert, docs/verdict-iep-phase2-cert.md).
 *
 * Spec §2G / §6.4 make IEP-AC-04b a *required, load-bearing* assertion: the
 * committing-window Cancel revert must be MEASURED, not hidden. The prior Phase-2
 * suite only checked the Cancel button was hit-testable during the committing
 * window and then let the commit complete; it never clicked Cancel INSIDE the
 * window and never asserted the second setParams / generation-complete delta==2 /
 * commitRebuildCount delta==2.
 *
 * This file is self-contained (no edits to the existing Phase-1/2 test files) so
 * the blocker fix is isolated and reviewable:
 *
 *   IEP-AC-04b — forced-delay binding withholds the FIRST commit's
 *   generation-complete so the panel stays in the Committing window; click Cancel
 *   INSIDE that window and assert the honest revert:
 *     (a) a SECOND setParams reverting to committed fires,
 *     (b) getParams() == pre-edit committed,
 *     (c) the slider display reverts to committed,
 *     (d) generation-complete delta == 2 AND commitRebuildCount delta == 2 are
 *         MEASURED (not hidden) — commitRebuildCount is measured on a real
 *         headless renderer wired 1:1 to the generation-complete event, exactly
 *         the production mapping (terrain-renderer.ts:1032 maps generation-
 *         complete -> rebuildFromSnapshot, which bumps commitRebuildCount),
 *     (e) previewRebuildCount stays unmoved on the commit/revert path.
 *
 *   IEP-AC-09 (preview trace) — while a live preview runs across a hold-drag, the
 *   COMMIT-path busy indicator stays hidden (idle) and no setParams fires. The
 *   companion renderer gates (iep-preview-scratch AC-05 / latest-value-wins) prove
 *   previewRebuildCount DOES move on that same live path; together they are the
 *   "indicator stays hidden while previewRebuildCount moves" trace: a preview
 *   moves a preview-only counter, never the commit indicator or commit counters.
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

/**
 * Binding that models an ASYNC engine: setParams emits generation-started and,
 * when the hold flag is set, WITHHOLDS generation-complete (a later releaseHeld()
 * lands it). This is how we park the panel in the Committing window so a Cancel
 * clicked inside it exercises the required revert path.
 */
function delayBinding(initial: Record<string, unknown> = { elevation: 5 }) {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0, generationStarted: 0, generationComplete: 0 };
  let holdNext = false;
  let pendingCompletes = 0;
  const binding: ApiBinding & {
    calls: string[];
    counts: typeof counts;
    setHold(v: boolean): void;
    releaseHeld(): void;
  } = {
    calls,
    counts,
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

/** Synchronous engine binding (emits start+complete inside setParams). */
function syncBinding(initial: Record<string, unknown> = { elevation: 5 }) {
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

/** Seam recorder: logs the ordered method calls the controller invokes. */
function recordingSeam() {
  const log: string[] = [];
  return {
    log,
    begin: () => { log.push("begin"); },
    setLiveValue: (patch: Record<string, unknown>) => { log.push("setLiveValue:" + JSON.stringify(patch)); },
    endCommit: () => { log.push("endCommit"); },
    cancel: () => { log.push("cancel"); },
    dispose: () => { log.push("dispose"); },
  };
}

function panelDef(binding: ApiBinding, seam?: ReturnType<typeof recordingSeam>): PanelDef {
  return {
    title: "IEP Panel",
    sections: [{ id: "main", label: "Main" }],
    controls: [
      { key: "elevation", label: "Elevation", type: "slider", section: "main", order: 1, min: 0, max: 10, step: 0.1, default: 5, regenerates: true },
    ],
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

function slider(handle: PanelHandle): HTMLInputElement {
  return handle.root.querySelector<HTMLInputElement>('input[data-control-key="elevation"]')!;
}

function dragSweep(el: HTMLInputElement, values: string[]): void {
  for (const v of values) { el.value = v; fireChange(el, "input"); }
}

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 128, clientHeight: 128, width: 128, height: 128, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 128 }),
  } as unknown as HTMLCanvasElement;
}

test("IEP-AC-04b: committing-window Cancel fires a SECOND setParams revert; generation-complete delta==2 AND commitRebuildCount delta==2 measured; previewRebuildCount unmoved", () => {
  const binding = delayBinding({ elevation: 5 });

  // Real headless renderer wired 1:1 to generation-complete -> rebuildFromSnapshot
  // (the production mapping, terrain-renderer.ts:1032). This is the honest way to
  // MEASURE commitRebuildCount: each landed commit is a real counter bump, exactly
  // like a mounted renderer, without a GPU.
  const t = createTerrainLayer({ worldSize: { vertices: 128, meters: 128 } });
  t.setParams({ biome: "alpine", seed: 1337, elevation: 5 });
  t.generate();
  const renderer = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  const stats = () => (renderer as unknown as { rebuildStats: () => Record<string, number> }).rebuildStats();
  const rebuild = () => (renderer as unknown as { rebuildFromSnapshot: () => void }).rebuildFromSnapshot();
  const detachRenderer = binding.on("generation-complete", () => rebuild());

  const { handle } = mount(panelDef(binding));
  const el = slider(handle);
  const genEl = handle.root.querySelector<HTMLElement>(".panel-status__generating")!;
  const spBefore = binding.counts.setParams;
  const gcBefore = binding.counts.generationComplete;
  const commitBefore = stats().commitRebuildCount;
  const previewBefore = stats().previewRebuildCount;

  // Enter the Committing window: release-commit with the completion withheld.
  binding.setHold(true);
  dragSweep(el, ["6", "7", "9"]);
  fireChange(el, "change"); // release stages the batch
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // OK -> single commit; start emitted, complete withheld
  assert.equal(handle.root.dataset.editState, "committing", "in the Committing window");
  assert.equal(genEl.dataset.rebuildState, "busy", "busy indicator while committing");
  const cancelBtn = handle.root.querySelector<HTMLButtonElement>('button[data-role="cancel-edit"]')!;
  assert.equal(cancelBtn.hidden, false, "Cancel hit-testable inside the committing window");
  assert.equal(binding.counts.setParams - spBefore, 1, "exactly one setParams so far (the commit)");

  // Cancel INSIDE the committing window.
  click(cancelBtn);

  // (a) a SECOND setParams reverting to committed fires.
  assert.equal(binding.counts.setParams - spBefore, 2, "two setParams: commit + revert");
  assert.ok(binding.calls.includes('setParams:{"elevation":5}'), "revert setParams to the committed value fired");
  // (b) getParams() == pre-edit committed.
  assert.equal(binding.getParams().elevation, 5, "getParams reverted to pre-edit committed");
  // (c) slider display reverted to committed.
  assert.equal(Number(el.value), 5, "slider display reverted to committed");
  assert.equal(handle.root.dataset.editState, "committed", "state committed after the revert");

  // Release the withheld first completion so BOTH commits land generation-complete.
  binding.releaseHeld();

  // (d) MEASURED, not hidden: generation-complete delta == 2 and commitRebuildCount
  // delta == 2 (one rebuildFromSnapshot per landed commit, via the real renderer).
  assert.equal(binding.counts.generationComplete - gcBefore, 2, "generation-complete delta == 2");
  assert.equal(stats().commitRebuildCount - commitBefore, 2, "commitRebuildCount delta == 2 (measured via real renderer)");
  // (e) preview counter unmoved on the commit/revert path.
  assert.equal(stats().previewRebuildCount - previewBefore, 0, "previewRebuildCount unmoved on the revert");

  detachRenderer();
  handle.unmount();
});

test("IEP-AC-09 (preview trace): busy indicator stays hidden across a live drag while the preview seam is driven (no commit)", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam));
  const el = slider(handle);
  const genEl = handle.root.querySelector<HTMLElement>(".panel-status__generating")!;
  assert.equal(genEl.dataset.rebuildState, "idle", "indicator idle at rest");

  dragSweep(el, ["3", "4", "5", "6", "7", "8"]); // live preview updates; no release
  assert.equal(genEl.dataset.rebuildState, "idle", "indicator stays hidden while the preview is live (no commit yet)");
  assert.ok(seam.log.some((l) => l.startsWith("setLiveValue")), "preview seam driven during the drag (the previewRebuildCount path)");
  assert.equal(binding.counts.setParams, 0, "no commit during preview (commit indicator/counter never move on the preview path)");

  handle.unmount();
});
