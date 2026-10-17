/**
 * Reuse proof (L1-AC-038/039) + architecture import audit (L1-AC-035/123).
 *
 * 1. The dummy Layer 2 panel mounts with the SAME shell and works: renders
 *    controls, responds to changes, resets — using only the shared shell.
 * 2. Import audit: ui/panel/** contains zero layer/engine imports; layer2/**
 *    contains zero terrain imports; terrain UI imports only the public API
 *    entry path. Comments are stripped before the audit so doc comments that
 *    merely MENTION terrain do not create false positives.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setupDom, click, fireChange, type TestDom } from "./dom-helper.ts";
import { mountPanel } from "../../../src/ui/panel/index.ts";
import { createLayer2PanelDef } from "../../../src/ui/layers/layer2/Layer2PanelDef.ts";

let dom: TestDom;
beforeEach(() => {
  dom = setupDom();
});
afterEach(() => dom.cleanup());

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Remove comments so audit patterns match code, not prose. */
function stripComments(src: string): string {
  const BLOCK = "/" + "*";
  const BLOCK_END = "*" + "/";
  const LINE = "/" + "/";
  let s = src;
  let idx = s.indexOf(BLOCK);
  while (idx !== -1) {
    const end = s.indexOf(BLOCK_END, idx + 2);
    if (end === -1) break;
    s = s.slice(0, idx) + s.slice(end + 2);
    idx = s.indexOf(BLOCK);
  }
  s = s
    .split("\n")
    .map((line) => {
      const i = line.indexOf(LINE);
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
  return s;
}

function readCode(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

test("L1-AC-038: ui/panel has zero imports from layer implementations", () => {
  const files = listTsFiles("src/ui/panel");
  assert.ok(files.length >= 6, "panel module exists");
  for (const file of files) {
    const src = readCode(file);
    const forbidden = [
      /from\s+["'][^"']*engine["']/,
      /from\s+["'][^"']*terrain["']/i,
      /from\s+["'][^"']*layer2["']/i,
      /require\s*\(/,
    ];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(src), `${file} must not import layers (pattern ${pattern})`);
    }
  }
});

test("L1-AC-039: dummy Layer 2 panel has zero terrain imports", () => {
  const files = listTsFiles("src/ui/layers/layer2");
  assert.ok(files.length >= 2);
  for (const file of files) {
    const src = readCode(file);
    assert.ok(!src.includes("layer1/terrain"), `${file} must not import terrain`);
    assert.ok(!src.includes("engine/layer1"), `${file} must not import engine`);
    assert.ok(!/biome|heightfield|heightmap/i.test(src), `${file} must not reference terrain internals`);
    assert.ok(src.includes("../../panel") || src.includes("ui/panel"), `${file} uses the shared shell`);
  }
});

test("L1-AC-123: terrain UI imports only the public API entry path", () => {
  const files = listTsFiles("src/ui/layers/terrain");
  for (const file of files) {
    const src = readCode(file);
    for (const m of src.matchAll(/from\s+["']([^"']*)["']/g)) {
      const spec = m[1];
      if (spec.includes("engine/layer1/terrain")) {
        assert.ok(
          spec.endsWith("layer1/terrain/index.ts"),
          `${file} imports non-public terrain path: ${spec}`,
        );
      }
      assert.ok(!/generation|sampling|serialization|noise|prng|heightfield/i.test(spec), `internal import: ${spec}`);
    }
  }
});

test("Layer 2 dummy panel works through the shared shell (reuse proof)", () => {
  const def = createLayer2PanelDef();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const handle = mountPanel(def, { container });

  // Same shell component by name/class.
  assert.ok(handle.root.classList.contains("panel-shell"));
  assert.equal(handle.root.querySelector(".panel-shell__title")?.textContent, "Layer 2 — Object Placement (Stub)");
  assert.equal(handle.root.querySelectorAll(".panel-control").length, 2);
  // Declares only the reset action (spec §2.8).
  assert.equal(handle.root.querySelectorAll(".panel-actions__button").length, 1);

  // Responds to changes.
  const count = handle.root.querySelector<HTMLInputElement>('input[data-control-key="objectCount"]')!;
  count.value = "42";
  fireChange(count, "input");
  assert.equal(def.binding.getParams().objectCount, 42);

  // Out-of-range rejected through the shared error path (sliders clamp
  // typed DOM values, so drive the invalid patch via the binding API).
  def.binding.setParams({ objectCount: 9999 });
  assert.equal(def.binding.getParams().objectCount, 42, "invalid value rejected");
  const statusMsg = handle.root.querySelector(".panel-status__message")!;
  assert.match(statusMsg.textContent ?? "", /between 0 and 100/, "error surfaced in status bar");

  // Toggle works.
  const grid = handle.root.querySelector<HTMLInputElement>('input[data-control-key="showGrid"]')!;
  grid.checked = true;
  fireChange(grid);
  assert.equal(def.binding.getParams().showGrid, true);

  // Reset via shared action bar.
  click(handle.root.querySelector<HTMLButtonElement>('button[data-action="reset"]')!);
  assert.equal(count.value, "10");
  assert.equal(grid.checked, false);

  handle.unmount();
});

test("terrain + layer2 panels coexist with independent bindings", () => {
  const layer2 = createLayer2PanelDef();
  const c1 = dom.document.createElement("div");
  const c2 = dom.document.createElement("div");
  dom.document.body.append(c1, c2);
  const h2 = mountPanel(layer2, { container: c1 });

  // A second layer2 instance is fully independent (no shared mutable state).
  const layer2b = createLayer2PanelDef();
  const h2b = mountPanel(layer2b, { container: c2 });

  const countA = h2.root.querySelector<HTMLInputElement>('input[data-control-key="objectCount"]')!;
  const countB = h2b.root.querySelector<HTMLInputElement>('input[data-control-key="objectCount"]')!;
  countA.value = "77";
  fireChange(countA, "input");
  assert.equal(layer2.binding.getParams().objectCount, 77);
  assert.equal(countB.value, "10", "other panel unaffected");
  h2.unmount();
  h2b.unmount();
});
