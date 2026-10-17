/*
 * S2 geomorphing — vertex-shader blend injection.
 * spec-layer1-geomorphing-s2.md §4.6 / §4.7 / §4.8 / §4.9.
 *
 * Pure GLSL string fragments + a deterministic shader transform
 * (applyGeomorphShader) that buildTerrainMaterial composes into the
 * MeshStandardMaterial onBeforeCompile chain AFTER the S1 photoreal pass.
 *
 * Per-mesh uniforms are set via mesh.onBeforeRender (§4.9). The shared
 * material is never cloned; the geomorph state is a per-draw-call uniform.
 *
 * Hard constraints (spec §4.6, §9, §11):
 * - Inactive (uGeomorphActive < 0.5): vertex transformation UNCHANGED.
 * - Active: sample opposite-tier world position/normal from lookup maps, mix by t.
 * - No sampleHeight, no terrain state read, no time dependency.
 * - No public API surface (spec §10).
 * - S1 shader chain remains intact (S2 injects AFTER S1).
 *
 * Terrain meshes live in world space (terrainGroup at origin, no per-mesh
 * transform), so `transformed` from <begin_vertex> IS the world position.
 * The lookup map stores the opposite tier's WORLD position directly; the
 * blend operates in world space and <project_vertex> projects the result.
 */

// --- Tuned constants (spec §4.3, §4.8 provisional) ---

/** Polygon offset to reduce z-fighting during blend (§4.8). */
export const GEOMORPH_POLYGON_OFFSET_FACTOR = -1.0;
export const GEOMORPH_POLYGON_OFFSET_UNITS = -1.0;

// --- GLSL vertex fragments ---

/**
 * Vertex common block: uniforms + helpers. Injected into #include <common>
 * (before the vertex body). When uGeomorphActive < 0.5 the morph path is
 * skipped entirely (§4.6 step 1) so inactive meshes render bit-identically.
 */
export const GEOMORPH_VERTEX_COMMON_GLSL = /* glsl */ `
  uniform float uGeomorphActive;
  uniform float uGeomorphT;
  uniform sampler2D uGeomorphTargetPositionMap;
  uniform sampler2D uGeomorphTargetNormalMap;
  uniform vec4 uGeomorphRegionBounds; // xMin, zMin, xMax, zMax

  // Map a world-space xz to region-local [0,1] uv for the lookup texture.
  vec2 geomorphUV(vec3 worldPos) {
    vec2 lo = uGeomorphRegionBounds.xy;
    vec2 hi = uGeomorphRegionBounds.zw;
    vec2 span = hi - lo;
    span = max(span, vec2(1e-6));
    return clamp((worldPos.xz - lo) / span, 0.0, 1.0);
  }
`;

/**
 * Vertex morph: injected AFTER #include <begin_vertex> so `transformed`
 * holds the world-space position (terrainGroup is at origin; modelMatrix
 * is identity). Samples the opposite tier's world position from the lookup
 * map at the same world xz, blends by uGeomorphT, and leaves the result for
 * <project_vertex> to apply the view-projection (§4.6 steps 2-5).
 *
 * Normal blend uses uGeomorphTargetNormalMap which stores the target tier's
 * world-space normal encoded as (normal * 0.5 + 0.5).
 */
export const GEOMORPH_VERTEX_MORPH_GLSL = /* glsl */ `
  if (uGeomorphActive > 0.5) {
    vec2 guv = geomorphUV(transformed);
    // Lookup map stores the opposite tier's WORLD position directly.
    vec3 targetWorldPos = texture2D(uGeomorphTargetPositionMap, guv).rgb;
    // Blend world positions (§4.6 step 3).
    transformed = mix(transformed, targetWorldPos, uGeomorphT);

    // Normal blend (§4.6 step 4): decode from [0,1] to [-1,1].
    vec3 targetWorldN = texture2D(uGeomorphTargetNormalMap, guv).rgb * 2.0 - 1.0;
    // objectNormal is set by <beginnormal_vertex> which runs BEFORE
    // <begin_vertex>. Blend it toward the target tier's normal.
    objectNormal = normalize(mix(objectNormal, targetWorldN, uGeomorphT));
  }
`;

// --- Options ---

export interface GeomorphShaderOptions {
  /** Whether geomorphing is globally enabled (false = no injection at all). */
  enabled: boolean;
  /** Optional pre-created per-draw uniform store to bind, so the renderer's
   *  onBeforeRender mutates the SAME objects three.js reads at setProgram. */
  uniforms?: {
    uGeomorphActive: { value: unknown };
    uGeomorphT: { value: number };
    uGeomorphTargetPositionMap: { value: unknown };
    uGeomorphTargetNormalMap: { value: unknown };
    uGeomorphRegionBounds: { value: [number, number, number, number] };
  };
}

/**
 * Apply the S2 geomorph vertex blend to an already-chunked shader.
 * Call AFTER the S1 photoreal transform (applyPhotorealShader) so the
 * vWorldPos varying exists and the base vertex path is settled (§10 rollout).
 *
 * Pure string transform; deterministic; no side effects beyond shader text.
 * When disabled the shader text is UNCHANGED (spec §8.4: inactive material
 * does not alter vertex output).
 */
export function applyGeomorphShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> },
  opts: GeomorphShaderOptions,
): void {
  if (!opts.enabled) return;

  // Bind the per-draw uniform store. When the renderer supplies its captured
  // store (material.userData.geomorphUniforms) we reuse those exact objects so
  // the per-mesh onBeforeRender mutates what three.js reads at setProgram time.
  // Otherwise fall back to fresh defaults (headless / no-store path).
  const u = opts.uniforms;
  shader.uniforms.uGeomorphActive = u ? u.uGeomorphActive : { value: 0 };
  shader.uniforms.uGeomorphT = u ? u.uGeomorphT : { value: 0 };
  shader.uniforms.uGeomorphTargetPositionMap = u ? u.uGeomorphTargetPositionMap : { value: null };
  shader.uniforms.uGeomorphTargetNormalMap = u ? u.uGeomorphTargetNormalMap : { value: null };
  shader.uniforms.uGeomorphRegionBounds = u ? u.uGeomorphRegionBounds : { value: [0, 0, 1, 1] };

  // Vertex: inject common (uniforms + helper) then morph after begin_vertex.
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\n" + GEOMORPH_VERTEX_COMMON_GLSL,
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n" + GEOMORPH_VERTEX_MORPH_GLSL,
    );
}

/**
 * Per-mesh uniform setter for mesh.onBeforeRender (§4.9).
 * Called with the geomorph blend state (or null for non-blending meshes).
 * Sets the shared material's uniforms for the current draw call.
 *
 * The caller must pass THREE uniform objects ({value: X}) not raw values,
 * OR this helper constructs them. For performance, the renderer should
 * pre-create the uniform objects and mutate .value directly; this helper
 * is the convenience path and the correctness reference.
 */
export function geomorphUniformValues(
  active: boolean,
  t: number,
  targetPositionMap: unknown | null,
  targetNormalMap: unknown | null,
  regionBounds: [number, number, number, number],
): Record<string, { value: unknown }> {
  return {
    uGeomorphActive: { value: active ? 1 : 0 },
    uGeomorphT: { value: t },
    uGeomorphTargetPositionMap: { value: targetPositionMap },
    uGeomorphTargetNormalMap: { value: targetNormalMap },
    uGeomorphRegionBounds: { value: regionBounds },
  };
}
