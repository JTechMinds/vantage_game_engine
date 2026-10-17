/*
 * IEP Usability gates (spec-interactive-edit-usability.md §7).
 *
 * Three launch-blocking usability fixes layered on the certified Phase-3
 * staged-edit baseline (iep-phase3-staged @ 55fd6a3):
 *
 *   F1 (preview occlusion): while a staged edit is active the committed
 *     terrain group is HIDDEN so the disposable scratch preview is the only
 *     terrain on screen; it is revealed again when the user returns to a
 *     committed view (immediately on Cancel, at generation-complete on OK).
 *     Driven through the optional PanelDef.committedVisibility handle wired to
 *     the renderer's non-enumerable devOnly setCommittedVisible hook.
 *
 *   F2 (prominent OK/Cancel banner): the marker + OK + Cancel relocate into a
 *     styled banner pinned to the TOP of the scene viewport when the
 *     composition site supplies PanelMountOptions.bannerContainer; OK is
 *     relabeled "Generate new scene". When the container is absent the controls
 *     render in-panel exactly as at baseline (no regression).
 *
 *   F3 (generation feedback): pressing OK mounts a modal "Generating new
 *     scene…" overlay (indeterminate spinner + elapsed timer, never a fabricated
 *     percentage) synchronously with the marker clear, and unmounts it at
 *     generation-complete. No new engine event is emitted.
 *
 * ACs asserted here (CI-verifiable):
 *   IEP-AC-17 — committed visibility follows the staged-edit lifecycle: drag
 *     hides; staged keeps hidden; Cancel-from-hidden reveals with
 *     commitRebuildCount delta 0 and previewRebuildCount unmoved (explicit
 *     visible===true-on-return assert per the task brief); OK reveals; unmount
 *     restores visible (no leaked hidden-committed state). A negative control
 *     proves an appearance-only panel NEVER toggles visibility.
 *   IEP-AC-18 — banner is placed in bannerContainer (not the panel root) with
 *     the locked labels and the paired marker; OK = exactly one commit, Cancel =
 *     zero; empty batch hides the banner / disables OK; the no-container
 *     fallback reproduces the baseline in-panel DOM so existing root-scoped
 *     queries keep passing.
 *   IEP-AC-19 — overlay mounted at ok() and present across the commit,
 *     unmounted at generation-complete; commitRebuildCount delta 1 regardless;
 *     the emitted engine-event SET is unchanged (generation-started /
 *     generation-complete / terrain-changed only — the mechanical guard that F3
 *     adds no engine event); Cancel-during-committing closes the overlay and the
 *     revert path measures 2 completes; unmount removes a stuck overlay.
 *
 * HARNESS DEVIATIONS (recorded per the spec's verification-strategy note that
 * pixel/visibility proof is browser-VIS territory, and §10 engineer judgment):
 *
 *   1. F1 visibility is asserted against a RECORDING committedVisibility handle
 *      (the exact structural contract the composition site wires), not a live
 *      renderer group. An unmounted headless renderer has ctx.terrainGroup===null
 *      (it is created in mount()->buildSceneObjects, which needs a WebGL
 *      context), so the devOnly probe reads null and cannot falsify a boolean
 *      flip in the stubbed-renderer unit tier. The handle proves the controller
 *      calls set(true)/set(false) at the correct lifecycle points; the actual
 *      group.visible flip + real pixels are captured by the VIS harness in a
 *      real http WebGL browser (see evidence/layer1/iep-usability-vis.md).
 *
 *   2. The overlay-lifecycle test instruments setParams with an in-commit DOM
 *      probe (snapshots data-gen-overlay presence while generation-started has
 *      fired but generation-complete has not) instead of the Phase-3 forced-delay
 *      harness. This proves the overlay is mounted BEFORE the commit completes
 *      and unmounted AFTER — the falsifiable lifecycle claim — without depending
 *      on a paint the synchronous engine coalesces (spec §2C: the assertion is
 *      on the DOM lifecycle, not a screenshot pixel).
 */

// Shared harness helpers

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

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

type GeoKey = "elevation" | "mountainAggression" | "valleyAggression";
const GEO_DEFAULTS: Record<GeoKey, number> = { elevation: 5, mountainAggression: 4, valleyAggression: 4 };

interface SyncBinding extends ApiBinding {
  calls: string[];
  counts: { setParams: number; generationStarted: number; generationComplete: number };
  emittedEvents: string[];
}

function syncBinding(initial: Record<string, unknown> = { elevation: 5, mountainAggression: 4, valleyAggression: 4 }): SyncBinding {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0, generationStarted: 0, generationComplete: 0 };
  const emittedEvents: string[] = [];
  const binding: SyncBinding = {
    calls, counts, emittedEvents,
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
    emittedEvents.push(event);
    if (event === "generation-started") counts.generationStarted++;
    if (event === "generation-complete") counts.generationComplete++;
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }
  return binding;
}

/** Async binding that withholds the first generation-complete so OK parks in Committing. */
interface DelayBinding extends ApiBinding {
  calls: string[];
  counts: { setParams: number; generationStarted: number; generationComplete: number };
  emittedEvents: string[];
  setHold(v: boolean): void;
  releaseHeld(): void;
}

function delayBinding(initial: Record<string, unknown> = { elevation: 5 }): DelayBinding {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0, generationStarted: 0, generationComplete: 0 };
  const emittedEvents: string[] = [];
  let holdNext = false;
  let pendingCompletes = 0;
  const binding: DelayBinding = {
    calls, counts, emittedEvents,
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
    emittedEvents.push(event);
    if (event === "generation-started") counts.generationStarted++;
    if (event === "generation-complete") counts.generationComplete++;
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }
  return binding;
}

/* ------------------------------------------------------------------ */
/* Recording seams / handles                                           */
/* ------------------------------------------------------------------ */

function recordingSeam() {
  const log: string[] = [];
  const patches: Record<string, unknown>[] = [];
  return {
    log, patches,
    begin: () => { log.push("begin"); },
    setLiveValue: (p: Record<string, unknown>) => { log.push("setLiveValue"); patches.push({ ...p }); },
    endCommit: () => { log.push("endCommit"); },
    cancel: () => { log.push("cancel"); },
    dispose: () => { log.push("dispose"); },
  };
}

/** F1: recording committed-visibility handle (stands in for the renderer group). */
function recordingVisibility() {
  const log: boolean[] = [];
  return {
    log,
    set(on: boolean) { log.push(on); },
    /** Last value set (true = visible). */
    get value(): boolean { return log.length === 0 ? true : log[log.length - 1]; },
    get callCount(): number { return log.length; },
  };
}

/* ------------------------------------------------------------------ */
/* Panel harness                                                       */
/* ------------------------------------------------------------------ */

function panelDef(
  binding: ApiBinding,
  seam?: ReturnType<typeof recordingSeam>,
  visibility?: ReturnType<typeof recordingVisibility>,
  keys: readonly GeoKey[] = ["elevation"],
  mode?: "modal",
): PanelDef {
  return {
    title: "IEP Usability",
    mode,
    sections: [{ id: "main", label: "Main" }],
    controls: keys.map((k) => ({
      key: k, label: k, type: "slider" as const, section: "main",
      order: 1, min: 0, max: 10, step: 0.1, default: GEO_DEFAULTS[k], regenerates: true,
    })),
    actions: ["reset"],
    binding,
    previewSeam: seam,
    committedVisibility: visibility,
  };
}

function mount(def: PanelDef, bannerContainer?: HTMLElement): { handle: PanelHandle; container: HTMLElement } {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, bannerContainer ? { container, bannerContainer } : { container });
  return { handle, container };
}

/* ------------------------------------------------------------------ */
/* Interaction helpers                                                 */
/* ------------------------------------------------------------------ */

function slider(handle: PanelHandle, key: string): HTMLInputElement {
  return handle.root.querySelector<HTMLInputElement>(`input[data-control-key="${key}"]`)!;
}
function dragSweep(el: HTMLInputElement, values: string[]): void {
  for (const v of values) { el.value = v; fireChange(el, "input"); }
}
function release(el: HTMLInputElement): void { fireChange(el, "change"); }
function stageControl(handle: PanelHandle, key: string, to: string): void {
  const el = slider(handle, key);
  dragSweep(el, [to]);
  release(el);
}

/* ------------------------------------------------------------------ */
/* DOM query helpers (banner-aware)                                    */
/* ------------------------------------------------------------------ */

/** Resolve a search root: a PanelHandle -> its root; an element -> itself. */
function scopeOf(s: PanelHandle | HTMLElement): HTMLElement {
  return "root" in s ? (s as PanelHandle).root : (s as HTMLElement);
}
function okBtn(scope: PanelHandle | HTMLElement): HTMLElement | null {
  return scopeOf(scope).querySelector<HTMLElement>('button[data-role="ok-batch"]');
}
function cancelBtn(scope: PanelHandle | HTMLElement): HTMLElement | null {
  return scopeOf(scope).querySelector<HTMLElement>('button[data-role="cancel-edit"]');
}
function marker(scope: PanelHandle | HTMLElement): HTMLElement | null {
  return scopeOf(scope).querySelector<HTMLElement>('[data-role="unapplied-marker"]');
}
function banner(scope: PanelHandle | HTMLElement): HTMLElement | null {
  return scopeOf(scope).querySelector<HTMLElement>('[data-role="edit-banner"]');
}
function overlay(scope: PanelHandle | HTMLElement): HTMLElement | null {
  return scopeOf(scope).querySelector<HTMLElement>('[data-gen-overlay="active"]');
}

// IEP-AC-17 — F1 committed visibility follows the staged lifecycle

test("IEP-AC-17: drag hides committed — set(false) lands at beginIntent", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const vis = recordingVisibility();
  const { handle } = mount(panelDef(binding, seam, vis));

  dragSweep(slider(handle, "elevation"), ["6"]);
  assert.ok(seam.log.includes("begin"), "preview seam opened at intent start");
  assert.equal(vis.log.at(-1), false, "committed hidden while dragging");
  assert.equal(binding.counts.setParams, 0, "drag never commits");
  handle.unmount();
});

test("IEP-AC-17: release STAGES and committed stays hidden (preview is the only terrain)", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const vis = recordingVisibility();
  const { handle } = mount(panelDef(binding, seam, vis));

  const el = slider(handle, "elevation");
  dragSweep(el, ["6"]);
  release(el);
  assert.equal(handle.root.dataset.editState, "staged", "release stages (no commit)");
  assert.equal(binding.counts.setParams, 0, "staging never calls setParams");
  assert.equal(vis.log.at(-1), false, "committed stays hidden while the staged preview is on-screen");
  handle.unmount();
});

test("IEP-AC-17: Cancel-from-hidden reveals committed — zero commit, preview unmoved", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const vis = recordingVisibility();
  const { handle } = mount(panelDef(binding, seam, vis));

  const el = slider(handle, "elevation");
  dragSweep(el, ["6"]);
  release(el);
  const setParamsBefore = binding.counts.setParams;
  const liveBefore = seam.log.filter((c) => c === "setLiveValue").length;

  click(cancelBtn(handle));

  // Jordan's explicit gate: if Cancel ever strands the scene hidden, this fails.
  assert.equal(vis.log.at(-1), true, "committed.visible === true on return from hidden");
  assert.equal(binding.counts.setParams - setParamsBefore, 0, "Cancel is zero-rebuild (same path as cancelBatch)");
  assert.ok(seam.log.includes("cancel"), "scratch disposed via seam.cancel()");
  assert.equal(
    seam.log.filter((c) => c === "setLiveValue").length,
    liveBefore,
    "cancel does not regen the preview (previewRebuildCount analogue unmoved on the action)",
  );
  assert.equal(handle.root.dataset.editState, "committed");
  handle.unmount();
});

test("IEP-AC-17: OK keeps committed hidden THROUGH the commit and reveals at generation-complete (no-blank rule)", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const vis = recordingVisibility();
  // Instrument the commit: snapshot committed visibility at the exact moment
  // setParams runs (the build window). Revealing before the new frame exists
  // would flash the old frame or show blank — this asserts it does not.
  const originalSetParams = binding.setParams.bind(binding);
  let hiddenDuringCommit: boolean | null = null;
  binding.setParams = (patch) => {
    hiddenDuringCommit = vis.log.at(-1) === false;
    originalSetParams(patch);
  };

  const { handle } = mount(panelDef(binding, seam, vis));
  const el = slider(handle, "elevation");
  dragSweep(el, ["6"]);
  release(el);
  click(okBtn(handle));

  assert.equal(hiddenDuringCommit, true, "committed still hidden while the new frame builds");
  assert.equal(binding.counts.setParams, 1, "exactly one commit per OK");
  assert.equal(vis.log.at(-1), true, "committed revealed at generation-complete");
  assert.ok(seam.log.includes("endCommit"), "scratch disposed on the committed reveal");
  assert.equal(handle.root.dataset.editState, "committed");
  handle.unmount();
});

test("IEP-AC-17: unmount never leaks hidden-committed; a re-mount starts visible", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const vis = recordingVisibility();
  const { handle } = mount(panelDef(binding, seam, vis));

  dragSweep(slider(handle, "elevation"), ["6"]);
  assert.equal(vis.log.at(-1), false, "hidden mid-drag");
  handle.unmount();
  assert.equal(vis.log.at(-1), true, "dispose() restores committed visibility");

  // Re-mount on the same binding: the next session must start from a committed,
  // VISIBLE view — no toggles until a new intent begins.
  const vis2 = recordingVisibility();
  const { handle: handle2 } = mount(panelDef(binding, seam, vis2));
  assert.equal(vis2.log.length, 0, "fresh mount starts visible (no leaked hidden state)");
  handle2.unmount();
});

// IEP-AC-17 negative — appearance-only panel never toggles visibility

// ---------------------------------------------------------------------------
// IEP-AC-17 negative — appearance-only panel never toggles visibility.
// A control with regenerates !== true applies immediately (Phase 3 unchanged)
// and never enters the staged/preview lifecycle, so the committed-visibility
// handle must NEVER be driven and no overlay may mount. This is the backward-
// compatibility guarantee for appearance-only panels and mini-inline callers.
// ---------------------------------------------------------------------------
test("IEP-AC-17 negative: appearance-only panel never toggles committed visibility or mounts the overlay", () => {
  const binding = syncBinding({ wireframeAmount: 0.5 });
  const vis = recordingVisibility();
  const seam = recordingSeam();
  const def: PanelDef = {
    title: "Appearance Only",
    sections: [{ id: "main", label: "Main" }],
    // NOTE: regenerates is intentionally ABSENT (defaults to false) — this is a
    // shader-only control that commits immediately and never stages.
    controls: [
      { key: "wireframeAmount", label: "wireframeAmount", type: "slider", section: "main", order: 1, min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
    actions: ["reset"],
    binding,
    previewSeam: seam,
    committedVisibility: vis,
  };
  const { handle, container } = mount(def, undefined);

  // No overlay host has been created by the shell yet.
  assert.equal(container.querySelector('[data-gen-overlay="active"]'), null, "no overlay at mount");

  // Drive an appearance-only edit (immediate apply path, never a staged intent).
  const el = slider(handle, "wireframeAmount");
  dragSweep(el, ["0.8"]);
  release(el);

  // The committed-visibility handle is NEVER touched by an appearance-only edit.
  assert.equal(vis.log.length, 0, "appearance-only edit never drives committed visibility");
  // No staged batch is possible, so the dirty diff stays empty and no overlay.
  assert.equal(marker(handle).hidden, true, "no dirty marker for an appearance-only edit");
  assert.equal(
    container.querySelector('[data-gen-overlay="active"]'),
    null,
    "appearance-only edit never mounts the generation overlay",
  );

  // Even an explicit ok()/cancel() on an empty batch is inert (no visibility, no overlay).
  click(okBtn(handle));
  click(cancelBtn(handle));
  assert.equal(vis.log.length, 0, "ok()/cancel() on an empty batch never drive committed visibility");

  handle.unmount();
});

// IEP-AC-18 — F2 banner placement, labels, and fallback

// ---------------------------------------------------------------------------
// IEP-AC-18 (F2): viewport-top banner — placement, locked labels, paired
// marker, and the in-panel fallback when no bannerContainer is supplied.
// The banner is a DOM MOVE of the shell-owned controls, not a behavior
// change: the same controller.isDirty() source and the same ok()/cancel()
// wiring must hold in either placement.
// ---------------------------------------------------------------------------

const OK_SEL = 'button[data-role="ok-batch"]';
const CANCEL_SEL = 'button[data-role="cancel-edit"]';
const MARKER_SEL = '[data-role="unapplied-marker"]';
const BANNER_SEL = '[data-role="edit-banner"]';

/** Mount with a viewport-top banner host (the F2 composition-site element). */
function mountWithBanner(
  def: PanelDef,
): { handle: PanelHandle; container: HTMLElement; bannerHost: HTMLElement } {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  // Stands in for the fixed host pinned over the TOP of the scene viewport
  // (demo wires #edit-banner-host). Deliberately OUTSIDE the panel container so
  // placement proves the shell renders into the host rather than the panel.
  const bannerHost = dom.document.createElement("div");
  bannerHost.id = "vp-banner-host";
  dom.document.body.appendChild(bannerHost);
  return { handle: mountPanel(def, { container, bannerContainer: bannerHost }), container, bannerHost };
}

test("IEP-AC-18: banner renders INTO bannerContainer (not the panel root) with locked labels + paired marker", () => {
  const binding = syncBinding();
  const { handle, bannerHost } = mountWithBanner(
    panelDef(binding, recordingSeam(), recordingVisibility(), ["elevation"]),
  );

  const banner = bannerHost.querySelector<HTMLElement>(BANNER_SEL)!;
  assert.ok(banner, "banner element exists inside bannerContainer");
  assert.equal(banner.parentElement, bannerHost, "banner is a child of bannerContainer (top of viewport)");
  assert.equal(banner.getAttribute("role"), "region", "banner is an addressable region");
  assert.equal(handle.root.querySelector(BANNER_SEL), null, "banner is NOT inside the panel root");
  // A MOVE, not a copy: the in-panel row is not additionally rendered.
  assert.equal(handle.root.querySelector(OK_SEL), null, "OK moved out of the panel root");
  assert.equal(handle.root.querySelector(CANCEL_SEL), null, "Cancel moved out of the panel root");
  assert.equal(handle.root.querySelector(MARKER_SEL), null, "marker moved out of the panel root");

  const ok = banner.querySelector<HTMLElement>(OK_SEL)!;
  const cancel = banner.querySelector<HTMLElement>(CANCEL_SEL)!;
  const marker = banner.querySelector<HTMLElement>(MARKER_SEL)!;
  assert.ok(ok && cancel && marker, "marker + OK + Cancel all live inside the banner (paired)");
  assert.equal(ok.textContent, "Generate new scene", "OK relabeled per the brief (F2 copy)");
  assert.equal(cancel.textContent, "Cancel", "Cancel label unchanged");
  assert.equal(marker.textContent, "Unapplied changes", "marker copy unchanged (diff is still the source of truth)");
  // The friendlier label must not read as a fresh random generation: the
  // tooltips keep describing the real action.
  assert.match(ok.title, /staged/i, "OK tooltip still describes applying the staged batch");
  handle.unmount();
});

test("IEP-AC-18: stage -> banner+marker visible; OK applies once and clears; Cancel discards with zero commit", () => {
  // OK path — the banner relabel is user-facing ONLY: still exactly one commit.
  {
    const binding = syncBinding();
    const { handle, bannerHost } = mountWithBanner(
      panelDef(binding, recordingSeam(), recordingVisibility(), ["elevation"]),
    );
    const banner = bannerHost.querySelector<HTMLElement>(BANNER_SEL)!;
    const ok = banner.querySelector<HTMLElement>(OK_SEL)!;
    const marker = banner.querySelector<HTMLElement>(MARKER_SEL)!;
    assert.equal(banner.hidden, true, "banner hidden with no edit window open");
    assert.equal(marker.hidden, true, "marker hidden while the diff is clean");

    const el = slider(handle, "elevation");
    dragSweep(el, ["8"]);
    release(el); // -> staged
    assert.equal(banner.hidden, false, "banner visible during the staged window");
    assert.equal(marker.hidden, false, "marker visible from the diff");

    const before = binding.counts.setParams;
    click(ok);
    assert.equal(binding.counts.setParams - before, 1, "OK from the banner = exactly one setParams");
    assert.equal(binding.getParams().elevation, 8, "committed reflects the staged value");
    assert.equal(banner.hidden, true, "banner hidden after OK (edit window closed)");
    assert.equal(marker.hidden, true, "marker cleared after OK");
    handle.unmount();
  }
  // Cancel path — zero-rebuild semantics preserved through the relocation.
  {
    const binding = syncBinding();
    const { handle, bannerHost } = mountWithBanner(
      panelDef(binding, recordingSeam(), recordingVisibility(), ["elevation"]),
    );
    const banner = bannerHost.querySelector<HTMLElement>(BANNER_SEL)!;
    const cancel = banner.querySelector<HTMLElement>(CANCEL_SEL)!;

    const el = slider(handle, "elevation");
    dragSweep(el, ["9"]);
    release(el);
    assert.equal(banner.hidden, false, "banner visible while staged");

    const before = binding.counts.setParams;
    click(cancel);
    assert.equal(binding.counts.setParams - before, 0, "Cancel from the banner = zero commit (IEP-AC-11 preserved)");
    assert.equal(binding.getParams().elevation, 5, "committed unchanged by Cancel");
    assert.equal(banner.hidden, true, "banner hidden after Cancel");
    handle.unmount();
  }
});

test("IEP-AC-18: empty batch -> banner hidden, OK inert; no-op release leaves it inert", () => {
  const binding = syncBinding();
  const { handle, bannerHost } = mountWithBanner(
    panelDef(binding, recordingSeam(), recordingVisibility(), ["elevation"]),
  );
  const banner = bannerHost.querySelector<HTMLElement>(BANNER_SEL)!;
  const ok = banner.querySelector<HTMLElement>(OK_SEL)!;
  assert.equal(banner.hidden, true, "no edit window -> banner hidden");
  assert.equal(ok.hidden, true, "OK hidden on an empty batch");
  assert.equal(ok.disabled, true, "OK disabled (inert) on an empty batch");

  // Drag released back AT the committed value stages nothing (diff-normalized):
  // the banner must not linger and OK must stay inert.
  const el = slider(handle, "elevation");
  dragSweep(el, ["7", "5"]); // returns to the committed value
  release(el);
  assert.equal(banner.hidden, true, "no-op release (value == committed) leaves the banner hidden");
  assert.equal(ok.disabled, true, "OK stays inert on the no-op batch");
  assert.equal(binding.counts.setParams, 0, "no-op batch never commits");
  handle.unmount();
});

test("IEP-AC-18 (fallback): no bannerContainer -> controls render in-panel exactly as baseline", () => {
  const binding = syncBinding();
  const { handle } = mount(panelDef(binding, recordingSeam(), recordingVisibility(), ["elevation"]));
  assert.equal(handle.root.querySelector(BANNER_SEL), null, "no banner element without bannerContainer");
  const ok = handle.root.querySelector<HTMLElement>(OK_SEL)!;
  const cancel = handle.root.querySelector<HTMLElement>(CANCEL_SEL)!;
  const marker = handle.root.querySelector<HTMLElement>(MARKER_SEL)!;
  assert.ok(ok && cancel && marker, "root-scoped queries still find OK/Cancel/marker (existing IEP-AC DOM tests keep passing)");
  assert.equal(ok.textContent, "Generate new scene", "relabel is global (copy lives in strings.ts, not the banner)");
  assert.equal(marker.hidden, true, "marker hidden while clean (baseline rule)");

  const el = slider(handle, "elevation");
  dragSweep(el, ["6"]);
  release(el);
  assert.equal(ok.hidden, false, "in-panel OK visible while staged (baseline visibility rule)");
  click(ok);
  assert.equal(binding.counts.setParams, 1, "in-panel OK commits exactly once");
  assert.equal(ok.hidden, true, "in-panel OK hides after OK");
  handle.unmount();
});

// IEP-AC-19 — F3 overlay lifecycle and no new engine event

// ---------------------------------------------------------------------------
// IEP-AC-19 — F3 generation-overlay lifecycle, counters, no new engine event.
//
// Harness note (deviation recorded in the header): the browser forced-delay
// harness is stood in for by INSTRUMENTING setParams — the overlay DOM state
// is snapshotted at the moment the ONE public setParams runs, which is the
// mid-commit probe (the synchronous engine yields no other window). The
// falsifiable claim is the DOM lifecycle: mounted before the commit completes,
// unmounted at generation-complete. The event-type-set assertion is the
// mechanical guard that F3 emits no new engine event.
// ---------------------------------------------------------------------------

function canvas19(): HTMLCanvasElement {
  const noop = (): void => {};
  return {
    clientWidth: 128, clientHeight: 128, width: 128, height: 128, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 128 }),
  } as unknown as HTMLCanvasElement;
}

function renderer19(): { stats(): Record<string, number>; rebuild(): void } {
  const t = createTerrainLayer({ worldSize: { vertices: 128, meters: 128 } });
  t.setParams({ biome: "alpine", seed: 1337, elevation: 5 });
  t.generate();
  const r = createTerrainRenderer({ terrain: t, canvas: canvas19() });
  return {
    stats: () => (r as unknown as { rebuildStats: () => Record<string, number> }).rebuildStats(),
    rebuild: () => (r as unknown as { rebuildFromSnapshot: () => void }).rebuildFromSnapshot(),
  };
}

const overlayActive = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-gen-overlay="active"]');

test("IEP-AC-19: overlay mounted at ok() BEFORE the commit runs, unmounted at generation-complete; exactly one commit", () => {
  const binding = delayBinding({ elevation: 5 });
  const { stats, rebuild } = renderer19();
  const detach = binding.on("generation-complete", () => rebuild());
  const vis = recordingVisibility();
  const def = panelDef(binding, recordingSeam(), ["elevation"]);
  def.committedVisibility = vis;
  const { handle } = mount(def);

  // Mid-commit probe: snapshot overlay presence at the moment setParams runs.
  let overlayDuringSetParams: boolean | null = null;
  const innerSetParams = binding.setParams.bind(binding);
  binding.setParams = (patch: Record<string, unknown>): void => {
    overlayDuringSetParams = overlayActive() !== null;
    innerSetParams(patch);
  };

  stageControl(handle, "elevation", "9");
  assert.equal(overlayActive(), null, "no overlay before OK");

  binding.setHold(true); // withhold generation-complete -> the commit parks in Committing
  click(okBtn(handle));

  assert.equal(overlayDuringSetParams, true, "overlay mounted when setParams ran (proves the deferral window is covered)");
  assert.notEqual(overlayActive(), null, "overlay still mounted while the commit is in flight");
  assert.equal(handle.root.dataset.editState, "committing", "OK parks in Committing (complete withheld)");
  assert.equal(binding.counts.setParams, 1, "OK = exactly one setParams");

  binding.releaseHeld(); // generation-complete lands
  assert.equal(overlayActive(), null, "overlay unmounted at generation-complete");
  assert.equal(handle.root.dataset.editState, "committed", "back to committed after complete");
  assert.equal(stats().commitRebuildCount, 1, "commitRebuildCount delta == 1 per OK");
  assert.equal(stats().previewRebuildCount, 0, "settled-batch deferral adds no preview regen");
  assert.equal(vis.log[vis.log.length - 1], true, "committed revealed at commit end");
  detach();
  handle.unmount();
});

test("IEP-AC-19 (event guard): the emitted event set during OK is unchanged — no new engine event", () => {
  // Recording binding: logs every event NAME emitted, so any new event type
  // introduced by F1/F2/F3 fails here loudly (spec §7 load-bearing guard).
  const state: Record<string, unknown> = { elevation: 5 };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emitted: string[] = [];
  function emit(ev: string, p: unknown): void {
    emitted.push(ev);
    for (const fn of listeners.get(ev) ?? []) fn(p);
  }
  const binding: ApiBinding = {
    getParams: () => ({ ...state }),
    setParams(patch) {
      Object.assign(state, patch);
      emit("generation-started", {});
      emit("generation-complete", {});
      emit("terrain-changed", { source: "setParams" });
    },
    validate: () => [],
    generate() {}, randomize() {}, reset() {},
    serialize() { return "{}"; }, deserialize() {}, setWireframe() {},
    on(ev, h) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(h);
      return () => { listeners.get(ev)!.delete(h); };
    },
    telemetry(): Telemetry { return { generationTimeMs: 1, triangleCount: 1, textureCount: 1 }; },
  };
  const vis = recordingVisibility();
  const def = panelDef(binding, recordingSeam(), ["elevation"]);
  def.committedVisibility = vis;
  const { handle } = mount(def);

  stageControl(handle, "elevation", "9");
  click(okBtn(handle));

  const set = [...new Set(emitted)].sort();
  assert.deepEqual(
    set,
    ["generation-complete", "generation-started", "terrain-changed"],
    "event set during OK is the frozen baseline — no generation-progress or any new event",
  );
  assert.ok(!emitted.some((e) => /progress/.test(e)), "no progress-style event");
  assert.equal(overlayActive(), null, "overlay lifecycle completed on the sync path too");
  handle.unmount();
});

test("IEP-AC-19 (AC-04b): Cancel during the committing window closes the overlay; revert measures 2 completes / 2 commits", () => {
  const binding = delayBinding({ elevation: 5 });
  const { stats, rebuild } = renderer19();
  const detach = binding.on("generation-complete", () => rebuild());
  const vis = recordingVisibility();
  const def = panelDef(binding, recordingSeam(), ["elevation"]);
  def.committedVisibility = vis;
  const { handle } = mount(def);
  const gcBefore = binding.counts.generationComplete;
  const commitBefore = stats().commitRebuildCount;

  stageControl(handle, "elevation", "9");
  binding.setHold(true);
  click(okBtn(handle)); // overlay up, commit parked in Committing
  assert.notEqual(overlayActive(), null, "overlay up during the commit window");

  click(cancelBtn(handle)); // honest revert-during-OK-in-flight (forced-delay stand-in)
  assert.equal(overlayActive(), null, "overlay closed on the revert path");
  binding.releaseHeld();

  assert.equal(binding.counts.generationComplete - gcBefore, 2, "generation-complete delta == 2 (measured, not hidden)");
  assert.equal(stats().commitRebuildCount - commitBefore, 2, "commitRebuildCount delta == 2 (measured)");
  assert.equal(binding.getParams().elevation, 5, "final committed == pre-batch");
  assert.equal(vis.log[vis.log.length - 1], true, "committed revealed on the revert");
  detach();
  handle.unmount();
});

test("IEP-AC-19 (edge 5): unmount with a stuck overlay removes it and restores committed visibility", () => {
  const binding = delayBinding({ elevation: 5 });
  const vis = recordingVisibility();
  const def = panelDef(binding, recordingSeam(), ["elevation"]);
  def.committedVisibility = vis;
  const { handle } = mount(def);

  stageControl(handle, "elevation", "9");
  binding.setHold(true);
  click(okBtn(handle)); // overlay mounted, commit parked
  assert.notEqual(overlayActive(), null, "overlay mounted before unmount");

  handle.unmount(); // dispose must tear the overlay down — no leak across mounts
  assert.equal(overlayActive(), null, "overlay removed on unmount (no stuck overlay leak)");
  assert.equal(vis.log[vis.log.length - 1], true, "committed visibility restored on unmount");
});

/* ------------------------------------------------------------------ */
/* F3 teardown guard (Sarah audit follow-up, non-blocking)             */
/* ------------------------------------------------------------------ */

test("IEP-AC-19 (teardown guard): unmount inside the deferred-rAF window drops the commit — zero post-teardown setParams", () => {
  // Install a controllable rAF so the F3 one-frame deferred commit is parked
  // in a queue we own; unmount (preset-switch-style teardown) inside that
  // window; flush the queue; the disposed guard must swallow the commit.
  const g = globalThis as { requestAnimationFrame?: unknown };
  const rafOriginal = g.requestAnimationFrame;
  const queue: Array<() => void> = [];
  g.requestAnimationFrame = (cb: () => void) => { queue.push(cb); return 0; };
  try {
    const binding = syncBinding();
    const vis = recordingVisibility();
    const def = panelDef(binding, recordingSeam(), ["elevation"]);
    def.committedVisibility = vis;
    const { handle } = mount(def);
    const setBefore = binding.counts.setParams;

    stageControl(handle, "elevation", "9");
    click(okBtn(handle)); // commit deferred into the fake rAF queue

    assert.equal(queue.length, 1, "the deferred commit parked in the rAF queue");
    assert.equal(binding.counts.setParams - setBefore, 0, "commit not applied yet (deferred)");

    handle.unmount(); // teardown INSIDE the one-frame deferred window

    for (const cb of queue.splice(0)) cb(); // flush: the guard must swallow it
    assert.equal(binding.counts.setParams - setBefore, 0, "NO commit landed after teardown");
    assert.equal(vis.log[vis.log.length - 1], true, "dispose() restored committed visibility");
  } finally {
    if (rafOriginal === undefined) delete g.requestAnimationFrame;
    else g.requestAnimationFrame = rafOriginal;
  }
});

/* ------------------------------------------------------------------ */
/* IEP-AC-09 (amended G6) — human-visible Generating indicator         */
/* ------------------------------------------------------------------ */
/* The original cert passed on a code-claim ("overlay mounts at ok()")  */
/* while a human saw NOTHING: on the sync engine the single-rAF commit   */
/* ran BEFORE the first paint, so the overlay was mounted and torn down  */
/* between two composites. These gates drive a controllable rAF (the     */
/* browser path the node tier never took) and assert the overlay is      */
/* still mounted AFTER the first frame is reserved for PAINT, and that   */
/* a fast regen holds the overlay past generation-complete (min dwell).  */
/* A completion-only mount — the exact class the last cert missed — FAILS. */

function fakeRaf(): { queue: Array<() => void>; install: () => () => void } {
  const queue: Array<() => void> = [];
  const raf = (cb: () => void): number => { queue.push(cb); return queue.length; };
  const install = (): (() => void) => {
    const g = globalThis as { requestAnimationFrame?: unknown };
    const prev = g.requestAnimationFrame;
    g.requestAnimationFrame = raf;
    return () => { if (prev === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = prev; queue.length = 0; };
  };
  return { queue, install };
}

test("IEP-AC-09 (paint-barrier): commit is deferred TWO frames so the overlay gets a PAINT before the blocking generation", () => {
  const { queue, install } = fakeRaf();
  const restore = install();
  try {
    const binding = syncBinding();
    const vis = recordingVisibility();
    const def = panelDef(binding, recordingSeam(), ["elevation"]);
    def.committedVisibility = vis;
    const { handle } = mount(def);
    const setBefore = binding.counts.setParams;

    stageControl(handle, "elevation", "9");
    click(okBtn(handle)!);

    // Frame 0 (the OK click task): overlay mounted, commit parked in rAF.
    assert.notEqual(overlayActive(), null, "overlay mounted at ok()");
    assert.equal(binding.counts.setParams - setBefore, 0, "commit deferred — not run on the click task");

    // Tick the FIRST rAF. With a single-rAF commit this is where the blocking
    // generation would run and the sync engine would tear the overlay down
    // BEFORE any paint. The double-rAF guarantees this frame paints the overlay.
    for (const cb of queue.splice(0)) cb();
    assert.equal(binding.counts.setParams - setBefore, 0, "first frame is paint-only — commit still deferred (double-rAF barrier)");
    assert.notEqual(overlayActive(), null, "overlay STILL mounted on the paint frame (a completion-only/single-rAF mount would be null here)");

    // Tick the SECOND rAF — now the ONE public commit runs.
    for (const cb of queue.splice(0)) cb();
    assert.equal(binding.counts.setParams - setBefore, 1, "exactly one committed rebuild");
    handle.unmount();
  } finally {
    restore();
  }
});

test("IEP-AC-09 (min dwell): a fast/sync regen keeps the overlay mounted past generation-complete so it is not an imperceptible flash; unmount cancels the pending dwell", () => {
  const { queue, install } = fakeRaf();
  const restore = install();
  try {
    const binding = syncBinding();
    const vis = recordingVisibility();
    const def = panelDef(binding, recordingSeam(), ["elevation"]);
    def.committedVisibility = vis;
    const { handle } = mount(def);

    stageControl(handle, "elevation", "9");
    click(okBtn(handle)!);
    // Drive both rAF frames so the (instant, sync) committed rebuild lands.
    for (let i = 0; i < 2; i++) { for (const cb of queue.splice(0)) cb(); }

    // The generation is DONE (setParams ran, generation-complete fired), yet
    // the overlay must persist for the minimum dwell — this is the anti-flash
    // guarantee. Without the dwell it would already be null (a ~0ms flash).
    assert.ok(binding.counts.setParams >= 1, "the fast regen completed");
    assert.notEqual(overlayActive(), null, "overlay held by the minimum dwell after a fast regen (not an imperceptible flash)");

    // Teardown must cancel the pending dwell timer — no leaked overlay/timer.
    handle.unmount();
    assert.equal(overlayActive(), null, "unmount tears the overlay down and clears the dwell");
  } finally {
    restore();
  }
});

test("IEP-AC-09 (preset switch): a biome (Caribbean/Alpine/Highlands/Desert) commit uses the same two-frame paint-barrier + dwell — overlay survives the first paint frame", () => {
  // Biome is a regenerates:true control, so a preset switch stages then commits
  // through the SAME ok() -> scheduleCommit path as a slider. This gate proves
  // the preset-switch regen is not a separate, un-guarded commit path.
  const { queue, install } = fakeRaf();
  const restore = install();
  try {
    const binding = syncBinding({ elevation: 5, biome: "highlands" });
    const vis = recordingVisibility();
    const def: PanelDef = {
      title: "IEP Preset",
      sections: [{ id: "main", label: "Main" }],
      controls: [{
        key: "biome", label: "Biome", type: "select", section: "main", order: 1,
        default: "highlands",
        options: [
          { value: "desert", label: "Desert" },
          { value: "highlands", label: "Highlands" },
          { value: "alpine", label: "Alpine" },
          { value: "caribbean", label: "Caribbean" },
        ],
        regenerates: true,
      }],
      actions: ["reset"],
      binding,
      previewSeam: recordingSeam(),
      committedVisibility: vis,
    };
    const { handle } = mount(def);
    const setBefore = binding.counts.setParams;

    const sel = handle.root.querySelector<HTMLSelectElement>('select[data-control-key="biome"]');
    assert.ok(sel, "biome select present");
    sel.value = "alpine";
    fireChange(sel, "change");
    click(okBtn(handle)!);

    assert.notEqual(overlayActive(), null, "overlay mounted at ok() for the preset switch");
    assert.equal(binding.counts.setParams - setBefore, 0, "preset commit deferred — not run on the click task");

    // First rAF frame: paint-only. A completion-only mount would be null here.
    for (const cb of queue.splice(0)) cb();
    assert.equal(binding.counts.setParams - setBefore, 0, "preset first frame is paint-only — commit still deferred (single-rAF bug would run setParams here)");
    assert.notEqual(overlayActive(), null, "overlay STILL mounted on the paint frame for a preset switch");

    // Second rAF frame: the ONE committed rebuild lands.
    for (const cb of queue.splice(0)) cb();
    assert.equal(binding.counts.setParams - setBefore, 1, "exactly one committed rebuild for the preset switch");
    // Dwell holds the overlay past the instant regen — anti-flash on a fast preset.
    assert.notEqual(overlayActive(), null, "preset overlay held by the minimum dwell (not a flash)");
    handle.unmount();
    assert.equal(overlayActive(), null, "unmount clears the preset dwell");
  } finally {
    restore();
  }
});
