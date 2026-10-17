/**
 * Responsive-layout contract for the panel shell (spec §6/§10).
 *
 * The shell is DOM + CSS (no canvas), so the responsive contract is
 * checkable statically: a fluid max-width, a narrow-viewport breakpoint,
 * wrapping control rows, and touch-friendly control sizing. Pixel rendering
 * is verified in the browser at Gate VIS (M-T4) with the live preview.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/ui/panel/panel.css", "utf8");

test("panel.css declares a narrow-viewport breakpoint", () => {
  assert.match(css, /@media[^{]*max-width/, "media query breakpoint present");
});

test("panel shell is fluid (max-width, not fixed width)", () => {
  assert.match(css, /\.panel-shell\s*\{[^}]*max-width/, "fluid shell width");
  assert.match(css, /box-sizing/, "predictable box model");
});

test("control rows wrap and controls flex (no fixed-pixel layout)", () => {
  assert.match(css, /flex-wrap/, "controls wrap on narrow viewports");
  assert.ok(!/\.panel-control\s*\{[^}]*width:\s*\d{3,}px/.test(css), "no fixed-px control widths");
});

test("touch-friendly sizing on small viewports", () => {
  assert.match(css, /min-height/, "controls have touch-friendly min height");
});
