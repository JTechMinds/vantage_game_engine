/**
 * Terrain panel tests — the real M-T1 headless core behind the panel.
 * Covers schema completeness (L1-AC-031/032), binding behavior against the
 * frozen API (L1-AC-033/034/036), save round-trip via serialize()/
 * deserialize() (L1-AC-110/111/115), and wireframe (L1-AC-100/101).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, createMemoryStorage, click, fireChange, type TestDom } from "./dom-helper.ts";
import { mountPanel } from "../../../src/ui/panel/index.ts";
import { createTerrainPanelDef, TERRAIN_CONTROLS, TERRAIN_SECTIONS } from "../../../src/ui/layers/terrain/TerrainPanelDef.ts";
import { createTerrainBinding } from "../../../src/ui/layers/terrain/TerrainBinding.ts";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import type { PanelHandle } from "../../../src/ui/panel/index.ts";

let dom: TestDom;
beforeEach(() => {
  dom = setupDom();
});
afterEach(() => dom.cleanup());

function mountTerrain(): { handle: PanelHandle; container: HTMLElement; layer: ReturnType<typeof createTerrainLayer> } {
  const layer = createTerrainLayer();
  layer.generate();
  const binding = createTerrainBinding(() => layer);
  const def = createTerrainPanelDef({ binding, storage: createMemoryStorage() });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, { container });
  return { handle, container, layer };
}

test("schema: all 9 terrain controls with valid types, ranges, sections", () => {
  assert.equal(TERRAIN_CONTROLS.length, 9);
  const sectionIds = new Set(TERRAIN_SECTIONS.map((s) => s.id));
  const keys = new Set<string>();
  for (const c of TERRAIN_CONTROLS) {
    assert.ok(sectionIds.has(c.section), `section ${c.section} declared`);
    assert.ok(!keys.has(c.key), `key ${c.key} unique`);
    keys.add(c.key);
    assert.ok(["slider", "number", "select", "toggle", "button", "text"].includes(c.type));
    if (c.type === "slider") {
      assert.equal(typeof c.min, "number");
      assert.equal(typeof c.max, "number");
      assert.ok((c.min ?? 0) < (c.max ?? 100));
      assert.ok((c.step ?? 0) > 0);
    }
    if (c.type === "select") assert.ok((c.options?.length ?? 0) > 0);
  }
  for (const key of ["timeOfDay", "mountainAggression", "valleyAggression", "riverAggression", "elevation", "windIntensity", "windDirection", "biome", "seed"]) {
    assert.ok(keys.has(key), `M-T1 param ${key} has a control (no aliasing)`);
  }
});

test("panel renders 9 controls + 5 standard actions (L1-AC-031/032)", () => {
  const { handle } = mountTerrain();
  assert.equal(handle.root.querySelectorAll(".panel-control").length, 9);
  assert.equal(handle.root.querySelectorAll(".panel-actions__button").length, 4);
  assert.ok(handle.root.querySelector('input[data-action="wireframe"]'));
  handle.unmount();
});

test("slider change flows through setParams into the real terrain (L1-AC-033)", () => {
  const { handle, layer } = mountTerrain();
  const before = layer.getParams().elevation;
  const el = handle.root.querySelector<HTMLInputElement>('input[data-control-key="elevation"]')!;
  el.value = "7.5";
  fireChange(el, "change");
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // Phase 3: OK applies the staged slider value
  assert.equal(layer.getParams().elevation, 7.5);
  assert.notEqual(before, 7.5);
  handle.unmount();
});

test("external API change updates controls via event subscription (L1-AC-034)", () => {
  const { handle, layer } = mountTerrain();
  layer.setParams({ biome: "alpine" });
  const el = handle.root.querySelector<HTMLSelectElement>('select[data-control-key="biome"]')!;
  assert.equal(el.value, "alpine");
  layer.setParams({ timeOfDay: 21 });
  const tod = handle.root.querySelector<HTMLInputElement>('input[data-control-key="timeOfDay"]')!;
  assert.equal(tod.value, "21");
  handle.unmount();
});

test("invalid input shows error, terrain unchanged (L1-AC-036)", () => {
  // Range inputs clamp typed DOM values to [min,max], so an out-of-range
  // value can only reach the binding via a direct patch (agent/test path).
  const layer = createTerrainLayer();
  layer.generate();
  const binding = createTerrainBinding(() => layer);
  const def = createTerrainPanelDef({ binding, storage: createMemoryStorage() });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, { container });
  const before = layer.getParams().elevation;
  binding.setParams({ elevation: 999 });
  assert.equal(layer.getParams().elevation, before, "terrain unchanged");
  const el = handle.root.querySelector<HTMLInputElement>('input[data-control-key="elevation"]')!;
  assert.equal(el.value, String(before), "control reverted");
  const err = handle.root.querySelector('.panel-control[data-key="elevation"] .panel-control__error')!;
  assert.equal(err.hidden, false);
  handle.unmount();
});

test("wireframe toggle → API; API → toggle (L1-AC-100/101)", () => {
  const { handle, layer } = mountTerrain();
  const cb = handle.root.querySelector<HTMLInputElement>('input[data-action="wireframe"]')!;
  cb.checked = true;
  fireChange(cb);
  assert.equal(layer.getParams().wireframe, true);
  layer.setWireframe(false);
  assert.equal(cb.checked, false);
  handle.unmount();
});

test("save → load round-trip restores identical terrain (L1-AC-110/111)", async () => {
  const layer = createTerrainLayer();
  layer.generate();
  const binding = createTerrainBinding(() => layer);
  const storage = createMemoryStorage();
  const def = createTerrainPanelDef({ binding, storage });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, { container });
  const snapshotBefore = JSON.stringify(layer.snapshot());
  // Save
  click(handle.root.querySelector<HTMLButtonElement>('button[data-action="save"]')!);
  const saveDialog = dom.document.querySelector(".panel-dialog")!;
  saveDialog.querySelector<HTMLInputElement>('input[type="text"]')!.value = "roundtrip";
  click(saveDialog.querySelector(".panel-dialog__footer button")!);
  await new Promise((r) => setTimeout(r, 0));
  // Mutate
  layer.setParams({ elevation: 9.3, biome: "desert" });
  // Load
  click(handle.root.querySelector<HTMLButtonElement>('button[data-action="load"]')!);
  await new Promise((r) => setTimeout(r, 0));
  const loadDialog = dom.document.querySelector(".panel-dialog")!;
  click(loadDialog.querySelector(".panel-dialog__footer button")!);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(JSON.stringify(layer.snapshot()), snapshotBefore, "terrain restored");
  handle.unmount();
});

test("UI save format equals headless serialize() (L1-AC-115)", async () => {
  const layer = createTerrainLayer();
  layer.generate();
  const binding = createTerrainBinding(() => layer);
  const storage = createMemoryStorage();
  const def = createTerrainPanelDef({ binding, storage });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, { container });
  click(handle.root.querySelector<HTMLButtonElement>('button[data-action="save"]')!);
  const saveDialog = dom.document.querySelector(".panel-dialog")!;
  saveDialog.querySelector<HTMLInputElement>('input[type="text"]')!.value = "fmt";
  click(saveDialog.querySelector(".panel-dialog__footer button")!);
  await new Promise((r) => setTimeout(r, 0));
  const stored = storage.store.get("fmt")!;
  const direct = layer.serialize();
  // serialize() stamps createdAt per call; compare the rest structurally.
  const strip = (j: string) => { const o = JSON.parse(j) as Record<string, unknown>; delete o["createdAt"]; return o; };
  assert.deepEqual(strip(stored), strip(direct), "same format, no reshaping");
  // The stored string is loadable by the headless API directly.
  const fresh = createTerrainLayer();
  fresh.deserialize(stored);
  assert.deepEqual(fresh.getParams(), layer.getParams(), "headless deserialize of UI-saved JSON");
  handle.unmount();
});

test("randomize updates seed control; reset reverts all controls", () => {
  const { handle, layer } = mountTerrain();
  const seedEl = handle.root.querySelector<HTMLInputElement>('input[data-control-key="seed"]')!;
  const before = layer.getParams().seed;
  click(handle.root.querySelector<HTMLButtonElement>('button[data-action="randomize"]')!);
  assert.notEqual(layer.getParams().seed, before);
  assert.equal(seedEl.value, String(layer.getParams().seed));
  click(handle.root.querySelector<HTMLButtonElement>('button[data-action="reset"]')!);
  assert.equal(seedEl.value, "1");
  handle.unmount();
});

test("typed seed string is accepted and applied as a number", () => {
  const { handle, layer } = mountTerrain();
  const seedEl = handle.root.querySelector<HTMLInputElement>('input[data-control-key="seed"]')!;
  seedEl.value = "1234";
  fireChange(seedEl);
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // Phase 3: OK applies the staged seed
  assert.equal(layer.getParams().seed, 1234);
  handle.unmount();
});

test("invalid seed string shows error, terrain unchanged", () => {
  const { handle, layer } = mountTerrain();
  const before = layer.getParams().seed;
  const seedEl = handle.root.querySelector<HTMLInputElement>('input[data-control-key="seed"]')!;
  seedEl.value = "not-a-seed";
  fireChange(seedEl);
  click(handle.root.querySelector<HTMLButtonElement>('button[data-role="ok-batch"]')!); // Phase 3: OK triggers validation; invalid value is rejected
  assert.equal(layer.getParams().seed, before);
  const err = handle.root.querySelector('.panel-control[data-key="seed"] .panel-control__error')!;
  assert.equal(err.hidden, false);
  handle.unmount();
});

test("unmount mid-generation is safe; subscriptions torn down", () => {
  const { handle, layer, container } = mountTerrain();
  handle.unmount();
  assert.doesNotThrow(() => layer.randomize());
  assert.equal(container.querySelector(".panel-shell"), null);
});
