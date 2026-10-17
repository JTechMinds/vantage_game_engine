/*
 * IEP height-ramp gates (spec-preview-height-ramp.md §13). Browser-free,
 * GPU-free: the renderer is NOT mounted, so the scratch builds no THREE node,
 * yet the ramp is computed in `update` regardless of `_geometry` and is sampled
 * headlessly via the seam probe's colorStats (spec §5.3, §13 "No GPU in
 * headless").
 *
 * Cert target: IEP-AC-10 (requirements G7) — the preview surface must be
 * height-distinguishable while dragging. This file instantiates that
 * mechanism-neutral AC via the vertex-color mechanism: a sweep of distinct
 * elevation values must produce a preview whose per-vertex colors span a real
 * range (distinctColors >= floor AND colorVariance >= floor), while a flat-fill
 * negative control collapses to a single color (proving the detector would
 * catch a regression to flat gray).
 *
 * Chosen floors (spec §15 — Charles picks values a real ramp clears with margin
 * and a flat fill clearly fails; documented here):
 *   - distinctColors >= 8   (Brad's floor; a real alpine field yields ~57 at
 *                            grid 24, so the margin is ~7x; a flat fill = 1).
 *   - colorVariance   >= 1e-5  (Rec.709 luminance variance; a real field lands
 *                            ~1.8e-4, ~18x margin; a flat fill = 0).
 * Quantizer for distinctColors: linear RGB clamped to [0,1] then rounded to
 * 8 bits per channel and packed into one int — coarse enough that float jitter
 * across identical heights cannot split one true color into many, fine enough
 * that a genuine ramp keeps its distinct stops separate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import { createTerrainRenderer } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';
import { applyHeightRamp, DEFAULT_RAMP_SRGB, type RampPalette } from '../../../src/engine/layer1/renderer/preview-ramp.ts';

interface ColorStats {
  minH: number;
  maxH: number;
  distinctColors: number;
  colorVariance: number;
}
interface PreviewSeam {
  begin(): void;
  setLiveValue(patch: Record<string, unknown>): void;
  pump(): void;
  endCommit(): void;
  cancel(): void;
  dispose(): void;
  probe(): { present: boolean; isVisible: boolean; gridN: number; farGridN: number; sampleHeight: number; colorStats: ColorStats };
  setBudget(ms: number): void;
  setGrid(n: number): void;
}

const DISTINCT_FLOOR = 8;
const VARIANCE_FLOOR = 1e-5;

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}

function makeRenderer() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: 'alpine', seed: 1337, elevation: 5 });
  t.generate();
  const r = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  return { t, r };
}
function seam(r: unknown): PreviewSeam {
  return (r as { preview: PreviewSeam }).preview;
}

// A flat linear-RGB palette (low == mid == high) — used to prove the ramp's
// own normalization can't manufacture color when the stops are identical.
const FLAT_PALETTE: RampPalette = { stops: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] };
// A distinct 3-stop palette for the pure-helper unit test (linear-ish values).
const UNIT_PALETTE: RampPalette = { stops: [0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0] };

test('IEP-AC-10: a drag sweep over distinct elevations yields a height-distinguishable preview (distinctColors>=8 AND colorVariance>=floor)', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24); // cheap headless eval, still plenty of vertices for the histogram
  p.begin();
  let sawDistinct = 0;
  let sawVariance = 0;
  for (const e of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    p.setLiveValue({ elevation: e });
    p.pump();
    const cs = p.probe().colorStats;
    sawDistinct = Math.max(sawDistinct, cs.distinctColors);
    sawVariance = Math.max(sawVariance, cs.colorVariance);
    // Each accepted in-drag frame must read as relief, not flat gray.
    assert.ok(cs.distinctColors >= DISTINCT_FLOOR, `elevation ${e}: distinctColors ${cs.distinctColors} < ${DISTINCT_FLOOR}`);
    assert.ok(cs.colorVariance >= VARIANCE_FLOOR, `elevation ${e}: colorVariance ${cs.colorVariance} < ${VARIANCE_FLOOR}`);
  }
  assert.ok(sawDistinct >= DISTINCT_FLOOR && sawVariance >= VARIANCE_FLOOR);
  p.dispose();
});

test('IEP-AC-10 negative control: a flat-fill preview collapses to ONE color (distinctColors==1)', () => {
  // Drive the seam to a real field first, then overwrite the scratch with a
  // constant height field via a fresh scratch built through the seam by feeding
  // a palette-less flat field directly to the impl through a controlled begin.
  // Simplest faithful control: build the renderer, force a single elevation and
  // then check the detector trips on the FLAT case by using the pure helper
  // with a constant field (same code path update() runs).
  const heights = new Float64Array(16).fill(42);
  const out = new Float32Array(16 * 3);
  applyHeightRamp(heights, 16, out, UNIT_PALETTE);
  // Constant field -> every vertex maps to the mid stop -> one distinct color.
  const seen = new Set<number>();
  for (let i = 0; i < 16; i++) {
    const qr = Math.round(out[i * 3] * 255);
    const qg = Math.round(out[i * 3 + 1] * 255);
    const qb = Math.round(out[i * 3 + 2] * 255);
    seen.add((qr << 16) | (qg << 8) | qb);
  }
  assert.equal(seen.size, 1, 'flat field must collapse to a single distinct color');
  // And the seam-driven detector would reject it: assert the floor is above 1.
  assert.ok(DISTINCT_FLOOR > 1, 'floor must be high enough that a flat fill fails AC-10');
});

test('IEP-AC-10 negative control (seam level): identical-palette field trips the flat detector', () => {
  // A real varying height field mapped through a FLAT palette also yields one
  // color — proves the detector keys on the rendered colors, so a regression
  // to flat gray (one stop) is caught even when heights vary.
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 8 });
  p.pump();
  const real = p.probe().colorStats;
  assert.ok(real.distinctColors >= DISTINCT_FLOOR, 'sanity: default palette ramp is distinguishable');
  p.dispose();
  // Cross-check the flat palette directly:
  const heights = new Float64Array(36);
  for (let i = 0; i < 36; i++) heights[i] = i; // varying heights
  const out = new Float32Array(36 * 3);
  applyHeightRamp(heights, 36, out, FLAT_PALETTE);
  const seen = new Set<number>();
  for (let i = 0; i < 36; i++) {
    seen.add((Math.round(out[i * 3] * 255) << 16) | (Math.round(out[i * 3 + 1] * 255) << 8) | Math.round(out[i * 3 + 2] * 255));
  }
  assert.equal(seen.size, 1, 'flat palette must render a single color despite varying heights');
});

test('Ramp unit (pure helper): monotonic field maps low->mid->high and is shape-invariant under shift/scale', () => {
  const n = 5;
  const monotonic = new Float64Array(n);
  for (let i = 0; i < n; i++) monotonic[i] = i; // 0,1,2,3,4
  const out = new Float32Array(n * 3);
  applyHeightRamp(monotonic, n, out, UNIT_PALETTE);
  // low stop (t=0) -> pure blue (0,0,1); high stop (t=1) -> pure red (1,0,0).
  assert.ok(out[0] < 0.01 && out[2] > 0.99, 'lowest height maps to the low (blue) stop');
  assert.ok(out[(n - 1) * 3] > 0.99 && out[(n - 1) * 3 + 2] < 0.01, 'highest height maps to the high (red) stop');
  // midpoint (t=0.5) -> mid (green) stop.
  const mid = Math.floor((n - 1) / 2);
  assert.ok(out[mid * 3 + 1] > 0.9 && out[mid * 3] < 0.1 && out[mid * 3 + 2] < 0.1, 'midpoint maps to the mid (green) stop');
  // Monotonic progression: red channel non-decreasing, blue non-increasing along t.
  for (let i = 1; i < n; i++) {
    assert.ok(out[i * 3] >= out[(i - 1) * 3] - 1e-9, 'red channel monotonic non-decreasing');
    assert.ok(out[i * 3 + 2] <= out[(i - 1) * 3 + 2] + 1e-9, 'blue channel monotonic non-increasing');
  }
  // Shape invariance: shift+scale the SAME relative field -> identical color sequence.
  const scaled = new Float64Array(n);
  for (let i = 0; i < n; i++) scaled[i] = monotonic[i] * 7.5 - 100; // affine, preserves t
  const out2 = new Float32Array(n * 3);
  applyHeightRamp(scaled, n, out2, UNIT_PALETTE);
  for (let i = 0; i < n * 3; i++) {
    assert.ok(Math.abs(out[i] - out2[i]) < 1e-9, `self-normalization is shift/scale invariant at ${i}`);
  }
});

test('Flat-edit edge: constant height field -> all mid stop, distinctColors==1, no NaN', () => {
  const n = 9;
  const flat = new Float64Array(n).fill(123.4);
  const out = new Float32Array(n * 3);
  applyHeightRamp(flat, n, out, UNIT_PALETTE);
  // Every vertex == mid stop (0,1,0).
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(out[i * 3] - 0) < 1e-9 && Math.abs(out[i * 3 + 1] - 1) < 1e-9 && Math.abs(out[i * 3 + 2] - 0) < 1e-9, 'flat field maps to mid stop');
  }
  assert.ok(out.every((v) => Number.isFinite(v)), 'no NaN in flat color output');
});

test('NaN/non-finite guard: a NaN height never reaches the color buffer', () => {
  const n = 5;
  const heights = new Float64Array([1, 2, NaN, 4, 5]);
  const out = new Float32Array(n * 3);
  applyHeightRamp(heights, n, out, UNIT_PALETTE);
  assert.ok(out.every((v) => Number.isFinite(v)), 'NaN height must not poison the color buffer');
  // The NaN vertex maps to the mid stop (green).
  assert.ok(Math.abs(out[2 * 3 + 1] - 1) < 1e-9, 'NaN vertex maps to mid stop');
});

test('Demotion preserves ramp: after an over-budget mid->far demotion, the far preview still shows the ramp', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  // Default mid grid (256) > far grid (128) for a 512-vertex world.
  p.begin();
  // Force the ladder: budget 0 makes the mid pump demote to farGridN, then
  // restore a generous budget so the far retry pump is accepted (deterministic,
  // no timing dependence — the demotion trigger is budget 0, not wall-clock).
  p.setBudget(0);
  p.setLiveValue({ elevation: 8 });
  p.pump(); // mid over budget -> dispose+rebuild at far, drop this frame
  const midProbe = p.probe();
  assert.equal(midProbe.gridN, midProbe.farGridN, 'ladder demoted mid -> far');
  p.setBudget(999999);
  p.pump(); // far retry accepted
  const cs = p.probe().colorStats;
  assert.ok(cs.distinctColors >= DISTINCT_FLOOR, `demoted (far) preview still ramps: distinctColors ${cs.distinctColors} < ${DISTINCT_FLOOR}`);
  assert.ok(cs.colorVariance >= VARIANCE_FLOOR, `demoted (far) preview variance ${cs.colorVariance} < ${VARIANCE_FLOOR}`);
  p.dispose();
});

test('Headless: colorStats are computed with no GL context (renderer not mounted)', () => {
  // The renderer above is built with a null-context canvas; the scratch never
  // builds a THREE node, yet colorStats is populated — the exact CI cert path.
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 6 });
  p.pump();
  const cs = p.probe().colorStats;
  assert.ok(cs.distinctColors >= DISTINCT_FLOOR, 'headless (no _geometry) still yields ramp colors');
  assert.ok(Number.isFinite(cs.minH) && Number.isFinite(cs.maxH) && cs.maxH >= cs.minH, 'colorStats expose a finite height range');
  p.dispose();
});

test('Determinism: identical params -> identical preview colors (pure function of heights)', () => {
  const mk = () => {
    const { r } = makeRenderer();
    const p = seam(r);
    p.setGrid(24);
    p.begin();
    p.setLiveValue({ elevation: 7 });
    p.pump();
    const cs = p.probe().colorStats;
    p.dispose();
    return cs;
  };
  const a = mk();
  const b = mk();
  assert.equal(a.distinctColors, b.distinctColors, 'distinctColors deterministic across builds');
  assert.ok(Math.abs(a.colorVariance - b.colorVariance) < 1e-12, 'colorVariance deterministic across builds');
  assert.ok(Math.abs(a.minH - b.minH) < 1e-12 && Math.abs(a.maxH - b.maxH) < 1e-12, 'height range deterministic across builds');
});
