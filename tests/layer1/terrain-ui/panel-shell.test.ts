/**
 * Unit tests for the reusable panel shell + binding controller.
 * Runs under node --test with a jsdom DOM (no browser required).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, createMemoryStorage, click, pressKey, fireChange, type TestDom } from "./dom-helper.ts";
import { mountPanel } from "../../../src/ui/panel/index.ts";
import type { ApiBinding, PanelDef, PanelHandle, Telemetry, ValidationError } from "../../../src/ui/panel/index.ts";

let dom: TestDom;
beforeEach(() => {
  dom = setupDom();
});
afterEach(() => dom.cleanup());

/** Simple in-memory binding with validation + events for shell tests. */
function createTestBinding(initial: Record<string, unknown> = { alpha: 5, beta: false, gamma: 5 }) {
  const state: Record<string, unknown> = { ...initial };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const binding: ApiBinding & { calls: string[]; state: Record<string, unknown> } = {
    calls,
    state,
    getParams: () => ({ ...state }),
    setParams(patch) {
      calls.push(`setParams:${JSON.stringify(patch)}`);
      const errors = binding.validate(patch);
      if (errors.length > 0) {
        emit("error", { message: errors[0].message, field: errors[0].key });
        return;
      }
      Object.assign(state, patch);
      emit("terrain-changed", { source: "setParams" });
    },
    validate(params) {
      const errors: ValidationError[] = [];
      if ("alpha" in params && (typeof params.alpha !== "number" || params.alpha < 0 || params.alpha > 10)) {
        errors.push({ key: "alpha", message: "Alpha out of range", code: "out-of-range" });
      }
      if ("gamma" in params && (typeof params.gamma !== "number" || params.gamma < 0 || params.gamma > 10)) {
        errors.push({ key: "gamma", message: "Gamma out of range", code: "out-of-range" });
      }
      return errors;
    },
    generate() { calls.push("generate"); },
    randomize() { calls.push("randomize"); state.alpha = 7; emit("terrain-changed", { source: "randomize" }); },
    reset() { calls.push("reset"); Object.assign(state, initial); emit("terrain-changed", { source: "reset" }); },
    serialize() { return JSON.stringify({ schemaVersion: "1.0.0", parameters: { ...state } }); },
    deserialize(json) {
      const parsed = JSON.parse(json) as { parameters?: Record<string, unknown> };
      if (!parsed.parameters) throw new Error("invalid");
      Object.assign(state, parsed.parameters);
      emit("terrain-changed", { source: "deserialize" });
    },
    setWireframe(on) { calls.push(`setWireframe:${on}`); state.wireframe = on; emit("terrain-changed", { source: "setWireframe" }); },
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

function testPanelDef(binding: ApiBinding, extra: Partial<PanelDef> = {}): PanelDef {
  return {
    title: "Test Panel",
    sections: [{ id: "main", label: "Main" }],
    controls: [
      { key: "alpha", label: "Alpha", type: "slider", section: "main", order: 1, min: 0, max: 10, step: 1, default: 5 },
      { key: "beta", label: "Beta", type: "toggle", section: "main", order: 2, defaultBool: false },
      // Number control for invalid-input tests: range inputs clamp typed
      // values at max, so out-of-range must be exercised on a number field.
      { key: "gamma", label: "Gamma", type: "number", section: "main", order: 3, min: 0, max: 10, step: 1, default: 5 },
    ],
    actions: ["randomize", "reset", "save", "load", "wireframe"],
    binding,
    ...extra,
  };
}

function mount(def: PanelDef): { handle: PanelHandle; container: HTMLElement } {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, { container });
  return { handle, container };
}

test("panel renders title, sections, all controls, all action buttons", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  assert.equal(handle.root.querySelector(".panel-shell__title")?.textContent, "Test Panel");
  assert.equal(handle.root.querySelectorAll(".panel-control").length, 3);
  assert.equal(handle.root.querySelectorAll('.panel-actions__button').length, 4); // randomize/reset/save/load
  assert.ok(handle.root.querySelector('input[data-action="wireframe"]'));
  handle.unmount();
});

test("controls populate from getParams on mount", () => {
  const binding = createTestBinding({ alpha: 8, beta: true, gamma: 9 });
  const { handle } = mount(testPanelDef(binding));
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  const beta = handle.root.querySelector<HTMLInputElement>('input[data-control-key="beta"]')!;
  const gamma = handle.root.querySelector<HTMLInputElement>('input[data-control-key="gamma"]')!;
  assert.equal(alpha.value, "8");
  assert.equal(beta.checked, true);
  assert.equal(gamma.value, "9");
  handle.unmount();
});

test("control change sends correct patch; success updates state", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  alpha.value = "3";
  fireChange(alpha, "input");
  assert.ok(binding.calls.some((c) => c.includes('"alpha":3')));
  assert.equal(binding.state.alpha, 3);
  handle.unmount();
});

test("invalid control change reverts value, shows inline error, status summary", () => {
  const binding = createTestBinding({ gamma: 5 });
  const { handle } = mount(testPanelDef(binding));
  const gamma = handle.root.querySelector<HTMLInputElement>('input[data-control-key="gamma"]')!;
  // Typing 999 into a 0-10 number field: binding.validate rejects, value reverts.
  gamma.value = "999";
  fireChange(gamma, "change");
  assert.equal(gamma.value, "5", "value reverted to authoritative");
  const errEl = handle.root.querySelector('.panel-control[data-key="gamma"] .panel-control__error')!;
  assert.equal(errEl.hidden, false);
  assert.match(errEl.textContent ?? "", /Gamma out of range/);
  assert.equal(gamma.getAttribute("aria-invalid"), "true");
  const status = handle.root.querySelector(".panel-status__validation")!;
  assert.match(status.textContent ?? "", /1 invalid parameter/);
  assert.equal(binding.state.gamma, 5, "state not corrupted");
  handle.unmount();
});

test("external setParams via event subscription updates controls", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  // Simulate an agent/test calling the API directly.
  binding.setParams({ alpha: 9 });
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  assert.equal(alpha.value, "9");
  handle.unmount();
});

test("randomize action calls API and refreshes controls", () => {
  const binding = createTestBinding({ alpha: 5 });
  const { handle } = mount(testPanelDef(binding));
  const btn = handle.root.querySelector<HTMLButtonElement>('button[data-action="randomize"]')!;
  click(btn);
  assert.ok(binding.calls.includes("randomize"));
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  assert.equal(alpha.value, "7");
  handle.unmount();
});

test("reset action reverts all controls to defaults", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  binding.setParams({ alpha: 9 });
  const btn = handle.root.querySelector<HTMLButtonElement>('button[data-action="reset"]')!;
  click(btn);
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  assert.equal(alpha.value, "5");
  handle.unmount();
});

test("wireframe toggle calls API; external change reflects in toggle", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  const cb = handle.root.querySelector<HTMLInputElement>('input[data-action="wireframe"]')!;
  cb.checked = true;
  fireChange(cb);
  assert.ok(binding.calls.includes("setWireframe:true"));
  // External change
  binding.setWireframe(false);
  assert.equal(cb.checked, false);
  handle.unmount();
});

test("save/load round-trip through StorageAdapter restores state", async () => {
  const binding = createTestBinding({ alpha: 5 });
  const storage = createMemoryStorage();
  const { handle } = mount(testPanelDef(binding, { storage }));
  // Save via dialog
  const saveBtn = handle.root.querySelector<HTMLButtonElement>('button[data-action="save"]')!;
  click(saveBtn);
  const dialog = dom.document.querySelector(".panel-dialog")!;
  assert.ok(dialog, "save dialog opens");
  const nameInput = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
  nameInput.value = "cfg1";
  click(dialog.querySelector(".panel-dialog__footer button")!);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(storage.store.has("cfg1"));
  // Mutate, then load
  binding.setParams({ alpha: 2 });
  const loadBtn = handle.root.querySelector<HTMLButtonElement>('button[data-action="load"]')!;
  click(loadBtn);
  await new Promise((r) => setTimeout(r, 0));
  const loadDialog = dom.document.querySelector(".panel-dialog")!;
  const select = loadDialog.querySelector("select")!;
  assert.equal(select.options[0].value, "cfg1");
  click(loadDialog.querySelector(".panel-dialog__footer button")!);
  await new Promise((r) => setTimeout(r, 0));
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  assert.equal(alpha.value, "5", "loaded state restored");
  handle.unmount();
});

test("invalid JSON on load shows error, terrain unchanged", async () => {
  const binding = createTestBinding({ alpha: 5 });
  const storage = createMemoryStorage();
  storage.store.set("broken", "{not json");
  const { handle } = mount(testPanelDef(binding, { storage }));
  const loadBtn = handle.root.querySelector<HTMLButtonElement>('button[data-action="load"]')!;
  click(loadBtn);
  await new Promise((r) => setTimeout(r, 0));
  const loadDialog = dom.document.querySelector(".panel-dialog")!;
  click(loadDialog.querySelector(".panel-dialog__footer button")!);
  await new Promise((r) => setTimeout(r, 0));
  const status = handle.root.querySelector(".panel-status__message")!;
  assert.match(status.textContent ?? "", /Invalid configuration/);
  assert.equal(binding.state.alpha, 5, "terrain unchanged");
  handle.unmount();
});

test("telemetry populated on mount from binding", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  const tele = handle.root.querySelector(".panel-status__telemetry")!;
  assert.match(tele.textContent ?? "", /Gen: 42 ms/);
  assert.match(tele.textContent ?? "", /Tris: 100/);
  handle.unmount();
});

test("unmount tears down event subscriptions (no updates after unmount)", () => {
  const binding = createTestBinding();
  const { container } = mount(testPanelDef(binding));
  const handle = mountPanel(testPanelDef(binding), { container });
  handle.unmount();
  // After unmount, external changes must not throw and DOM is detached.
  binding.setParams({ alpha: 4 });
  assert.equal(container.querySelectorAll(".panel-shell").length, 1, "only the always-mounted panel remains");
  handle.unmount(); // idempotent
});

test("keyboard: arrow adjusts slider by step; Home/End clamp", () => {
  const binding = createTestBinding({ alpha: 5 });
  const { handle } = mount(testPanelDef(binding));
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  pressKey(alpha, "ArrowRight");
  assert.equal(binding.state.alpha, 6);
  pressKey(alpha, "ArrowLeft");
  pressKey(alpha, "ArrowLeft");
  assert.equal(binding.state.alpha, 4);
  pressKey(alpha, "End");
  assert.equal(binding.state.alpha, 10);
  pressKey(alpha, "Home");
  assert.equal(binding.state.alpha, 0);
  pressKey(alpha, "PageUp");
  assert.equal(binding.state.alpha, 10, "PageUp clamped at max");
  handle.unmount();
});

test("keyboard: toggle responds to Space and Enter", () => {
  const binding = createTestBinding();
  const { handle } = mount(testPanelDef(binding));
  const beta = handle.root.querySelector<HTMLInputElement>('input[data-control-key="beta"]')!;
  pressKey(beta, " ");
  assert.equal(binding.state.beta, true);
  pressKey(beta, "Enter");
  assert.equal(binding.state.beta, false);
  handle.unmount();
});

test("modal mode: Escape unmounts; focus trap contains Tab", () => {
  const binding = createTestBinding();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const outside = dom.document.createElement("button");
  dom.document.body.appendChild(outside);
  outside.focus();
  const handle = mountPanel(testPanelDef(binding, { mode: "modal" }), { container });
  assert.ok(container.querySelector(".panel-shell__backdrop"));
  // Tab from last focusable wraps inside panel (trap): find last focusable.
  const focusables = handle.root.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  const last = focusables[focusables.length - 1];
  last.focus();
  last.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(dom.document.activeElement, focusables[0], "tab wrapped to first");
  // Escape closes modal.
  handle.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(container.querySelector(".panel-shell"), null);
  assert.equal(dom.document.activeElement, outside, "focus returned");
});

// IEP Phase-1 (spec 2A): the 50 ms commit debounce is replaced by an
// intent-scoped commit. In-drag "input" events must NOT reach setParams; the
// full-resolution regeneration fires exactly once on the release ("change").
test("intent-commit: in-drag input never commits; release commits once", async () => {
  const binding = createTestBinding();
  const def = testPanelDef(binding);
  def.controls[0].regenerates = true; // alpha is geometry-like
  const { handle } = mount(def);
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  const before = binding.calls.filter((c) => c.startsWith("setParams")).length;
  for (const v of ["1", "2", "3", "4", "8"]) {
    alpha.value = v;
    fireChange(alpha, "input");
  }
  const mid = binding.calls.filter((c) => c.startsWith("setParams")).length;
  assert.equal(mid, before, "no setParams during in-drag input (intent not ended)");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(binding.calls.filter((c) => c.startsWith("setParams")).length, before,
    "no timer-driven commit; only release commits");
  fireChange(alpha, "change");
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // Phase 3: release STAGES; OK commits the batch once
  const after = binding.calls.filter((c) => c.startsWith("setParams")).length;
  assert.equal(after, before + 1, "exactly one commit on OK (release stages)");
  assert.equal(binding.state.alpha, 8, "final value applied");
  handle.unmount();
});

test("intent-commit: release with no net change commits nothing", () => {
  const binding = createTestBinding(); // alpha committed = 5
  const def = testPanelDef(binding);
  def.controls[0].regenerates = true;
  const { handle } = mount(def);
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  const before = binding.calls.filter((c) => c.startsWith("setParams")).length;
  alpha.value = "3";
  fireChange(alpha, "input");
  alpha.value = "5";
  fireChange(alpha, "input");
  fireChange(alpha, "change");
  assert.equal(binding.calls.filter((c) => c.startsWith("setParams")).length, before,
    "release back to committed value is a no-op");
  handle.unmount();
});

test("non-regenerating keys apply immediately (no debounce)", () => {
  const binding = createTestBinding();
  const def = testPanelDef(binding);
  def.controls[0].regenerates = false;
  const { handle } = mount(def);
  const alpha = handle.root.querySelector<HTMLInputElement>('input[data-control-key="alpha"]')!;
  alpha.value = "2";
  fireChange(alpha, "input");
  assert.equal(binding.state.alpha, 2);
  handle.unmount();
});

test("aria-label present on all controls; tooltip exposed", () => {
  const binding = createTestBinding();
  const def = testPanelDef(binding);
  def.controls[0].tooltip = "Alpha tooltip";
  const { handle } = mount(def);
  for (const control of def.controls) {
    const el = handle.root.querySelector(`[data-control-key="${control.key}"]`)!;
    assert.equal(el.getAttribute("aria-label"), control.label);
  }
  const label = handle.root.querySelector('.panel-control[data-key="alpha"] .panel-control__label')!;
  assert.equal(label.getAttribute("title"), "Alpha tooltip");
  handle.unmount();
});

test("visibility + disabled predicates driven by params", () => {
  const binding = createTestBinding({ alpha: 5, beta: false, gamma: 5 });
  const def = testPanelDef(binding);
  const beta = def.controls[1];
  beta.visible = (p) => p.alpha === 5; // visible only while alpha == 5
  beta.disabled = (p) => p.beta === true;
  const { handle } = mount(def);
  const betaRow = handle.root.querySelector('.panel-control[data-key="beta"]')!;
  const betaInput = handle.root.querySelector<HTMLInputElement>('input[data-control-key="beta"]')!;
  assert.equal(betaRow.hidden, false);
  assert.equal(betaInput.disabled, false);
  binding.setParams({ alpha: 6 });
  assert.equal(betaRow.hidden, true, "hidden when predicate false");
  binding.setParams({ alpha: 5 });
  assert.equal(betaRow.hidden, false, "visible again");
  handle.unmount();
});
