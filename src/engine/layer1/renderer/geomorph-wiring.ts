// S2 geomorphing: renderer-internal wiring helpers (spec 4.4 / 4.5 / 4.9).
// Separated from wiring.ts to keep that file focused on scene-graph glue.
//
// v1.1 (cert KICK fix): the morph GLSL (geomorph-shader.ts) reads per-draw
// uniforms (uGeomorphActive/uGeomorphT + target-tier lookup maps + region
// bounds). On a SHARED terrain material three.js re-reads material.uniforms and
// material.polygonOffset on EVERY draw (setProgram runs after the mesh's
// onBeforeRender), so per-mesh state is produced by mutating the captured
// uniform store + polygonOffset inside a per-mesh onBeforeRender hook - no
// material clone. geomorphUniformWrite is the pure core that moves the uniforms
// off their inactive defaults; before v1.1 nothing invoked it, so the morph was
// dead code at draw time (Sarah finding 1). The hook factory is three-free so
// the draw-time guard (S2-AC-10) can assert it with no WebGL context.

import type { LodTier } from "./types.ts";
import type { LodPlan } from "./lod.ts";
import type { GeomorphBlendState, GeomorphConfig } from "./geomorph.ts";
import {
  geomorphStepSize,
  geomorphBoundaries,
  DEFAULT_GEOMORPH_STEPS,
} from "./geomorph.ts";
import type { GeomorphLookup } from "./geomorph-lookup.ts";

// The per-material uniform store captured at compile time (material.userData.
// geomorphUniforms). Values are mutated in place per draw (no hot-path alloc).
export interface GeomorphUniformStore {
  uGeomorphActive: { value: number };
  uGeomorphT: { value: number };
  uGeomorphTargetPositionMap: { value: unknown };
  uGeomorphTargetNormalMap: { value: unknown };
  uGeomorphRegionBounds: { value: [number, number, number, number] };
}

// Polygon-offset bias applied to the union pair to kill z-fighting between the
// near-coplanar source/target tiers (spec 4.8 / v1.1 S2-AC-11). Negative bias
// pulls the blended surface slightly toward the camera so the morphing pair
// wins the depth test against the static single-tier neighbor behind it.
export const GEOMORPH_POLYGON_OFFSET_FACTOR = -1.0;
export const GEOMORPH_POLYGON_OFFSET_UNITS = -1.0;

// Bias direction (spec 4.4): the target tier is pulled toward the camera
// (negative), the source tier pushed away (positive), so the two near-coplanar
// blend meshes separate in depth instead of z-fighting EACH OTHER. Named
// constants, not inline magic numbers.
export const GEOMORPH_POLYGON_OFFSET_TARGET = { factor: -1.0, units: -1.0 };
export const GEOMORPH_POLYGON_OFFSET_SOURCE = { factor: 1.0, units: 1.0 };

// Structural mesh type: unit tests supply { visible, userData }; the real
// renderer supplies a THREE.Mesh (visible, material, userData, onBeforeRender).
interface GeomorphMesh {
  visible: boolean;
  userData?: Record<string, unknown>;
  onBeforeRender?: unknown;
}

// Minimal structural RendererContext surface this module touches. The real ctx
// satisfies it structurally; bare unit-test ctx objects supply only what they
// assert on. geomorphResolveLookup is an OPTIONAL capability hook installed by
// the renderer to turn a (region key, target tier) into a cached target-tier
// lookup; bare unit-test ctx objects omit it and the draw hook then receives a
// null lookup (guard tests inject their own resolver directly to makeGeomorphDrawHook).
interface GeomorphCtx {
  geomorphConfig: GeomorphConfig | null;
  tierSelectionCount: number;
  geomorphVisibleSetChangeCount: number;
  regionMeshByTier: Map<string, Map<LodTier, GeomorphMesh>>;
  geomorphResolveLookup?: (key: string, targetTier: LodTier) => GeomorphLookup | null;
}

// Per-mesh draw intent stamped by applyGeomorphTierSelection and read back at
// draw time by the installed onBeforeRender hook. Kept on mesh.userData so it
// survives across frames and is trivially assertable.
interface GeomorphDrawIntent {
  active: boolean;
  t: number;
  targetTier: LodTier | null;
  /** Blend role of THIS mesh: which way the polygon-offset bias is applied. */
  role: "source" | "target" | null;
}

// Ensure geomorphConfig is initialized from the current plan LodConfig
// thresholds and the world grid step size. Idempotent: once set it stays
// stable for the geometry epoch (boundaries do not change without a rebuild).
export function ensureGeomorphConfig(ctx: GeomorphCtx, plan: LodPlan): GeomorphConfig {
  if (ctx.geomorphConfig && ctx.geomorphConfig.boundaries.length > 0) {
    return ctx.geomorphConfig;
  }
  const stepSize = geomorphStepSize(plan.worldWidth, plan.vertexGrid);
  const boundaries = geomorphBoundaries(plan.config.nearM, plan.config.maxMidM);
  const cfg: GeomorphConfig = {
    enabled: true,
    stepsPerBoundary: DEFAULT_GEOMORPH_STEPS,
    stepSize,
    boundaries,
  };
  ctx.geomorphConfig = cfg;
  return cfg;
}

/**
 * PURE draw-time uniform write (spec 4.9). The single point where the geomorph
 * uniforms move off their inactive defaults for a draw call. Allocation-free
 * and scoped to the passed store so the draw-time guard test (S2-AC-10) can
 * assert it directly with no WebGL context.
 *
 * Inactive (null / state.active false): uGeomorphActive pinned to 0 and t to 0
 * so the vertex path stays bit-identical to S1 (spec 4.6). The lookup maps are
 * left untouched because uGeomorphActive gates the morph branch in GLSL.
 *
 * Active: uGeomorphActive=1, uGeomorphT=t, and the target-tier position/normal
 * maps + region bounds are bound from `lookup`. If a lookup cannot be resolved
 * (e.g. target geometry missing) the write stays inactive so a blend frame can
 * never sample a null texture - the guard test covers this fail-safe.
 */
export function geomorphUniformWrite(
  store: GeomorphUniformStore,
  state: GeomorphBlendState | null | undefined,
  lookup: GeomorphLookup | null | undefined,
): void {
  const active = Boolean(state && state.active && lookup);
  store.uGeomorphActive.value = active ? 1 : 0;
  if (!active) {
    store.uGeomorphT.value = 0;
    return;
  }
  store.uGeomorphT.value = state!.t;
  store.uGeomorphTargetPositionMap.value = lookup!.positionMap;
  store.uGeomorphTargetNormalMap.value = lookup!.normalMap;
  store.uGeomorphRegionBounds.value = lookup!.bounds;
}

/**
 * Build the per-draw onBeforeRender hook for one terrain mesh (spec 4.9).
 * three-free by design: it is handed the captured uniform store, the mesh whose
 * userData carries the draw intent, and a resolver that maps the mesh's target
 * tier to a cached lookup. three.js calls this immediately before setProgram
 * for THIS mesh's draw, so mutating the shared material's uniform values here
 * yields correct per-draw uniforms without cloning the material.
 *
 * The hook also drives polygonOffset: the union pair gets the negative bias; a
 * non-blend mesh resets it to the material default so the bias cannot leak into
 * the next draw (shared-material per-draw invariant). When no uniform store is
 * present (pre-compile / headless) the hook is a safe no-op.
 *
 * @param material The mesh's material; polygonOffset is written onto it. Pass
 *   the same object three.js will draw with.
 */
export function makeGeomorphDrawHook(
  store: GeomorphUniformStore | null | undefined,
  mesh: GeomorphMesh,
  resolveLookup: (targetTier: LodTier) => GeomorphLookup | null,
  material: { polygonOffset?: boolean; polygonOffsetFactor?: number; polygonOffsetUnits?: number } | null | undefined,
): () => void {
  return () => {
    const intent = (mesh.userData?.geomorphDraw as GeomorphDrawIntent | undefined) ?? null;
    const active = Boolean(intent && intent.active);
    if (store) {
      if (active) {
        const lookup = intent!.targetTier ? resolveLookup(intent!.targetTier) : null;
        geomorphUniformWrite(
          store,
          { key: "", active: true, sourceTier: "near", targetTier: intent!.targetTier ?? "mid", stepIndex: 0, t: intent!.t },
          lookup,
        );
      } else {
        geomorphUniformWrite(store, null, null);
      }
    }
    if (material) {
      if (active) {
        const bias = intent!.role === "source"
          ? GEOMORPH_POLYGON_OFFSET_SOURCE
          : GEOMORPH_POLYGON_OFFSET_TARGET;
        material.polygonOffset = true;
        material.polygonOffsetFactor = bias.factor;
        material.polygonOffsetUnits = bias.units;
      } else {
        material.polygonOffset = false;
        material.polygonOffsetFactor = 0;
        material.polygonOffsetUnits = 0;
      }
    }
  };
}

// S2 geomorph-aware draw selection (spec 4.5). For non-blend regions behavior
// is identical to applyTierSelection (one visible mesh). For blend-state
// regions both sourceTier and targetTier meshes are visible (union-drawn) and
// each is stamped with a draw intent (active + t + the OTHER tier as target,
// so the pair morphs toward each other and meets in the middle). Non-union
// meshes are stamped inactive. Stamped intent is consumed by the per-mesh
// onBeforeRender hook installed by the renderer. Does NOT mutate assignment or
// plan; does NOT build or dispose meshes. tierSelectionCount tracks logical
// tier-assignment changes (M-P5 semantics). geomorphVisibleSetChangeCount
// tracks visible-mesh-set changes caused by blend activation/deactivation.
export function applyGeomorphTierSelection(
  ctx: GeomorphCtx,
  assignment: Map<string, LodTier>,
  geomorphStates: Map<string, GeomorphBlendState>,
  prevGeomorphStates?: Map<string, GeomorphBlendState>,
): void {
  let tierChanged = false;
  let visibleSetChanged = false;

  for (const entry of ctx.regionMeshByTier.entries()) {
    const key = entry[0];
    const byTier = entry[1];
    const sel = assignment.get(key);
    const blend = geomorphStates.get(key);
    const blending = Boolean(blend && blend.active);

    for (const tierEntry of byTier.entries()) {
      const tier = tierEntry[0];
      const mesh = tierEntry[1];
      let want: boolean;
      let inUnion = false;
      let targetTier: LodTier | null = null;
      let t = 0;
      let role: "source" | "target" | null = null;
      if (blending) {
        const isSource = tier === blend!.sourceTier;
        const isTarget = tier === blend!.targetTier;
        inUnion = isSource || isTarget;
        want = inUnion;
        if (inUnion) {
          // Each tier morphs toward the OTHER so the pair converges: the source
          // advances by t, the target retreats by (1 - t).
          targetTier = isSource ? blend!.targetTier : blend!.sourceTier;
          t = isSource ? blend!.t : 1 - blend!.t;
          role = isSource ? "source" : "target";
        }
      } else {
        want = tier === sel;
      }

      if (mesh.visible !== want) {
        mesh.visible = want;
        if (blending && inUnion) {
          visibleSetChanged = true;
        } else if (prevGeomorphStates && prevGeomorphStates.has(key)) {
          // Blend deactivation: was blending, now is not.
          visibleSetChanged = true;
        } else {
          tierChanged = true;
        }
      }

      if (mesh.userData) {
        mesh.userData.geomorphDraw = { active: inUnion, t, targetTier, role };
      }
    }
  }

  if (tierChanged) ctx.tierSelectionCount += 1;
  if (visibleSetChanged) ctx.geomorphVisibleSetChangeCount += 1;
}
