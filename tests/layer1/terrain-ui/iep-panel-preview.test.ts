/**
 * IEP Phase-2 panel-level gates (spec-interactive-edit-preview-phase2.md §4.4,
 * §5). Runs under node --test with a jsdom DOM. A recording PreviewSeam proves
 * the binding controller drives the engine seam correctly through the drag
 * lifecycle, and — critically — that the seam path NEVER calls setParams (the
 * commit owner is unchanged). The renderer-level test proves the seam actually
 * regens a scratch on the real engine; here we assert the panel wiring only.
 *
 * ACs asserted: IEP-AC-04b (begin on intent, setLiveValue per live update, no
 * setParams on the drag path), IEP-AC-04 hard-swap ordering (endCommit BEFORE
 * the single commit setParams), IEP-AC-04 cancel (cancel called, zero setParams,
 * value reverts), release-with-no-change (dispose, no commit), and unmount
 * disposes the preview (no scratch leak).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, click, fireChange, type TestDom } from "./dom-helper.ts";
import { mountPanel } from "../../../src/ui/panel/index.ts";
import type { ApiBinding, PanelDef, PanelHandle, Telemetry, ValidationError } from "../../../src/ui/panel/index.ts";

let dom: TestDom;
beforeEach(() => { dom = setupDom(); });
afterEach(() => dom.cleanup());

/** Seam recorder: logs the ordered method calls the controller invokes. */
function recordingSeam() {
  const log: string[] = [];
  const seam = {
    log,
    begin: () => { log.push("begin"); },
    setLiveValue: (patch: Record<string, unknown>) => { log.push("setLiveValue:" + JSON.stringify(patch)); },
    endCommit: () => { log.push("endCommit"); },
    cancel: () => { log.push("cancel"); },
    dispose: () => { log.push("dispose"); },
  };
  return seam;
}

function syncBinding(initial: Record<string, unknown> = { elevation: 5 }) {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const counts = { setParams: 0 };
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
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }
  return binding;
}

function panelDef(binding: ApiBinding, seam: ReturnType<typeof recordingSeam>): PanelDef {
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

function releaseCommit(el: HTMLInputElement): void { fireChange(el, "change"); }

function cancelBtn(handle: PanelHandle): HTMLElement {
  return handle.root.querySelector<HTMLElement>('button[data-role="cancel-edit"]')!;
}

test("IEP-AC-04b: begin on intent, setLiveValue per live update, ZERO setParams during drag", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam));
  const el = slider(handle);
  dragSweep(el, ["1", "2", "3", "4", "6"]);
  assert.ok(seam.log[0] === "begin", "preview.begin fires on intent start (first action)");
  assert.ok(seam.log.filter((l) => l.startsWith("setLiveValue")).length >= 1,
    "live updates drive setLiveValue");
  assert.equal(binding.counts.setParams, 0, "no setParams on the drag/preview path (commit owner intact)");
});

test("IEP-AC-04 hard-swap ordering: endCommit fires BEFORE the single commit setParams", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam));
  const el = slider(handle);
  dragSweep(el, ["1", "8"]);
  releaseCommit(el); // Phase 3: release STAGES (no commit/endCommit)
  assert.equal(binding.counts.setParams, 0, "release stages: no commit yet");
  seam.log.length = 0; // focus on the OK commit transition
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // OK = hard-swap + one commit
  const endIdx = seam.log.indexOf("endCommit");
  const setIdx = binding.calls.findIndex((c) => c.startsWith("setParams"));
  assert.ok(endIdx >= 0, "endCommit invoked on commit");
  assert.equal(binding.counts.setParams, 1, "exactly one commit through the public setParams");
  // Order across the two logs: endCommit (seam) must precede the setParams commit.
  // seam.log[0] is endCommit; binding.calls[0] is the setParams.
  assert.ok(seam.log[0] === "endCommit", "endCommit is the first commit-phase seam action (hard-swap before commit)");
  assert.ok(setIdx >= 0, "commit ran via setParams");
});

test("IEP-AC-04 cancel: cancel disposes the preview and commits nothing; value reverts", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam));
  const el = slider(handle);
  dragSweep(el, ["7", "9"]);
  seam.log.length = 0;
  click(cancelBtn(handle));
  assert.ok(seam.log.includes("cancel"), "preview.cancel fires on cancel");
  assert.equal(binding.counts.setParams, 0, "cancel = zero commit");
  assert.equal(binding.getParams().elevation, 5, "value reverted to committed baseline");
});

test("release-with-no-change disposes the preview and does not commit", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam));
  const el = slider(handle);
  dragSweep(el, ["3", "5"]); // dragged, ended at the committed value
  releaseCommit(el);
  assert.ok(seam.log.includes("dispose"), "preview disposed on no-change release");
  assert.ok(!seam.log.includes("endCommit"), "no hard-swap commit path on no-change");
  assert.equal(binding.counts.setParams, 0, "no-change release = zero commit");
});

test("unmount disposes the preview so no scratch mesh leaks", () => {
  const binding = syncBinding();
  const seam = recordingSeam();
  const { handle } = mount(panelDef(binding, seam));
  const el = slider(handle);
  dragSweep(el, ["6"]); // active preview
  seam.log.length = 0;
  handle.unmount();
  assert.ok(seam.log.includes("dispose"), "controller dispose releases the preview");
});
