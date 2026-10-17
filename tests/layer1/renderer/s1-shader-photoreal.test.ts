/*
 * S1 shader-side photorealism (spec docs/spec-s1-shader-photorealism.md 9.1).
 *
 * Browser-free, GPU-free. Three families:
 *   S1-GUARD  the generated GLSL replaces the normal-map hook (closes the
 *             discard gap), declares the new varyings, and contains the triplanar
 *             branch. This is the regression guard: if someone re-introduces
 *             `#include <normal_fragment_maps>` (i.e. blendedNormal defined but
 *             never consumed), this test fails.
 *   S1-FLAT   the per-fragment splat refinement reduces to the vertex weights
 *             bit-for-bit on flat ground and at zero amplitude (9.3 flatness
 *             guard), and preserves the partition on steep ground.
 *   S1-DET    the renderer's region + triangle counts are identical across two
 *             independent builds and stable across a camera sweep, proving S1
 *             adds zero geometry-cert impact (L1-AC-152/153 posture).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerrainLayer } from "../../../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../../../src/engine/layer1/renderer/terrain-renderer.ts";
import {
  applyPhotorealShader,
  refineSurfaceWeights,
  triplanarAxisWeights,
  tileScaleForUniform,
} from "../../../src/engine/layer1/renderer/shader-photoreal.ts";

// --- S1-GUARD: generated GLSL closes the discard gap -------------------

// A synthetic shader carrying the exact base tokens the shipped terrain
// material produces (the base onBeforeCompile output). applyPhotorealShader is
// the compile-time transform; asserting on its output certifies the shipped
// GLSL without a WebGL context.
function makeBaseShader() {
  return {
    uniforms: {},
    vertexShader: [
      "#include <common>",
      "attribute vec4 aMaterialWeights;",
      "varying vec4 vSurfaceWeights;",
      "varying vec2 vWorldUv;",
      "void main() {",
      "  #include <beginnormal_vertex>",
      "  #include <begin_vertex>",
      "  vWorldUv = position.xz * 0.05;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "#include <common>",
      "uniform vec3 uSurfColor0;",
      "vec3 blendedAlbedo(vec2 uvw) { return vec3(0.0); }",
      "float blendedRoughness(vec2 uvw) { return 0.9; }",
      "float blendedAO(vec2 uvw) { return 1.0; }",
      "vec3 blendedNormal(vec2 uvw) { return vec3(0.5,0.5,1.0); }",
      "float snowWeight() { return 0.0; }",
      "void main() {",
      "  diffuseColor.rgb *= blendedAlbedo(vWorldUv);",
      "  diffuseColor.rgb *= mix(0.6, 1.0, blendedAO(vWorldUv));",
      "  roughnessFactor = blendedRoughness(vWorldUv);",
      "  #include <normal_fragment_begin>",
      "  #include <normal_fragment_maps>",
      "}",
    ].join("\n"),
  } as any;
}

test("S1-GUARD: normal-map hook is replaced (discard gap closed) + varyings + triplanar branch", () => {
  const shader = makeBaseShader();
  applyPhotorealShader(shader, { tileScales: [2, 2, 2, 2, 2] });

  // Regression guard: the standard normal-map chunk must be GONE (it was the
  // discard gap - blendedNormal was defined but never consumed).
  assert.ok(
    !shader.fragmentShader.includes("#include <normal_fragment_maps>"),
    "normal_fragment_maps hook must be replaced, not left to discard the normal",
  );
  // The replacement must actually assign a perturbed world normal into view space.
  assert.ok(
    shader.fragmentShader.includes("phTriNormalTangent()"),
    "normal hook must sample the triplanar tangent normal",
  );
  assert.ok(
    shader.fragmentShader.includes("phPerturbNormal") &&
      shader.fragmentShader.includes("viewMatrix * vec4(phPerturbedWorld"),
    "normal hook must build the TBN and rotate into view space",
  );
  // Triplanar branch exists with the cheap planar short-circuit (6.5).
  assert.ok(
    shader.fragmentShader.includes("phTriTex") &&
      shader.fragmentShader.includes("slope < uTriplanarStart"),
    "triplanar sampler with planar branch must exist",
  );
  // New varyings declared (shader varyings, not attributes - 5.5).
  assert.ok(
    shader.vertexShader.includes("varying vec3 vWorldPos") &&
      shader.vertexShader.includes("varying vec3 vWorldNormal"),
    "world pos + world normal varyings must be declared",
  );
  assert.ok(
    !shader.vertexShader.includes("attribute vec3 vWorldPos") &&
      !shader.vertexShader.includes("attribute vec3 vWorldNormal"),
    "world pos/normal must be varyings, never new vertex attributes",
  );
  // Base albedo/roughness calls rewired to the triplanar variants.
  assert.ok(
    shader.fragmentShader.includes("phTriAlbedo()") &&
      !shader.fragmentShader.includes("blendedAlbedo(vWorldUv)"),
    "albedo call must be rewired to the triplanar path",
  );
});

test("S1-GUARD: applyPhotorealShader is deterministic (same input -> identical output)", () => {
  const a = makeBaseShader();
  const b = makeBaseShader();
  applyPhotorealShader(a, { tileScales: [2, 2, 2, 2, 2] });
  applyPhotorealShader(b, { tileScales: [2, 2, 2, 2, 2] });
  assert.equal(a.fragmentShader, b.fragmentShader);
  assert.equal(a.vertexShader, b.vertexShader);
});

// --- S1-FLAT: refinement reduces to vertex weights on flat ground -------

test("S1-FLAT: refineSurfaceWeights is bit-identical to input on flat ground", () => {
  const w: [number, number, number, number] = [0.2, 0.3, 0.4, 0.1];
  // Flat ground: world normal +Y (slope 0), no convexity.
  const out = refineSurfaceWeights(w[0], w[1], w[2], w[3], 1, 0, 0);
  assert.deepEqual(out, w, "flat ground must not perturb the vertex weights");
});

test("S1-FLAT: zero amplitude disables refinement for any slope", () => {
  const w: [number, number, number, number] = [0.2, 0.3, 0.4, 0.1];
  const out = refineSurfaceWeights(w[0], w[1], w[2], w[3], 0.2, 0.6, 0.3, 0);
  assert.deepEqual(out, w, "amount=0 must return the input unchanged");
});

test("S1-FLAT: refinement preserves the partition and sheds toward rock on slopes", () => {
  // Steep, convex ground: slope high, normalXZ large.
  const w: [number, number, number, number] = [0.3, 0.1, 0.4, 0.2];
  const out = refineSurfaceWeights(w[0], w[1], w[2], w[3], 0.1, 0.7, 0.7, 0.28);
  const inSum = w[0] + w[1] + w[2] + w[3];
  const outSum = out[0] + out[1] + out[2] + out[3];
  assert.ok(Math.abs(inSum - outSum) < 1e-9, "partition sum preserved (5.1)");
  assert.ok(out.every((v) => v >= 0), "weights stay non-negative (5.1)");
  assert.ok(out[1] > w[1], "rock (index 1) gains weight on steep ground (5.3)");
  assert.ok(out[0] < w[0] && out[2] < w[2], "sand/grass shed toward rock (5.3)");
});

test("S1-FLAT: tile scale mirrors 1/tileMeters and clamps malformed input", () => {
  assert.equal(tileScaleForUniform(2), 0.5);
  assert.equal(tileScaleForUniform(4), 0.25);
  // Malformed -> fallback 2 m -> 0.5, never NaN/Infinity/0.
  assert.equal(tileScaleForUniform(null), 0.5);
  assert.equal(tileScaleForUniform(Number.NaN), 0.5);
  assert.ok(Number.isFinite(tileScaleForUniform(1e12)) && tileScaleForUniform(1e12) > 0);
});

test("S1-FLAT: triplanar axis weights normalize to sum 1 and fall back to +Y on degenerate normal", () => {
  const flat = triplanarAxisWeights(0, 1, 0);
  assert.deepEqual(flat, [0, 1, 0], "flat normal -> dominant Y projection");
  const wall = triplanarAxisWeights(1, 0, 0);
  assert.deepEqual(wall, [1, 0, 0], "X-facing wall -> dominant X projection");
  const degenerate = triplanarAxisWeights(0, 0, 0);
  assert.deepEqual(degenerate, [0, 1, 0], "degenerate normal -> Y fallback (no div0)");
  const mix = triplanarAxisWeights(0.7, 0.5, 0.5);
  assert.ok(Math.abs(mix[0] + mix[1] + mix[2] - 1) < 1e-9, "weights sum to 1");
});

// --- S1-DET: zero geometry-cert impact ---------------------------------

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}
function makeTerrain() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: "alpine", seed: 1337 });
  t.generate();
  return t;
}
const POSE = { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 };

function regionSignature(r: any) {
  const regions = r.getLodRegions();
  const rs = (r as any).renderStats();
  return {
    count: regions.length,
    tiers: regions.map((g: any) => g.tier).join(","),
    built: rs.built,
    drawn: rs.drawn,
    meshes: rs.meshes,
  };
}

test("S1-DET: region + triangle counts are identical across two independent builds", () => {
  const a = createTerrainRenderer({ terrain: makeTerrain(), canvas: makeCanvas() });
  const b = createTerrainRenderer({ terrain: makeTerrain(), canvas: makeCanvas() });
  a.setCamera(POSE);
  b.setCamera(POSE);
  assert.deepEqual(regionSignature(a), regionSignature(b), "S1 build is deterministic");
  a.dispose();
  b.dispose();
});

test("S1-DET: S1 adds no rebuild trigger across a camera sweep (P-AC-09 posture)", () => {
  const t = makeTerrain();
  const r = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  const st = () => (r as any).rebuildStats();
  r.setCamera(POSE);
  const cold = st().rebuildCount;
  for (const pose of [
    { x: 0, y: 20, z: 0, targetX: 0, targetY: 0, targetZ: 0 },
    { x: 0, y: 400, z: 600, targetX: 0, targetY: 0, targetZ: 0 },
    { x: 0, y: 80, z: 120, targetX: 0, targetY: 0, targetZ: 0 },
  ]) {
    r.setCamera(pose);
  }
  assert.equal(st().rebuildCount, cold, "S1 must not add a rebuild trigger on camera move");
  r.dispose();
});
