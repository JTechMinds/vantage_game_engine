// S1 - shader-side photorealism primitives (spec docs/spec-s1-shader-photorealism.md).
//
// This module is the pure, GPU-agnostic heart of slice S1. It holds:
//   (1) deterministic TypeScript mirrors of the scalar math the injected GLSL
//       performs (triplanar axis weights, splat-weight refinement, tile-scale
//       calibration) - the numeric source of truth, assertable in CI with no
//       WebGL context (spec 9.1 flatness + determinism guards);
//   (2) the GLSL string fragments + a pure shader-transform
//       (applyPhotorealShader) that buildTerrainMaterial composes into the
//       MeshStandardMaterial onBeforeCompile chain: per-fragment splat
//       refinement, triplanar projection, and the terrain normal-map hook that
//       CLOSES the discard gap (blendedNormal was defined but never consumed).
//
// Hard constraints honored here (spec 12): no geometry, no new vertex attribute,
// no change to materialWeightsAt / computeMaterialWeightAttribute / aMaterial-
// Weights, no change to the public renderer surface. The refinement reduces to
// the vertex weights exactly on flat ground (slope=0, curvature=0), so a flat
// region is bit-identical to the pre-S1 blend (spec 5.1 / 9.3 flatness guard).
//
// Everything is appearance-only math derived from world pos + world normal +
// biome bands + uniforms. No Math.random, no clock, no object identity on either
// the CPU or GPU side (spec 9.1 determinism).

// --- Tuned constants (spec 14/15 latitude; provisional values) ---

// Triplanar axis sharpness (spec 6.2, OQ-2). pow(abs(N), k) then normalize.
export const TRIPLANAR_SHARPNESS = 4.0;

// Tangent-space normal-map strength (spec 7.1, OQ-4). Uniform-tunable.
export const DEFAULT_NORMAL_SCALE = 0.8;

// Amplitude of the per-fragment splat refinement (spec 5.4, OQ-3). Must stay
// <= 0.35 so it softens transitions rather than carving new ones, and it is
// multiplied by a slope/curvature envelope so it vanishes on flat ground.
export const DEFAULT_BLEND_DETAIL = 0.28;

// Slope above which triplanar kicks in (spec 6.5, OQ-5). Gentle ground keeps
// the cheap single-planar path.
export const DEFAULT_TRIPLANAR_START = 0.45;

// Slope shed band, mirrored from materials.ts materialWeightsAt shed =
// smoothstep(0.5, 0.85, sl) so CPU and GPU agree (spec 5.3 / 5.6).
export const SHED_SLOPE_LO = 0.5;
export const SHED_SLOPE_HI = 0.85;

// Per-surface tile size clamp (spec 6.4). A malformed manifest tileMeters can
// never produce a NaN/0 UV.
export const MIN_TILE_METERS = 0.25;
export const MAX_TILE_METERS = 64.0;
const DEFAULT_TILE_METERS_FALLBACK = 2.0;

// --- Pure scalar math (TS mirrors of the GLSL) ---

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstepMirror(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

// Clamp a physical tile size to a safe range (spec 6.4).
export function clampTileMeters(tileMeters: number | null | undefined): number {
  if (typeof tileMeters !== "number" || !Number.isFinite(tileMeters)) {
    return DEFAULT_TILE_METERS_FALLBACK;
  }
  return Math.min(MAX_TILE_METERS, Math.max(MIN_TILE_METERS, tileMeters));
}

// uSurfTileScale{i} = 1 / tileMeters. A 2 m tile tiles every 2 m of world space
// (spec 6.4). Deterministic and finite for all inputs (S1 tile-scale guard).
export function tileScaleForUniform(tileMeters: number | null | undefined): number {
  return 1.0 / clampTileMeters(tileMeters);
}

// Triplanar axis weights for a world-space normal: pow(abs(n_axis), sharpness)
// then normalized to sum 1 (spec 6.2). Degenerate normal falls back to +Y so
// flat ground reduces cleanly to the XZ projection with no divide-by-zero. The
// returned triple is [wX, wY, wZ] for the (ZY, XZ, XY) planar projections.
export function triplanarAxisWeights(
  nx: number,
  ny: number,
  nz: number,
  sharpness: number = TRIPLANAR_SHARPNESS,
): [number, number, number] {
  const wx = Math.pow(Math.abs(nx), sharpness);
  const wy = Math.pow(Math.abs(ny), sharpness);
  const wz = Math.pow(Math.abs(nz), sharpness);
  const sum = wx + wy + wz;
  if (sum <= 1e-6) return [0, 1, 0];
  return [wx / sum, wy / sum, wz / sum];
}

// Per-fragment splat refinement (spec 5.1 / 5.3 / 9.3). Modulates the coarse
// vertex weights by a small signed term driven by the FRAGMENT slope and
// convexity, so a transition that lands mid-triangle reads smooth and steep
// ground sheds toward rock, then renormalizes to preserve the partition.
//
//   slope    = 1 - clamp01(normalY)             (matches vertex slope)
//   convex   = length(normalXZ)                 (curvature proxy, 0 on flat)
//   shed     = smoothstep(SHED_LO, SHED_HI, slope)
//   detail   = amplitude * shed * (1 + convex)  (0 when slope=0 => flat guard)
//   rock    gets +detail, sand/grass/soil get -detail/3, snow untouched
//   w_i' = max(0, w_i * (1 + d_i)); rescale packed sum to original sum.
//
// amount <= 0 OR flat ground (slope=0 => shed=0 => detail=0) returns the input
// bit-for-bit. Pure: no clock, no identity, no random.
export function refineSurfaceWeights(
  w0: number,
  w1: number,
  w2: number,
  w3: number,
  normalY: number,
  normalX: number,
  normalZ: number,
  amount: number = DEFAULT_BLEND_DETAIL,
): [number, number, number, number] {
  if (amount <= 0) return [w0, w1, w2, w3];
  const slope = 1 - clamp01(normalY);
  const convex = Math.sqrt(
    Math.max(0, normalX * normalX + normalZ * normalZ),
  );
  const shed = smoothstepMirror(SHED_SLOPE_LO, SHED_SLOPE_HI, slope);
  const detail = amount * shed * (1 + convex);
  if (detail <= 0) return [w0, w1, w2, w3];
  const clamp = (v: number) => Math.max(0, v);
  // w1 is rock (the shed target); w0 sand, w2 grass, w3 soil shed toward it.
  const a = clamp(w0 * (1 - detail / 3));
  const b = clamp(w1 * (1 + detail));
  const c = clamp(w2 * (1 - detail / 3));
  const d = clamp(w3 * (1 - detail / 3));
  const origSum = w0 + w1 + w2 + w3;
  const newSum = a + b + c + d;
  if (origSum > 1e-6 && newSum > 1e-6) {
    const k = origSum / newSum;
    return [a * k, b * k, c * k, d * k];
  }
  return [w0, w1, w2, w3];
}

// --- GLSL fragments (composed into MeshStandardMaterial onBeforeCompile) ---

// Options that reach the shader transform. All numeric; deterministic.
export interface PhotorealShaderOptions {
  // Per-surface tile scale (uSurfTileScale{i} = 1/tileMeters), index order
  // matches surfaces[] = sand,rock,grass,soil,snow.
  tileScales: number[];
  normalScale?: number;
  blendDetail?: number;
  triplanarStart?: number;
  heightMin?: number;
  heightMax?: number;
}

// Fragment common block: new varyings, uniforms, the triplanar sampler (with a
// cheap planar branch on gentle ground - spec 6.5), the per-fragment splat
// refinement (mirror of refineSurfaceWeights), and the derivative-built TBN
// perturbation (perturbNormal2Arb - spec 7.2). Reuses the existing HAS_* / map
// uniforms; adds only varyings + scalar uniforms, never an attribute.
export const PHOTOREAL_COMMON_GLSL = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  uniform float uNormalScale;
  uniform float uBlendDetail;
  uniform float uTriplanarStart;
  uniform float uSurfTileScale0;
  uniform float uSurfTileScale1;
  uniform float uSurfTileScale2;
  uniform float uSurfTileScale3;
  uniform float uSurfTileScale4;

  // Mirror of refineSurfaceWeights() (TS). Reduces to w on flat ground.
  vec4 phRefinedWeights(vec4 w, vec3 n) {
    if (uBlendDetail <= 0.0) return w;
    float slope = 1.0 - clamp(n.y, 0.0, 1.0);
    float convex = length(n.xz);
    float shed = smoothstep(0.5, 0.85, slope);
    float detail = uBlendDetail * shed * (1.0 + convex);
    if (detail <= 0.0) return w;
    float orig = w.x + w.y + w.z + w.w;
    vec4 r;
    r.x = max(0.0, w.x * (1.0 - detail / 3.0));
    r.y = max(0.0, w.y * (1.0 + detail));
    r.z = max(0.0, w.z * (1.0 - detail / 3.0));
    r.w = max(0.0, w.w * (1.0 - detail / 3.0));
    float ns = r.x + r.y + r.z + r.w;
    if (orig > 1e-6 && ns > 1e-6) r *= orig / ns;
    return r;
  }

  // Triplanar sample of one map. Gentle ground (slope < uTriplanarStart) takes
  // the single-planar path (cheap, and identical to the pre-S1 blend on flat
  // ground - spec 6.5 + 9.3). Steep ground blends the three axis projections
  // weighted by pow(abs(N), 4) (spec 6.2).
  vec3 phTriTex(sampler2D tex, float scale) {
    float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);
    vec2 su = vWorldPos.xz * scale;
    if (slope < uTriplanarStart) {
      return texture2D(tex, su).rgb;
    }
    vec3 wp = pow(abs(vWorldNormal), vec3(4.0));
    wp /= (wp.x + wp.y + wp.z + 1e-6);
    vec3 suv = vWorldPos * scale;
    vec3 cx = texture2D(tex, suv.zy).rgb;
    vec3 cy = texture2D(tex, suv.xz).rgb;
    vec3 cz = texture2D(tex, suv.xy).rgb;
    return cx * wp.x + cy * wp.y + cz * wp.z;
  }

  // Derivative-built TBN perturbation (perturbNormal2Arb, spec 7.2/7.3). No
  // tangent attribute. Respects gl_FrontFacing so relief reads on both faces.
  vec3 phPerturbNormal(vec3 nrm, vec3 tangentN) {
    vec3 dp1 = dFdx(vWorldPos);
    vec3 dp2 = dFdy(vWorldPos);
    vec3 dn1 = dFdx(vWorldNormal);
    vec3 dn2 = dFdy(vWorldNormal);
    float det = dn1.x * dn2.y - dn2.x * dn1.y;
    vec3 T;
    if (abs(det) < 1e-6) {
      vec3 a = abs(nrm.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
      T = normalize(cross(a, nrm));
    } else {
      float idet = 1.0 / det;
      vec3 r1 = cross(dn2, dp1);
      vec3 r2 = cross(dp2, dn1);
      T = (dn2.y * r1 - dn1.y * r2) * idet;
    }
    vec3 B = cross(nrm, T);
    float faceDir = gl_FrontFacing ? 1.0 : -1.0;
    T *= faceDir;
    tangentN.xy *= uNormalScale;
    return normalize(T * tangentN.x + B * tangentN.y + nrm * tangentN.z);
  }

  vec3 phTriAlbedo() {
    vec4 w = phRefinedWeights(vSurfaceWeights, vWorldNormal);
    float snow = clamp(1.0 - dot(w, vec4(1.0)), 0.0, 1.0);
    vec3 c0 = uSurfColor0, c1 = uSurfColor1, c2 = uSurfColor2, c3 = uSurfColor3, c4 = uSurfColor4;
    #ifdef HAS_ALBEDO_0
    c0 = phTriTex(uSurfAlbedo0, uSurfTileScale0);
    #endif
    #ifdef HAS_ALBEDO_1
    c1 = phTriTex(uSurfAlbedo1, uSurfTileScale1);
    #endif
    #ifdef HAS_ALBEDO_2
    c2 = phTriTex(uSurfAlbedo2, uSurfTileScale2);
    #endif
    #ifdef HAS_ALBEDO_3
    c3 = phTriTex(uSurfAlbedo3, uSurfTileScale3);
    #endif
    #ifdef HAS_ALBEDO_4
    c4 = phTriTex(uSurfAlbedo4, uSurfTileScale4);
    #endif
    vec3 a = vec3(0.0);
    a += c0 * w.x; a += c1 * w.y; a += c2 * w.z; a += c3 * w.w; a += c4 * snow;
    return a;
  }

  float phTriRough() {
    vec4 w = phRefinedWeights(vSurfaceWeights, vWorldNormal);
    float snow = clamp(1.0 - dot(w, vec4(1.0)), 0.0, 1.0);
    float r0 = 0.9, r1 = 0.9, r2 = 0.9, r3 = 0.9, r4 = 0.9;
    #ifdef HAS_ROUGH_0
    r0 = phTriTex(uSurfRough0, uSurfTileScale0).r;
    #endif
    #ifdef HAS_ROUGH_1
    r1 = phTriTex(uSurfRough1, uSurfTileScale1).r;
    #endif
    #ifdef HAS_ROUGH_2
    r2 = phTriTex(uSurfRough2, uSurfTileScale2).r;
    #endif
    #ifdef HAS_ROUGH_3
    r3 = phTriTex(uSurfRough3, uSurfTileScale3).r;
    #endif
    #ifdef HAS_ROUGH_4
    r4 = phTriTex(uSurfRough4, uSurfTileScale4).r;
    #endif
    float r = 0.0;
    r += r0 * w.x; r += r1 * w.y; r += r2 * w.z; r += r3 * w.w; r += r4 * snow;
    return r;
  }

  float phTriAO() {
    vec4 w = phRefinedWeights(vSurfaceWeights, vWorldNormal);
    float snow = clamp(1.0 - dot(w, vec4(1.0)), 0.0, 1.0);
    float a0 = 1.0, a1 = 1.0, a2 = 1.0, a3 = 1.0, a4 = 1.0;
    #ifdef HAS_AO_0
    a0 = phTriTex(uSurfAO0, uSurfTileScale0).r;
    #endif
    #ifdef HAS_AO_1
    a1 = phTriTex(uSurfAO1, uSurfTileScale1).r;
    #endif
    #ifdef HAS_AO_2
    a2 = phTriTex(uSurfAO2, uSurfTileScale2).r;
    #endif
    #ifdef HAS_AO_3
    a3 = phTriTex(uSurfAO3, uSurfTileScale3).r;
    #endif
    #ifdef HAS_AO_4
    a4 = phTriTex(uSurfAO4, uSurfTileScale4).r;
    #endif
    float ao = 0.0;
    ao += a0 * w.x; ao += a1 * w.y; ao += a2 * w.z; ao += a3 * w.w; ao += a4 * snow;
    return ao;
  }

  // Triplanar-blended tangent-space normal (spec 7.1). Consumed by the normal
  // hook below - this is the discard-gap close.
  vec3 phTriNormalTangent() {
    vec4 w = phRefinedWeights(vSurfaceWeights, vWorldNormal);
    float snow = clamp(1.0 - dot(w, vec4(1.0)), 0.0, 1.0);
    vec3 n0 = vec3(0.5, 0.5, 1.0), n1 = vec3(0.5, 0.5, 1.0), n2 = vec3(0.5, 0.5, 1.0), n3 = vec3(0.5, 0.5, 1.0), n4 = vec3(0.5, 0.5, 1.0);
    #ifdef HAS_NORMAL_0
    n0 = phTriTex(uSurfNormal0, uSurfTileScale0);
    #endif
    #ifdef HAS_NORMAL_1
    n1 = phTriTex(uSurfNormal1, uSurfTileScale1);
    #endif
    #ifdef HAS_NORMAL_2
    n2 = phTriTex(uSurfNormal2, uSurfTileScale2);
    #endif
    #ifdef HAS_NORMAL_3
    n3 = phTriTex(uSurfNormal3, uSurfTileScale3);
    #endif
    #ifdef HAS_NORMAL_4
    n4 = phTriTex(uSurfNormal4, uSurfTileScale4);
    #endif
    vec3 n = vec3(0.0);
    n += n0 * w.x; n += n1 * w.y; n += n2 * w.z; n += n3 * w.w; n += n4 * snow;
    return n * 2.0 - 1.0;
  }
`;

// Normal hook that replaces <normal_fragment_maps>. Builds the perturbed WORLD
// normal from the triplanar tangent normal, then rotates it into view space so
// the existing IBL/HDRI lighting keeps working (spec 7.1/7.2).
export const PHOTOREAL_NORMAL_HOOK_GLSL = /* glsl */ `
  vec3 phTangentN = phTriNormalTangent();
  vec3 phPerturbedWorld = phPerturbNormal(vWorldNormal, phTangentN);
  normal = normalize((viewMatrix * vec4(phPerturbedWorld, 0.0)).xyz);
`;

// Apply the S1 photoreal pass to an already-chunked shader (call AFTER the
// base albedo/roughness injection so the map/roughness includes already exist).
// Pure string transform; deterministic; no side effects beyond shader text.
export function applyPhotorealShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> },
  opts: PhotorealShaderOptions,
): void {
  const normalScale = opts.normalScale ?? DEFAULT_NORMAL_SCALE;
  const blendDetail = opts.blendDetail ?? DEFAULT_BLEND_DETAIL;
  const triplanarStart = opts.triplanarStart ?? DEFAULT_TRIPLANAR_START;

  shader.uniforms.uNormalScale = { value: normalScale };
  shader.uniforms.uBlendDetail = { value: blendDetail };
  shader.uniforms.uTriplanarStart = { value: triplanarStart };
  for (let i = 0; i < 5; i++) {
    shader.uniforms[`uSurfTileScale${i}`] = {
      value: tileScaleForUniform(opts.tileScales[i] ?? DEFAULT_TILE_METERS_FALLBACK),
    };
  }

  // Vertex: world pos + world normal varyings from matrices THREE already
  // exposes (no new attribute - spec 5.5). objectNormal is set by
  // <beginnormal_vertex>; transformed by <begin_vertex>.
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\n  varying vec3 vWorldPos;\n  varying vec3 vWorldNormal;",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    )
    .replace(
      "#include <beginnormal_vertex>",
      "#include <beginnormal_vertex>\n  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);",
    );

  // Fragment: add the photoreal common block, rewire map/roughness to triplanar,
  // and close the discard gap by replacing the normal-map hook.
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "float snowWeight() {",
      PHOTOREAL_COMMON_GLSL + "\n  float snowWeight() {",
    )
    .replace("blendedAlbedo(vWorldUv)", "phTriAlbedo()")
    .replace("blendedAO(vWorldUv)", "phTriAO()")
    .replace("blendedRoughness(vWorldUv)", "phTriRough()")
    .replace("#include <normal_fragment_maps>", PHOTOREAL_NORMAL_HOOK_GLSL);
}
