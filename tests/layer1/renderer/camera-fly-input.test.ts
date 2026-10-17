/*
 * Camera fly-input gates (spec-camera-navigation.md §7).
 *
 * Browser-free + jsdom gates for the free-fly camera overhaul: the PURE input
 * model (src/engine/layer1/renderer/fly-camera.ts) and the demo-shell wiring
 * (demo/fly-controls.ts + demo/terrain-demo.ts). The engine renderer is NOT
 * touched — every fly/look move is a pose-only setCamera, so the load-bearing
 * must-not-regress (P-AC-09 / strong-form rebuildCount flat) is asserted by
 * reusing the certified observation idioms rather than inventing new ones:
 *   - FLY-AC-08 reuses the camera-rebuild-guard.test.ts headless-renderer +
 *     rebuildStats() pattern (getContext:()=>null, non-enumerable counters).
 *   - FLY-AC-10 reuses the iep-panel-staged.test.ts jsdom mount/dispatch pattern
 *     (setupDom + real window KeyboardEvent/pointer events) for the two scoping
 *     negative controls (drag-vs-panel ownership, key-vs-focus deferral).
 *
 * ACs asserted here (CI-verifiable):
 *   FLY-AC-01 applyLook: right dx changes yaw, down dy changes pitch, zero = identity.
 *   FLY-AC-02 pitch clamp: repeated large drags saturate at ±pitchLimitRad, never
 *          exceed or flip (|pitch| <= limit, clampPitch monotone).
 *   FLY-AC-03 W fly-style: pitch<0 + W descends (y decreases); pitch=0 + W is
 *          horizontal (y unchanged) — the U-Q3 full-view-vector contract.
 *   FLY-AC-04 A/D strafe world-horizontal: y unchanged, A = -D, pitch-independent.
 *   FLY-AC-05 Q/E world-vertical regardless of pitch: Q up / E down, x/z unmoved.
 *   FLY-AC-06 Shift boost: boost displacement = boostMultiplier x base for same dt.
 *   FLY-AC-07 frame-rate independence: one dt=0.08 step == two dt=0.04 steps;
 *          diagonal (W+D) not faster than a single axis (composite normalized).
 *   FLY-AC-08 (HEADLINE) rebuildCount FLAT across a scripted poseFromFly sweep —
 *          the P-AC-09 reuse; renderCount climbs, rebuildCount does not.
 *   FLY-AC-09 demo code contract: look listeners on canvas only, key handling
 *          gated by uiOwnsFocus, cameraFromOrbit keeps cameraDirty=true with no
 *          setCamera, tick() issues exactly one setCamera (PA-1a-08 shape intact).
 *   FLY-AC-10 jsdom negative controls: (a) panel slider pointerdown does NOT
 *          rotate; (b) focus-on-panel KeyW defers (no move, defaultPrevented
 *          false); (c) focus-on-canvas KeyW moves.
 *   FLY-AC-11 public-surface smoke: fly-camera.ts is imported only by the demo
 *          shell + this test — NOT by terrain-renderer.ts's factory — so the
 *          enumerable renderer surface and closed method set stay byte-identical
 *          (COMPAT-2; complements architecture.test.ts + renderer-status.test.ts,
 *          whose full-suite green is asserted in the report's npm test run).
 */

// === imports + shared helpers ===

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  applyLook,
  stepFly,
  poseFromFly,
  forwardFromYawPitch,
  clampPitch,
  yawPitchFromForward,
  DEFAULT_FLY_CONFIG,
  type FlyState,
  type FlyInput,
  type FlyConfig,
} from "../../../src/engine/layer1/renderer/fly-camera.ts";
import { createFlyControls, flyStateFromPose } from "../../../demo/fly-controls.ts";
import { setupDom, type TestDom } from "../terrain-ui/dom-helper.ts";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../../../src/engine/layer1/renderer/terrain-renderer.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_SRC = readFileSync(path.resolve(HERE, "../../../demo/terrain-demo.ts"), "utf8");
const FLY_CTRL_SRC = readFileSync(path.resolve(HERE, "../../../demo/fly-controls.ts"), "utf8");
const RENDERER_SRC = readFileSync(
  path.resolve(HERE, "../../../src/engine/layer1/renderer/terrain-renderer.ts"),
  "utf8",
);

// --- camera-rebuild-guard headless-renderer idiom (reused verbatim for FLY-AC-08) ---
function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}

function makeProfileTerrain() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: "alpine", seed: 1337 });
  t.generate();
  return t;
}

function makeRenderer() {
  return createTerrainRenderer({ terrain: makeProfileTerrain(), canvas: makeCanvas() });
}

function stats(renderer: any) {
  return renderer.rebuildStats();
}

// --- pure-model state factories (fresh instances so ACs never alias) ---
function newState(over: Partial<FlyState> = {}): FlyState {
  return { x: 0, y: 100, z: 200, yaw: 0, pitch: 0, ...over };
}

function noInput(): FlyInput {
  return { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false };
}

function input(over: Partial<FlyInput> = {}): FlyInput {
  return { ...noInput(), ...over };
}

const EPS = 1e-9;

// === FLY-AC-01..06: pure applyLook / stepFly behavior ===

test("FLY-AC-01: applyLook — right dx rotates yaw, down dy pitches, zero delta is identity", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const s = { x: 0, y: 50, z: 0, yaw: 0, pitch: 0 };

  // Zero delta is identity (position + orientation untouched).
  const same = applyLook(s, 0, 0, cfg);
  assert.equal(same.yaw, 0, "zero dx leaves yaw unchanged");
  assert.equal(same.pitch, 0, "zero dy leaves pitch unchanged");
  assert.equal(same.x, 0);
  assert.equal(same.y, 50);
  assert.equal(same.z, 0);

  // Rightward drag (dx>0) turns the view right -> yaw decreases (spec 5.2).
  const r = applyLook(s, 100, 0, cfg);
  assert.ok(Math.abs(r.yaw - -100 * cfg.lookSensitivity) < 1e-12, "right dx changes yaw by -dx*sens");
  assert.notEqual(r.yaw, s.yaw, "yaw moved");
  assert.equal(r.pitch, 0, "dx does not touch pitch");

  // Downward drag (dy>0) pitches the view down -> pitch decreases (spec 5.2).
  const d = applyLook(s, 0, 100, cfg);
  assert.ok(Math.abs(d.pitch - -100 * cfg.lookSensitivity) < 1e-12, "down dy changes pitch by -dy*sens");
  assert.ok(d.pitch < 0, "downward drag pitches down (negative)");
  assert.equal(d.yaw, 0, "dy does not touch yaw");

  // Upward drag (dy<0) pitches up -> pitch increases.
  const u = applyLook(s, 0, -100, cfg);
  assert.ok(u.pitch > 0, "upward drag pitches up (positive)");

  // Position is never mutated by a look.
  assert.deepEqual({ x: r.x, y: r.y, z: r.z }, { x: 0, y: 50, z: 0 }, "applyLook is orientation-only");
});

test("FLY-AC-02: clampPitch saturates at +/-pitchLimitRad and never flips or exceeds", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const lim = cfg.pitchLimitRad;

  // clampPitch is monotone and bounded directly.
  assert.equal(clampPitch(0, lim), 0);
  assert.equal(clampPitch(lim + 5, lim), lim, "above limit clamps to +limit");
  assert.equal(clampPitch(-lim - 5, lim), -lim, "below limit clamps to -limit");

  // Repeated large downward drags saturate at -limit, never past it.
  let s = { x: 0, y: 50, z: 0, yaw: 0, pitch: 0 };
  for (let i = 0; i < 500; i++) s = applyLook(s, 0, 500, cfg);
  assert.ok(Math.abs(s.pitch - -lim) < 1e-12, "down drags saturate at -pitchLimitRad");
  assert.ok(Math.abs(s.pitch) <= lim + 1e-12, "pitch never exceeds the clamp");

  // Repeated large upward drags saturate at +limit.
  s = { x: 0, y: 50, z: 0, yaw: 0, pitch: 0 };
  for (let i = 0; i < 500; i++) s = applyLook(s, 0, -500, cfg);
  assert.ok(Math.abs(s.pitch - lim) < 1e-12, "up drags saturate at +pitchLimitRad");
  assert.ok(Math.abs(s.pitch) <= lim + 1e-12, "pitch never exceeds the clamp");

  // Yaw is unbounded (wraps freely, no clamp) even under huge drags.
  let yaw = 0;
  for (let i = 0; i < 1000; i++) yaw = applyLook({ ...s, yaw }, 10000, 0, cfg).yaw;
  assert.ok(Math.abs(yaw) > 2 * Math.PI, "yaw is unbounded (exceeds a full turn)");
});

test("FLY-AC-03: W is camera-relative and follows the full view vector (fly-style)", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const dt = 0.05;
  const noInput = { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false };

  // Looking down (pitch<0): W descends (y decreases) and tracks forward exactly.
  const pitch = -0.6;
  const yaw = 0.4;
  const s = { x: 0, y: 100, z: 0, yaw, pitch };
  const out = stepFly(s, { ...noInput, forward: true }, dt, cfg);
  const d = { x: out.x - s.x, y: out.y - s.y, z: out.z - s.z };
  const fwd = forwardFromYawPitch(yaw, pitch);
  const speed = cfg.moveSpeed * dt;
  assert.ok(d.y < 0, "W while looking down decreases y (descends, U-Q3 fly-style)");
  assert.ok(Math.abs(d.x - fwd.x * speed) < 1e-9, "W x follows view vector");
  assert.ok(Math.abs(d.y - fwd.y * speed) < 1e-9, "W y follows view vector");
  assert.ok(Math.abs(d.z - fwd.z * speed) < 1e-9, "W z follows view vector");

  // Looking up (pitch>0): W climbs (y increases).
  const up = stepFly({ ...s, pitch: 0.6 }, { ...noInput, forward: true }, dt, cfg);
  assert.ok(up.y > s.y, "W while looking up increases y (climbs)");

  // Level (pitch=0): W is horizontal -> y unchanged.
  const lvl = stepFly({ x: 0, y: 100, z: 0, yaw, pitch: 0 }, { ...noInput, forward: true }, dt, cfg);
  assert.ok(Math.abs(lvl.y - 100) < 1e-12, "level W leaves y unchanged");

  // S is the negation of W along the same view vector.
  const back = stepFly(s, { ...noInput, back: true }, dt, cfg);
  assert.ok(Math.abs((back.x - s.x) + d.x) < 1e-9, "S x = -W x");
  assert.ok(Math.abs((back.y - s.y) + d.y) < 1e-9, "S y = -W y");
  assert.ok(Math.abs((back.z - s.z) + d.z) < 1e-9, "S z = -W z");

  // A held look (yaw/pitch) is untouched by movement.
  assert.equal(out.yaw, yaw, "stepFly does not change yaw");
  assert.equal(out.pitch, pitch, "stepFly does not change pitch");
});

test("FLY-AC-04: A/D strafe is world-horizontal, A = -D, and pitch-independent in direction", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const dt = 0.05;
  const speed = cfg.moveSpeed * dt;
  const noInput = { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false };

  const yaw = 0.9;
  const s = { x: 0, y: 80, z: 0, yaw, pitch: 0 };
  const D = stepFly(s, { ...noInput, right: true }, dt, cfg);
  const A = stepFly(s, { ...noInput, left: true }, dt, cfg);

  assert.ok(Math.abs(D.y - s.y) < 1e-12, "D strafe keeps y constant (world-horizontal)");
  assert.ok(Math.abs(A.y - s.y) < 1e-12, "A strafe keeps y constant (world-horizontal)");
  assert.ok(Math.abs((D.x - s.x) + (A.x - s.x)) < 1e-9, "A is the negation of D (x)");
  assert.ok(Math.abs((D.z - s.z) + (A.z - s.z)) < 1e-9, "A is the negation of D (z)");
  // Single-axis speed: strafe displacement magnitude equals base speed.
  assert.ok(Math.abs(Math.hypot(D.x - s.x, D.z - s.z) - speed) < 1e-9, "D moves at base speed");

  // Direction is pitch-independent: the normalized horizontal strafe vector is
  // the same at level and while looking steeply down (world-up cross keeps it flat).
  const sDown = { x: 0, y: 80, z: 0, yaw, pitch: -1.2 };
  const Ddown = stepFly(sDown, { ...noInput, right: true }, dt, cfg);
  const dLevel = { x: D.x - s.x, z: D.z - s.z };
  const dDown = { x: Ddown.x - sDown.x, z: Ddown.z - sDown.z };
  const n0 = Math.hypot(dLevel.x, dLevel.z);
  const n1 = Math.hypot(dDown.x, dDown.z);
  assert.ok(Math.abs(Ddown.y - sDown.y) < 1e-12, "pitched D still keeps y constant");
  assert.ok(Math.abs(dLevel.x / n0 - dDown.x / n1) < 1e-9, "strafe direction is pitch-independent (x)");
  assert.ok(Math.abs(dLevel.z / n0 - dDown.z / n1) < 1e-9, "strafe direction is pitch-independent (z)");
});

test("FLY-AC-05: Q/E move world-vertical regardless of pitch (x/z unchanged)", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const dt = 0.05;
  const speed = cfg.moveSpeed * dt;
  const noInput = { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false };

  // At a steep pitch, Q/E must still be pure world-Y (no x/z drift).
  const near = (cfg.pitchLimitRad * 0.99); // near the clamp, still defined
  for (const pitch of [0, 0.5, -0.5, near, -near]) {
    const s = { x: 12, y: 90, z: -7, yaw: 1.7, pitch };
    const Q = stepFly(s, { ...noInput, up: true }, dt, cfg);
    const E = stepFly(s, { ...noInput, down: true }, dt, cfg);
    assert.ok(Q.y > s.y, `Q increases y at pitch=${pitch.toFixed(2)}`);
    assert.ok(E.y < s.y, `E decreases y at pitch=${pitch.toFixed(2)}`);
    assert.ok(Math.abs(Q.x - s.x) < 1e-12 && Math.abs(Q.z - s.z) < 1e-12, `Q leaves x/z unchanged at pitch=${pitch.toFixed(2)}`);
    assert.ok(Math.abs(E.x - s.x) < 1e-12 && Math.abs(E.z - s.z) < 1e-12, `E leaves x/z unchanged at pitch=${pitch.toFixed(2)}`);
    assert.ok(Math.abs(Q.y - s.y - speed) < 1e-9, `Q moves at base speed at pitch=${pitch.toFixed(2)}`);
  }
});

test("FLY-AC-06: Shift boost multiplies displacement by boostMultiplier", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const dt = 0.05;
  const noInput = { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false };
  const s = { x: 0, y: 100, z: 0, yaw: 0.7, pitch: -0.3 };

  const mag = (out: typeof s) => Math.hypot(out.x - s.x, out.y - s.y, out.z - s.z);

  const base = mag(stepFly(s, { ...noInput, forward: true, boost: false }, dt, cfg));
  const boosted = mag(stepFly(s, { ...noInput, forward: true, boost: true }, dt, cfg));
  assert.ok(Math.abs(boosted - cfg.boostMultiplier * base) < 1e-9, "boost = boostMultiplier x base displacement");

  // Boost is a pure speed scalar: same direction, larger magnitude.
  const bOut = stepFly(s, { ...noInput, forward: true, boost: true }, dt, cfg);
  const nOut = stepFly(s, { ...noInput, forward: true, boost: false }, dt, cfg);
  const ratio = boosted / base;
  assert.ok(Math.abs((bOut.x - s.x) - ratio * (nOut.x - s.x)) < 1e-9, "boost does not skew direction (x)");
  assert.ok(Math.abs((bOut.y - s.y) - ratio * (nOut.y - s.y)) < 1e-9, "boost does not skew direction (y)");
});

// === FLY-AC-07: frame-rate independence + diagonal normalization ===

test("FLY-AC-07a: stepFly over one dt=0.08 equals two dt=0.04 steps (frame-rate independent)", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const state0: FlyState = { x: 0, y: 50, z: 0, yaw: 0.3, pitch: -0.2 };
  const input: FlyInput = { forward: true, back: false, left: false, right: true, up: false, down: false, boost: false };

  // Single 80ms step
  const single = stepFly(state0, input, 0.08, cfg);

  // Two 40ms steps
  const half = stepFly(state0, input, 0.04, cfg);
  const doubled = stepFly(half, input, 0.04, cfg);

  const EPS = 1e-10;
  assert.ok(Math.abs(single.x - doubled.x) < EPS, `x: ${single.x} vs ${doubled.x}`);
  assert.ok(Math.abs(single.y - doubled.y) < EPS, `y: ${single.y} vs ${doubled.y}`);
  assert.ok(Math.abs(single.z - doubled.z) < EPS, `z: ${single.z} vs ${doubled.z}`);
});

test("FLY-AC-07b: W+D diagonal is NOT sqrt2 faster than a single axis (composite normalized)", () => {
  const cfg = DEFAULT_FLY_CONFIG;
  const state0: FlyState = { x: 0, y: 50, z: 0, yaw: 0, pitch: 0 };
  const dt = 0.05;

  // Single axis: W only
  const wOnly: FlyInput = { forward: true, back: false, left: false, right: false, up: false, down: false, boost: false };
  const sW = stepFly(state0, wOnly, dt, cfg);
  const dispW = Math.hypot(sW.x - state0.x, sW.y - state0.y, sW.z - state0.z);

  // Diagonal: W+D
  const wd: FlyInput = { forward: true, back: false, left: false, right: true, up: false, down: false, boost: false };
  const sWD = stepFly(state0, wd, dt, cfg);
  const dispWD = Math.hypot(sWD.x - state0.x, sWD.y - state0.y, sWD.z - state0.z);

  const EPS = 1e-10;
  assert.ok(
    Math.abs(dispWD - dispW) < EPS,
    `W+D displacement (${dispWD}) must equal W-only displacement (${dispW}) (composite normalized)`,
  );
});

// === FLY-AC-08: rebuildCount FLAT across a scripted fly sweep (P-AC-09 reuse) ===

test("FLY-AC-08: rebuildCount stays FLAT across a scripted fly sweep (P-AC-09 reuse)", () => {
  const r = makeRenderer();
  // Cold path: the first pose performs exactly one full pre-build of every
  // resident tier. After that, ANY pose-only move is a tier-selection flip.
  const start = { x: 0, y: 140, z: 220, yaw: 0, pitch: -0.2 };
  r.setCamera(poseFromFly(start));
  const afterCold = stats(r);
  assert.equal(afterCold.rebuildCount, 1, "first pose performs exactly one pre-build");

  // Drive a realistic fly sweep: a mix of look drags + held-key steps, feeding
  // each resulting pose through the SAME pose-only seam the demo tick() uses.
  let s = start;
  let applied = 0;
  for (let i = 0; i < 24; i++) {
    s = applyLook(s, 6, -4, DEFAULT_FLY_CONFIG);
    s = stepFly(s, { forward: true, back: false, left: i % 3 === 0, right: false, up: i % 5 === 0, down: false, boost: i % 4 === 0 }, 0.016, DEFAULT_FLY_CONFIG);
    r.setCamera(poseFromFly(s));
    applied++;
  }
  const after = stats(r);
  assert.equal(after.rebuildCount, afterCold.rebuildCount, "a scripted fly sweep rebuilds NOTHING (rebuildCount byte-identical and flat)");
  assert.equal(after.renderCount - afterCold.renderCount, applied, "every fly pose still re-rendered the view (renderOnce ran per applied pose)");
});

// === FLY-AC-09: demo code contract (readFileSync terrain-demo.ts) ===

// FLY-AC-09 is a code-contract gate (PA-1a-08 precedent): it reads the two
// production files as text and asserts the structural scoping that the runtime
// negative controls (FLY-AC-10) exercise behaviorally. Keeping the contract in
// source text means a future edit that re-parents a look listener onto
// document/window, or un-gates the keyboard, fails CI even if no browser runs.

const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo');
const demoSrc = readFileSync(path.join(demoDir, 'terrain-demo.ts'), 'utf8');
const flySrc = readFileSync(path.join(demoDir, 'fly-controls.ts'), 'utf8');

// Helper: slice a function's body from its `function NAME` header to the first
// column-aligned closing brace. The handlers here use only single-line `if`
// guards (no nested block braces), so the first `\n  }` terminates the body.
function fnBody(src: string, header: string, closer = '\n  }'): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `${header} present`);
  const end = src.indexOf(closer, start);
  assert.ok(end > start, `${header} body terminated`);
  return src.slice(start, end);
}

test('FLY-AC-09: look drag is canvas-scoped — never document/window', () => {
  // The look gesture is registered on the canvas ONLY (structural scoping):
  // a pointerdown landing on the panel/banner never reaches it.
  assert.equal(flySrc.includes('canvas.addEventListener("pointerdown"'), true, 'look pointerdown bound to canvas');
  assert.equal(flySrc.includes('canvas.addEventListener("pointermove"'), true, 'look pointermove bound to canvas');
  for (const s of [demoSrc, flySrc]) {
    assert.equal(s.includes('document.addEventListener("pointerdown"'), false, 'no look pointerdown on document');
    assert.equal(s.includes('window.addEventListener("pointerdown"'), false, 'no look pointerdown on window');
    assert.equal(s.includes('document.addEventListener("pointermove"'), false, 'no look pointermove on document');
    assert.equal(s.includes('window.addEventListener("pointermove"'), false, 'no look pointermove on window');
  }
});

test('FLY-AC-09: keyboard movement defers when a UI host owns focus (single shared guard)', () => {
  // Key handling consults the shared focus predicate and returns BEFORE any
  // preventDefault, so the panel keeps Escape/Enter/typing (IEP-AC-14). One
  // containment notion, not a second guard that fights the panel.
  const onKeyDown = fnBody(flySrc, 'function onKeyDown(e: KeyboardEvent)');
  assert.match(onKeyDown, /uiOwnsFocus\(\)/, 'onKeyDown consults uiOwnsFocus');
  const gateAt = onKeyDown.indexOf('uiOwnsFocus()');
  const pdAt = onKeyDown.indexOf('preventDefault');
  assert.ok(pdAt >= 0, 'onKeyDown does call preventDefault for a bound key');
  assert.ok(gateAt < pdAt, 'uiOwnsFocus gate returns before any preventDefault (no key swallowed while UI focused)');
});

test('FLY-AC-09: cameraFromOrbit retains the coalescing flag with no renderer.setCamera', () => {
  // COMPAT-1: PA-1a-08 stays green WITHOUT editing that test. The primitive is
  // misnamed-but-harmless now (fly rig), but its contract is unchanged.
  const body = fnBody(demoSrc, 'function cameraFromOrbit', '\n}');
  assert.equal(body.includes('cameraDirty = true'), true, 'cameraFromOrbit sets the coalescing flag');
  assert.equal(body.includes('renderer.setCamera'), false, 'cameraFromOrbit must not call setCamera directly');
});

test('FLY-AC-09: tick() consumes cameraDirty with exactly one renderer.setCamera (fly pose)', () => {
  const tickStart = demoSrc.indexOf('requestAnimationFrame(function tick');
  assert.ok(tickStart >= 0, 'tick loop present');
  const tickBody = demoSrc.slice(tickStart, demoSrc.indexOf('\n});', tickStart));
  assert.equal(tickBody.includes('if (cameraDirty)'), true, 'tick consumes the cameraDirty flag');
  assert.equal(tickBody.includes('poseFromFly'), true, 'tick applies the fly pose via poseFromFly');
  const calls = (tickBody.match(/renderer\.setCamera/g) || []).length;
  assert.equal(calls, 1, 'tick issues exactly one setCamera per frame (<=1 rebuild/render per frame)');
});

// === FLY-AC-10: jsdom negative controls (focus + canvas scoping) ===

// Reuse the iep-panel-staged jsdom idiom (dom-helper setupDom) to prove the two
// binding scoping invariants on the REAL production listener code in
// demo/fly-controls.ts: (a) a pointerdown authored on UI never arms the look
// drag, and (b/c) the held-key controller defers while a UI host owns focus and
// only consumes keys when the viewport owns focus.

interface FlyMount {
  dom: ReturnType<typeof setupDom>;
  canvas: HTMLCanvasElement;
  panel: HTMLElement;
  slider: HTMLInputElement;
  controls: FlyControls;
  dirty: () => number;
}

function mountFlyDom(): FlyMount {
  const dom = setupDom();
  const doc = dom.window.document;

  // The 3D viewport is a DOM sibling of the panel — never its ancestor — so a
  // pointer/keyboard event authored on the panel cannot reach a canvas listener.
  const canvas = doc.createElement("canvas");
  canvas.id = "terrain-canvas";
  doc.body.appendChild(canvas);

  const panel = doc.createElement("aside");
  panel.id = "panel-container"; // one of UI_HOST_IDS
  const slider = doc.createElement("input");
  slider.type = "range";
  panel.appendChild(slider);
  doc.body.appendChild(panel);

  let dirtyCount = 0;
  const controls = createFlyControls({ canvas, onPoseDirty: () => { dirtyCount += 1; } });
  return { dom, canvas, panel, slider, controls, dirty: () => dirtyCount };
}

function pointerEvt(dom: FlyMount["dom"], type: string, x: number, y: number): MouseEvent {
  return new (dom.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(type, {
    clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true,
  });
}

function keyEvt(dom: FlyMount["dom"], code: string): KeyboardEvent {
  return new (dom.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
    code, key: code, bubbles: true, cancelable: true,
  });
}

test("FLY-AC-10a: a pointerdown authored on a panel slider does NOT rotate the camera", () => {
  const m = mountFlyDom();
  try {
    const before = m.controls.getState();
    // A pointerdown+move on the slider bubbles up the document but the canvas is
    // a sibling, so the canvas-scoped look listener is never in the event path.
    m.slider.dispatchEvent(pointerEvt(m.dom, "pointerdown", 100, 100));
    m.slider.dispatchEvent(pointerEvt(m.dom, "pointermove", 160, 140));
    const after = m.controls.getState();
    assert.equal(after.yaw, before.yaw, "panel pointerdown did not change yaw");
    assert.equal(after.pitch, before.pitch, "panel pointerdown did not change pitch");
    assert.equal(m.dirty(), 0, "no pose-dirty flag fired from a UI drag");
  } finally { m.controls.dispose(); m.dom.cleanup(); }
});

test("FLY-AC-10a+ (positive control): a drag authored on the canvas DOES rotate", () => {
  const m = mountFlyDom();
  try {
    const before = m.controls.getState();
    m.canvas.dispatchEvent(pointerEvt(m.dom, "pointerdown", 300, 300));
    m.canvas.dispatchEvent(pointerEvt(m.dom, "pointermove", 360, 300)); // right drag
    const after = m.controls.getState();
    assert.notEqual(after.yaw, before.yaw, "a canvas right-drag rotates yaw (wiring is live)");
    assert.ok(m.dirty() > 0, "a canvas drag flags the pose dirty");
  } finally { m.controls.dispose(); m.dom.cleanup(); }
});

test("FLY-AC-10b: focus inside a panel host defers KeyW — no move, no preventDefault", () => {
  const m = mountFlyDom();
  try {
    m.slider.focus(); // activeElement now lives inside #panel-container
    const before = m.controls.getState();
    const ev = keyEvt(m.dom, "KeyW");
    m.dom.window.dispatchEvent(ev);
    const after = m.controls.getState();
    assert.equal(after.x, before.x && after.y, "position unchanged while UI owns focus");
    assert.equal(after.z, before.z, "no forward step while UI owns focus");
    assert.equal(ev.defaultPrevented, false, "controller did NOT consume the key (panel keeps it)");
    // And the held-key snapshot stayed empty, so a later advance() is a no-op.
    assert.equal(m.controls.advance(0.05), false, "no held key recorded while UI owned focus");
  } finally { m.controls.dispose(); m.dom.cleanup(); }
});

test("FLY-AC-10c: focus on the viewport consumes KeyW and a frame moves the camera", () => {
  const m = mountFlyDom();
  try {
    m.slider.blur(); // activeElement falls back to <body> -> viewport owns focus
    const before = m.controls.getState();
    const ev = keyEvt(m.dom, "KeyW");
    m.dom.window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, "controller consumed the key when viewport owns focus");
    assert.equal(m.controls.advance(0.05), true, "a held W key advances");
    const after = m.controls.getState();
    // yaw=0, pitch=0 -> forward is -Z (fly-camera), so W decreases z.
    assert.ok(after.z < before.z, "W with viewport focus moved the camera along the view vector");
    assert.ok(m.dirty() >= 0);
  } finally { m.controls.dispose(); m.dom.cleanup(); }
});

// === FLY-AC-11: public surface unchanged (COMPAT-2 smoke) ===

test("FLY-AC-11: fly-camera stays off the engine surface (COMPAT-2 smoke)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rendererSrc = readFileSync(path.resolve(here, "../../../src/engine/layer1/renderer/terrain-renderer.ts"), "utf8");
  const wiringSrc = readFileSync(path.resolve(here, "../../../src/engine/layer1/renderer/wiring.ts"), "utf8");

  // The pure input model must never be pulled into the renderer factory or the
  // engine wiring — that is exactly what keeps the enumerable surface and the
  // closed method set byte-identical (architecture.test.ts / renderer-status).
  assert.equal(
    /fly-camera/.test(rendererSrc),
    false,
    "terrain-renderer.ts must not import fly-camera (COMPAT-2)",
  );
  assert.equal(
    /fly-camera/.test(wiringSrc),
    false,
    "wiring.ts must not import fly-camera (COMPAT-2)",
  );

  // The renderer's enumerable public surface carries no fly method: the fly
  // camera rides the existing pose-only setCamera seam only.
  const r = makeRenderer();
  const keys = Object.keys(r);
  for (const banned of ["fly", "setFlyState", "flyState", "applyLook", "stepFly", "flyControls"]) {
    assert.equal(
      keys.some((k) => k.toLowerCase().includes(banned.toLowerCase())),
      false,
      `no '${banned}' method may appear on the public renderer surface`,
    );
  }

  // No new engine event: the terrain layer's event surface is unchanged (the
  // fly controller emits nothing — it only flags the shell's cameraDirty).
  const layer = makeProfileTerrain();
  const seen: string[] = [];
  for (const ev of ["terrain-changed", "generation-started", "generation-complete", "error"]) {
    layer.on(ev as never, () => { seen.push(ev); });
  }
  layer.generate();
  assert.ok(seen.includes("generation-complete"), "existing engine events still fire (surface intact)");
});
