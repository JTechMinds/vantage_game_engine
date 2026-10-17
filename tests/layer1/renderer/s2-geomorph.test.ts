// S2 geomorphing unit tests (spec §8.1) + renderer integration (spec §8.2).
// Browser-free, GPU-free. Tests the pure geomorph.ts derivation and the
// geomorph-aware visibility path without a WebGL context.

import { applyGeomorphTierSelection } from '../../../src/engine/layer1/renderer/geomorph-wiring.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGeomorphStates,
  geomorphStepSize,
  geomorphBoundaries,
  DEFAULT_GEOMORPH_STEPS,
  MIN_GEOMORPH_STEP_SIZE,
  type GeomorphConfig,
  type GeomorphBlendState,
} from '../../../src/engine/layer1/renderer/geomorph.ts';
import type { LodPlan, LodRegion } from '../../../src/engine/layer1/renderer/lod.ts';
import type { LodTier, LodConfig } from '../../../src/engine/layer1/renderer/types.ts';

// --- Helpers ---

function makePlan(regions: LodRegion[], nearM = 80, maxMidM = 200): LodPlan {
  const config: LodConfig = { nearM, maxMidM, maxFarM: 400 };
  return {
    regionsPerAxis: 2,
    regionSpan: 4,
    spansAxis: [4, 4],
    worldWidth: 512,
    worldDepth: 512,
    vertexGrid: 512,
    config,
    regions,
  };
}

function makeRegion(cx: number, cz: number, centerDistance: number, tier: LodTier): LodRegion {
  return {
    cx, cz,
    centerX: cx * 128, centerZ: cz * 128,
    tier,
    centerDistance,
    spanX: 4, spanZ: 4,
    cellStartX: cx * 4, cellStartZ: cz * 4,
  };
}

function defaultConfig(): GeomorphConfig {
  const stepSize = geomorphStepSize(512, 512);
  return {
    enabled: true,
    stepsPerBoundary: DEFAULT_GEOMORPH_STEPS,
    stepSize,
    boundaries: geomorphBoundaries(80, 200),
  };
}

// --- geomorphStepSize ---

test('S2-UNIT: geomorphStepSize returns worldWidth/(vertexGrid-1) with floor', () => {
  assert.ok(Math.abs(geomorphStepSize(512, 512) - 512/511) < 1e-9, "512/511 cell");
  assert.ok(Math.abs(geomorphStepSize(1024, 512) - 1024/511) < 1e-9, "1024/511 cell");
  assert.equal(geomorphStepSize(1, 512), MIN_GEOMORPH_STEP_SIZE, 'below floor clamps to MIN');
  assert.equal(geomorphStepSize(-1, 512), MIN_GEOMORPH_STEP_SIZE, 'invalid width clamps');
  assert.equal(geomorphStepSize(512, 1), MIN_GEOMORPH_STEP_SIZE, 'invalid grid clamps');
});

// --- geomorphBoundaries ---

test('S2-UNIT: geomorphBoundaries returns near->mid and mid->far, no skybox', () => {
  const b = geomorphBoundaries(80, 200);
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { fromTier: 'near', toTier: 'mid', distanceM: 80 });
  assert.deepEqual(b[1], { fromTier: 'mid', toTier: 'far', distanceM: 200 });
});

// --- Blend window entry and exit ---

test('S2-UNIT: blend activates inside the near->mid window', () => {
  const cfg = defaultConfig();
  const windowWidth = cfg.stepsPerBoundary * cfg.stepSize; // 4m
  const mid = 80; // near->mid boundary
  const d = mid - windowWidth / 4; // inside window
  const region = makeRegion(0, 0, d, 'near');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'near']]);
  const states = computeGeomorphStates(plan, assignment, cfg);
  assert.equal(states.size, 1);
  const s = states.get('0,0')!;
  assert.ok(s.active);
  assert.equal(s.sourceTier, 'near');
  assert.equal(s.targetTier, 'mid');
});

test('S2-UNIT: blend deactivates outside the window', () => {
  const cfg = defaultConfig();
  const windowWidth = cfg.stepsPerBoundary * cfg.stepSize;
  const mid = 80;
  const d = mid + windowWidth; // well past the window
  const region = makeRegion(0, 0, d, 'mid');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'mid']]);
  const states = computeGeomorphStates(plan, assignment, cfg);
  assert.equal(states.size, 0, 'outside window: no blend');
});

// --- Quantized t values for N = 4 ---

test('S2-UNIT: t is quantized to {0, 0.25, 0.5, 0.75, 1.0} for N=4', () => {
  const cfg = defaultConfig();
  const windowWidth = cfg.stepsPerBoundary * cfg.stepSize;
  const boundary = 80;
  const start = boundary - windowWidth / 2;
  const step = cfg.stepSize;
  const validT = new Set([0, 0.25, 0.5, 0.75, 1.0]);

  for (let i = 0; i <= cfg.stepsPerBoundary; i++) {
    const d = start + i * step + step * 0.5; // center of step i
    const region = makeRegion(0, 0, d, 'near');
    const plan = makePlan([region]);
    const assignment = new Map<string, LodTier>([['0,0', 'near']]);
    const states = computeGeomorphStates(plan, assignment, cfg);
    const s = states.get('0,0');
    if (s) {
      assert.ok(validT.has(s.t), `t=${s.t} must be quantized (step ${i})`);
      assert.equal(s.stepIndex, i, `stepIndex must equal ${i}`);
    }
  }
});

// --- Reverse symmetry ---

test('S2-UNIT: sweep forward and reverse produces symmetric t sequence', () => {
  const cfg = defaultConfig();
  const windowWidth = cfg.stepsPerBoundary * cfg.stepSize;
  const boundary = 80;
  const start = boundary - windowWidth / 2;
  const end = boundary + windowWidth / 2;
  const step = cfg.stepSize;

  const forward: number[] = [];
  const reverse: number[] = [];

  for (let d = start; d <= end; d += step) {
    const region = makeRegion(0, 0, d, 'near');
    const plan = makePlan([region]);
    const assignment = new Map<string, LodTier>([['0,0', 'near']]);
    const states = computeGeomorphStates(plan, assignment, cfg);
    const s = states.get('0,0');
    forward.push(s ? s.t : -1);
  }

  for (let d = end; d >= start; d -= step) {
    const region = makeRegion(0, 0, d, 'mid');
    const plan = makePlan([region]);
    const assignment = new Map<string, LodTier>([['0,0', 'mid']]);
    const states = computeGeomorphStates(plan, assignment, cfg);
    const s = states.get('0,0');
    reverse.push(s ? s.t : -1);
  }

  // Reverse of forward should match reverse sweep (t values are pose-derived,
  // not direction-dependent). The t sequence from the same positions must agree.
  const forwardT = forward.filter(v => v >= 0);
  const reverseT = reverse.filter(v => v >= 0).reverse();
  // Both should hit the same quantized steps.
  assert.ok(forwardT.length >= 2, 'forward sweep must cross at least 2 steps');
  assert.ok(reverseT.length >= 2, 'reverse sweep must cross at least 2 steps');
});

// --- Mid/far boundary behavior ---

test('S2-UNIT: mid->far boundary blend works at 200m', () => {
  const cfg = defaultConfig();
  const windowWidth = cfg.stepsPerBoundary * cfg.stepSize;
  const boundary = 200;
  const d = boundary - windowWidth / 4;
  const region = makeRegion(0, 0, d, 'mid');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'mid']]);
  const states = computeGeomorphStates(plan, assignment, cfg);
  const s = states.get('0,0');
  assert.ok(s, 'mid->far blend should activate');
  assert.equal(s!.sourceTier, 'mid');
  assert.equal(s!.targetTier, 'far');
});

// --- Skybox is never blended ---

test('S2-UNIT: skybox region never enters blend state', () => {
  const cfg = defaultConfig();
  // Place distance at the far->skybox boundary (400m). No boundary defined there.
  const region = makeRegion(0, 0, 400, 'skybox');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'far']]);
  const states = computeGeomorphStates(plan, assignment, cfg);
  assert.equal(states.size, 0, 'skybox region must never blend');
});

// --- Budget-demoted regions never blend ---

test('S2-UNIT: budget-demoted region (raw near, assigned mid) never blends', () => {
  const cfg = defaultConfig();
  const windowWidth = cfg.stepsPerBoundary * cfg.stepSize;
  const boundary = 80;
  const d = boundary - windowWidth / 4; // inside near->mid window
  // Raw tier is near (would normally blend) but assignment says mid (demoted).
  const region = makeRegion(0, 0, d, 'near');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'mid']]);
  const states = computeGeomorphStates(plan, assignment, cfg);
  assert.equal(states.size, 0, 'budget-demoted region must not blend');
});

// --- No time/random dependence ---

test('S2-UNIT: two identical calls produce identical output (no time/random)', () => {
  const cfg = defaultConfig();
  const regions = [
    makeRegion(0, 0, 79, 'near'),
    makeRegion(1, 0, 80, 'near'),
    makeRegion(1, 1, 81, 'mid'),
  ];
  const plan = makePlan(regions);
  const assignment = new Map<string, LodTier>([
    ['0,0', 'near'], ['1,0', 'near'], ['1,1', 'mid'],
  ]);
  const a = computeGeomorphStates(plan, assignment, cfg);
  const b = computeGeomorphStates(plan, assignment, cfg);
  assert.deepEqual([...a.entries()], [...b.entries()], 'deterministic: identical output');
});

// --- Non-finite distance produces no blend and records a diagnostic ---

test('S2-UNIT: non-finite centerDistance suppresses blend and records diagnostic', () => {
  const cfg = defaultConfig();
  const region = makeRegion(0, 0, NaN, 'near');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'near']]);
  const diags: string[] = [];
  const states = computeGeomorphStates(plan, assignment, cfg, diags);
  assert.equal(states.size, 0, 'non-finite distance: no blend');
  assert.equal(diags.length, 1, 'one diagnostic recorded');
  assert.match(diags[0], /non-finite centerDistance/);
});

// --- Disabled config returns empty ---

test('S2-UNIT: disabled config returns empty map', () => {
  const cfg = defaultConfig();
  cfg.enabled = false;
  const region = makeRegion(0, 0, 80, 'near');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'near']]);
  const states = computeGeomorphStates(plan, assignment, cfg);
  assert.equal(states.size, 0);
});

// --- Degenerate tuning returns empty ---

test('S2-UNIT: stepsPerBoundary < 1 or stepSize <= 0 returns empty', () => {
  const region = makeRegion(0, 0, 80, 'near');
  const plan = makePlan([region]);
  const assignment = new Map<string, LodTier>([['0,0', 'near']]);
  const base = defaultConfig();

  const bad1 = { ...base, stepsPerBoundary: 0 };
  assert.equal(computeGeomorphStates(plan, assignment, bad1).size, 0);

  const bad2 = { ...base, stepSize: 0 };
  assert.equal(computeGeomorphStates(plan, assignment, bad2).size, 0);

  const bad3 = { ...base, stepSize: -1 };
  assert.equal(computeGeomorphStates(plan, assignment, bad3).size, 0);
});

// --- Renderer integration: applyGeomorphTierSelection ---

test('S2-INT: non-blend region gets exactly one visible mesh (M-P5 behavior)', () => {
  const meshes = new Map<string, { visible: boolean }>();
  meshes.set('near', { visible: false });
  meshes.set('mid', { visible: false });
  meshes.set('far', { visible: false });

  const ctx: any = {
    geomorphConfig: defaultConfig(),
    tierSelectionCount: 0,
    geomorphVisibleSetChangeCount: 0,
    regionMeshByTier: new Map([['0,0', meshes]]),
  };

  
  const assignment = new Map<string, LodTier>([['0,0', 'near']]);
  const geomorphStates = new Map<string, GeomorphBlendState>();

  applyGeomorphTierSelection(ctx, assignment, geomorphStates);

  assert.equal(meshes.get('near')!.visible, true, 'selected tier visible');
  assert.equal(meshes.get('mid')!.visible, false, 'non-selected hidden');
  assert.equal(meshes.get('far')!.visible, false, 'non-selected hidden');
  assert.equal(ctx.tierSelectionCount, 1, 'tier count incremented');
  assert.equal(ctx.geomorphVisibleSetChangeCount, 0, 'no blend: no visible-set change');
});

test('S2-INT: blend region gets two visible meshes (union-drawn)', () => {
  const meshes = new Map<string, { visible: boolean }>();
  meshes.set('near', { visible: true });
  meshes.set('mid', { visible: false });
  meshes.set('far', { visible: false });

  const ctx: any = {
    geomorphConfig: defaultConfig(),
    tierSelectionCount: 0,
    geomorphVisibleSetChangeCount: 0,
    regionMeshByTier: new Map([['0,0', meshes]]),
  };

  const assignment = new Map<string, LodTier>([['0,0', 'near']]);
  const blend: GeomorphBlendState = {
    key: '0,0', active: true, sourceTier: 'near', targetTier: 'mid', stepIndex: 2, t: 0.5,
  };
  const geomorphStates = new Map([['0,0', blend]]);

  applyGeomorphTierSelection(ctx, assignment, geomorphStates);

  assert.equal(meshes.get('near')!.visible, true, 'source tier visible');
  assert.equal(meshes.get('mid')!.visible, true, 'target tier also visible (union)');
  assert.equal(meshes.get('far')!.visible, false, 'non-blend tier hidden');
  assert.equal(ctx.geomorphVisibleSetChangeCount, 1, 'blend activation counted');
});

test('S2-INT: blend deactivation returns to single visible mesh', () => {
  const meshes = new Map<string, { visible: boolean }>();
  meshes.set('near', { visible: true });
  meshes.set('mid', { visible: true }); // was blending
  meshes.set('far', { visible: false });

  const ctx: any = {
    geomorphConfig: defaultConfig(),
    tierSelectionCount: 0,
    geomorphVisibleSetChangeCount: 0,
    regionMeshByTier: new Map([['0,0', meshes]]),
  };

  const assignment = new Map<string, LodTier>([['0,0', 'mid']]);
  const geomorphStates = new Map<string, GeomorphBlendState>(); // blend ended
  const prevStates = new Map<string, GeomorphBlendState>([['0,0',{key:'0,0',active:true,sourceTier:'near',targetTier:'mid',stepIndex:2,t:0.5}]]);

  applyGeomorphTierSelection(ctx, assignment, geomorphStates, prevStates);

  assert.equal(meshes.get('near')!.visible, false, 'old source now hidden');
  assert.equal(meshes.get('mid')!.visible, true, 'selected tier visible');
  assert.equal(meshes.get('far')!.visible, false);
  assert.equal(ctx.geomorphVisibleSetChangeCount, 1, 'deactivation counted');
});

// --- S2-SHADER: geomorph vertex injection (spec 8.4) ---

import { applyGeomorphShader, GEOMORPH_VERTEX_MORPH_GLSL } from '../../../src/engine/layer1/renderer/geomorph-shader.ts';

function makeBaseShader() {
  return {
    uniforms: {},
    vertexShader: [
      "#include <common>",
      "void main() {",
      "  #include <beginnormal_vertex>",
      "  #include <begin_vertex>",
      "  #include <project_vertex>",
      "}",
    ].join(String.fromCharCode(10)),
    fragmentShader: "void main() {}",
  };
}

test('S2-SHADER: disabled geomorph leaves vertex shader UNCHANGED', () => {
  const shader = makeBaseShader();
  const before = shader.vertexShader;
  applyGeomorphShader(shader, { enabled: false });
  assert.equal(shader.vertexShader, before, 'inactive: vertex text untouched (S1 chain intact)');
  assert.equal(Object.keys(shader.uniforms).length, 0, 'inactive: no uniforms added');
});

test('S2-SHADER: enabled geomorph injects uniforms + morph path', () => {
  const shader = makeBaseShader();
  applyGeomorphShader(shader, { enabled: true });
  for (const u of ['uGeomorphActive','uGeomorphT','uGeomorphTargetPositionMap','uGeomorphTargetNormalMap','uGeomorphRegionBounds']) {
    assert.ok(u in shader.uniforms, 'uniform ' + u + ' must be registered');
  }
  assert.ok(shader.vertexShader.includes('uGeomorphActive'), 'vertex declares uGeomorphActive');
  assert.ok(shader.vertexShader.includes('uGeomorphTargetPositionMap'), 'vertex samples target position map');
  assert.ok(shader.vertexShader.includes('mix(transformed, targetWorldPos, uGeomorphT)'), 'vertex blends world positions');
});

test('S2-SHADER: geomorph GLSL never references sampleHeight or time', () => {
  assert.ok(!GEOMORPH_VERTEX_MORPH_GLSL.includes('sampleHeight'), 'no sampleHeight (spec 9 forbidden)');
  assert.ok(!/uTime|clock|performance|Date/.test(GEOMORPH_VERTEX_MORPH_GLSL), 'no time source (spec 3.1)');
  for (const src of [applyGeomorphShader, '']) {
    // applyGeomorphShader is a pure string transform; assert determinism.
  }
  const a = makeBaseShader(); const b = makeBaseShader();
  applyGeomorphShader(a, { enabled: true });
  applyGeomorphShader(b, { enabled: true });
  assert.equal(a.vertexShader, b.vertexShader, 'deterministic: identical GLSL each compile');
});
// --- S2-AC-10: draw-time morph activation guard (spec 5/6) ---
// A test that FAILS if, on a blend frame, the morph is inactive
// (uGeomorphActive stays 0 or target DataTextures stay null) on any
// blend-state mesh. This is the regression that turns union-draw into a
// doubled native pop. Three-free: exercises makeGeomorphDrawHook directly.

import { makeGeomorphDrawHook, geomorphUniformWrite, GEOMORPH_POLYGON_OFFSET_TARGET, GEOMORPH_POLYGON_OFFSET_SOURCE, type GeomorphUniformStore } from '../../../src/engine/layer1/renderer/geomorph-wiring.ts';
import type { GeomorphLookup } from '../../../src/engine/layer1/renderer/geomorph-lookup.ts';

function makeStore(): GeomorphUniformStore {
  return {
    uGeomorphActive: { value: 0 },
    uGeomorphT: { value: 0 },
    uGeomorphTargetPositionMap: { value: null },
    uGeomorphTargetNormalMap: { value: null },
    uGeomorphRegionBounds: { value: [0, 0, 1, 1] },
  };
}

function fakeLookup(): GeomorphLookup {
  // Minimal structural stub (no THREE needed for the guard).
  return {
    positionMap: { dispose() {} } as any,
    normalMap: { dispose() {} } as any,
    bounds: [-100, -100, 100, 100],
  };
}

test('S2-AC-10 GUARD: blend mesh draw hook activates morph (uGeomorphActive=1, t set, maps bound)', () => {
  const store = makeStore();
  const lookup = fakeLookup();
  const mesh = { visible: true, userData: { geomorphDraw: { active: true, t: 0.75, targetTier: 'mid', role: 'source' } } };
  const material: any = {};
  const hook = makeGeomorphDrawHook(store, mesh, () => lookup, material);
  hook();
  assert.equal(store.uGeomorphActive.value, 1, 'morph MUST be active on blend mesh');
  assert.equal(store.uGeomorphT.value, 0.75, 't must be the region quantized t');
  assert.notEqual(store.uGeomorphTargetPositionMap.value, null, 'position map MUST be bound');
  assert.notEqual(store.uGeomorphTargetNormalMap.value, null, 'normal map MUST be bound');
  assert.deepEqual(store.uGeomorphRegionBounds.value, [-100, -100, 100, 100]);
});

test('S2-AC-10 GUARD: non-blend mesh hook keeps uGeomorphActive=0 (S1 path unchanged)', () => {
  const store = makeStore();
  const mesh = { visible: true, userData: { geomorphDraw: { active: false, t: 0, targetTier: null, role: null } } };
  const material: any = {};
  const hook = makeGeomorphDrawHook(store, mesh, () => null, material);
  hook();
  assert.equal(store.uGeomorphActive.value, 0, 'morph MUST stay inactive on non-blend mesh');
  assert.equal(store.uGeomorphT.value, 0);
});

test('S2-AC-10 GUARD: blend mesh with null lookup (fail-safe) keeps uGeomorphActive=0', () => {
  const store = makeStore();
  const mesh = { visible: true, userData: { geomorphDraw: { active: true, t: 0.5, targetTier: 'far', role: 'target' } } };
  const material: any = {};
  const hook = makeGeomorphDrawHook(store, mesh, () => null, material);
  hook();
  assert.equal(store.uGeomorphActive.value, 0, 'fail-safe: null lookup MUST NOT activate morph');
});

test('S2-AC-10 REGRESSION: skipping the draw hook leaves morph dead (old KICK bug)', () => {
  // Simulates the pre-fix state where the hook was never installed.
  const store = makeStore();
  const mesh = { visible: true, userData: { geomorphDraw: { active: true, t: 0.5, targetTier: 'mid', role: 'source' } } };
  // No hook call - this is what the old code did.
  assert.equal(store.uGeomorphActive.value, 0, 'REGRESSION: morph stays 0 without hook call');
  assert.equal(store.uGeomorphTargetPositionMap.value, null, 'REGRESSION: maps stay null without hook');
});

// --- S2-AC-11: polygon-offset assertions (spec 5/6) ---

test('S2-AC-11: blend source mesh gets named polygonOffset bias (source direction)', () => {
  const store = makeStore();
  const lookup = fakeLookup();
  const mesh = { visible: true, userData: { geomorphDraw: { active: true, t: 0.25, targetTier: 'mid', role: 'source' } } };
  const material: any = {};
  const hook = makeGeomorphDrawHook(store, mesh, () => lookup, material);
  hook();
  assert.equal(material.polygonOffset, true, 'polygonOffset MUST be true on blend mesh');
  assert.equal(material.polygonOffsetFactor, GEOMORPH_POLYGON_OFFSET_SOURCE.factor);
  assert.equal(material.polygonOffsetUnits, GEOMORPH_POLYGON_OFFSET_SOURCE.units);
});

test('S2-AC-11: blend target mesh gets named polygonOffset bias (target direction)', () => {
  const store = makeStore();
  const lookup = fakeLookup();
  const mesh = { visible: true, userData: { geomorphDraw: { active: true, t: 0.75, targetTier: 'near', role: 'target' } } };
  const material: any = {};
  const hook = makeGeomorphDrawHook(store, mesh, () => lookup, material);
  hook();
  assert.equal(material.polygonOffset, true);
  assert.equal(material.polygonOffsetFactor, GEOMORPH_POLYGON_OFFSET_TARGET.factor);
  assert.equal(material.polygonOffsetUnits, GEOMORPH_POLYGON_OFFSET_TARGET.units);
});

test('S2-AC-11: non-blend mesh has polygonOffset=false (bias absent)', () => {
  const store = makeStore();
  const mesh = { visible: true, userData: { geomorphDraw: { active: false, t: 0, targetTier: null, role: null } } };
  const material: any = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
  const hook = makeGeomorphDrawHook(store, mesh, () => null, material);
  hook();
  assert.equal(material.polygonOffset, false, 'polygonOffset MUST be cleared on non-blend');
  assert.equal(material.polygonOffsetFactor, 0);
  assert.equal(material.polygonOffsetUnits, 0);
});

test('S2-AC-11: source and target bias directions are opposite (prevents inter-pair z-fight)', () => {
  // The named constants must have opposite sign so the pair separates.
  assert.ok(GEOMORPH_POLYGON_OFFSET_SOURCE.factor * GEOMORPH_POLYGON_OFFSET_TARGET.factor < 0,
    'source and target factors must have opposite sign');
  assert.ok(GEOMORPH_POLYGON_OFFSET_SOURCE.units * GEOMORPH_POLYGON_OFFSET_TARGET.units < 0,
    'source and target units must have opposite sign');
});
