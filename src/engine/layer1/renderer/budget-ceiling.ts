/*
 * M-P2 near-budget ceiling + final geometry caps (spec-layer1-performance-mp2.md).
 *
 * A pure, deterministic budget step inserted between LOD planning and mesh
 * building:
 *
 *   base plan -> predicted post-cull drawn -> budget ceiling -> effective plan
 *             -> build meshes
 *
 * Product rule: a dollied-in camera must not expand near-tier full detail
 * across the visible world. When predicted post-cull `drawn` would exceed the
 * approved cap for the pose class, the ceiling reduces tessellation density by
 * PER-REGION STRIDE DEMOTION only (farthest-near-first), never by shrinking the
 * world, never per-pixel, never below the far tier, never to skybox.
 *
 * Caps and tuning authority are FROZEN by Jordan (Q3/Q6). This module owns the
 * frozen cap table and the deterministic demotion pass; it does NOT re-target
 * caps and does NOT enable dynamic resolution.
 *
 * Determinism: pure functions of (terrain, plan, camera, margin, vertexCount).
 * No wall-clock, no Math.random, no iteration-order dependence — a stable total
 * sort order (descending centerDistance, then (cz, cx)) makes the demotion set
 * reproducible (M-P2-AC-06, §6.2).
 *
 * Prediction honesty (§6.6, M-P2-AC-01): the predicted per-region triangle count
 * and bounding sphere are produced by the SAME shared regionMeshTopology +
 * sphereFromPositions path the mesh builder and the M-P1b sweep/HUD use, and the
 * frustum pass uses the same estimateDrawnTriangles, so the ceiling's `drawn`
 * prediction equals the reported `drawn` for a given stride set. A divergence
 * would make the cap false, so this is a hard invariant, not an approximation.
 *
 * Performance: a demotion changes a region's own stride AND the boundary stride
 * its four edge-neighbors keep against it. Each region's cull item (sphere +
 * triangle count) therefore depends only on its (self, left, right, top, bottom)
 * stride tuple. The demotion loop caches items by that tuple and recomputes only
 * the ~5 neighborhoods that actually change per step, so bounding the whole grid
 * is cheap even with many steps. The frustum pass runs over the cached items
 * every step (cheap), keeping the estimator path identical to the sweep/HUD.
 */
import type { LodPlan, LodRegion, TerrainLayer } from "./types.ts";
import {
  regionEdgeStrides,
  regionMeshTopology,
  LOD_STRIDE_NEAR,
  LOD_STRIDE_MID,
  LOD_STRIDE_FAR,
} from "./lod.ts";
import {
  sphereFromPositions,
  estimateDrawnTriangles,
  type CullItem,
  type CullCameraParams,
} from "./frustum-cull.ts";
import type * as THREE from "three";

/* ------------------------------------------------------------------ */
/* Frozen cap table (§3.1) — NOT re-targetable                         */
/* ------------------------------------------------------------------ */

export interface PerfCaps {
  default: number;
  mid: number;
  nearDominant: number;
  absolute: number;
}

/** Base caps for the default 512x512 vertex grid. Jordan-approved. */
export const PERF_CAPS: PerfCaps = {
  default: 20000,
  mid: 150000,
  nearDominant: 200000,
  absolute: 250000,
};

/** Baseline vertex count the base caps are defined against (§3.2). */
export const DEFAULT_VERTEX_COUNT = 512 * 512;

/**
 * Scale a base cap for a larger vertex grid by the vertex-count ratio (§3.2).
 * Same vertex count => same cap (a larger world at 512^2 does NOT get a larger
 * cap). Never used to soften the default caps: for the default grid this is the
 * exact base value.
 */
export function scaleCap(baseCap: number, vertexCount: number): number {
  if (!Number.isFinite(vertexCount) || vertexCount <= 0) return baseCap;
  return Math.round((baseCap * vertexCount) / DEFAULT_VERTEX_COUNT);
}

/** All four caps scaled for a given vertex grid (§3.2), for test reporting. */
export function scaleCaps(vertexCount: number): PerfCaps {
  return {
    default: scaleCap(PERF_CAPS.default, vertexCount),
    mid: scaleCap(PERF_CAPS.mid, vertexCount),
    nearDominant: scaleCap(PERF_CAPS.nearDominant, vertexCount),
    absolute: scaleCap(PERF_CAPS.absolute, vertexCount),
  };
}

/* ------------------------------------------------------------------ */
/* Near-dominant classification (§3.4) — tunable under Q6              */
/* ------------------------------------------------------------------ */

export interface NearDominantThresholds {
  /** # near-tier regions (frustum-relevant) at/above which a pose is near-dominant. */
  minNearRegionCount: number;
  /** # near-drawn / total-drawn at/above which a pose is near-dominant. */
  minNearDrawnShare: number;
}

export const DEFAULT_NEAR_DOMINANT: NearDominantThresholds = {
  minNearRegionCount: 8,
  minNearDrawnShare: 0.5,
};

export type CapClass = "default" | "mid" | "near-dominant" | "absolute";

/* ------------------------------------------------------------------ */
/* Shared per-region drawn item (prediction == builder == HUD)         */
/* ------------------------------------------------------------------ */

interface CullCacheKey {
  s: number; left: number; right: number; top: number; bottom: number;
}

/**
 * Compute one region's cull item (sphere + triangle count) for a given edge-
 * stride tuple. This is the exact same topology + sphere the builder and sweep
 * produce, so predicted triangles == measured triangles for that stride set.
 */
function computeItem(
  terrain: TerrainLayer,
  plan: LodPlan,
  region: LodRegion,
  e: CullCacheKey,
): CullItem & { triangles: number } {
  const rx = region.spanX;
  const rz = region.spanZ;
  const topo = regionMeshTopology(e.s, e.left, e.right, e.top, e.bottom, rx, rz);
  const halfW = plan.worldWidth / 2;
  const halfD = plan.worldDepth / 2;
  const cell = plan.worldWidth / (plan.vertexGrid - 1);
  const out = new Float64Array(topo.vertexKeys.length * 3);
  for (let i = 0; i < topo.vertexKeys.length; i += 1) {
    const vk = topo.vertexKeys[i];
    const cx2 = vk % (rx + 1);
    const cz2 = Math.floor(vk / (rx + 1));
    const wx = -halfW + (region.cellStartX + cx2) * cell;
    const wz = -halfD + (region.cellStartZ + cz2) * cell;
    out[i * 3] = wx;
    out[i * 3 + 1] = terrain.sampleHeight(wx, wz);
    out[i * 3 + 2] = wz;
  }
  return { sphere: sphereFromPositions(out), triangles: topo.indices.length / 3 };
}

function edgeKeyOf(e: CullCacheKey): string {
  return e.s + "," + e.left + "," + e.right + "," + e.top + "," + e.bottom;
}

/* ------------------------------------------------------------------ */
/* Incremental cull-item estimator (per-region stride-tuple cache)     */
/* ------------------------------------------------------------------ */

class CullEstimator {
  private plan: LodPlan;
  private byKey: Map<string, LodRegion> = new Map();
  private items: (CullItem & { triangles: number })[] = [];
  private keys: string[] = [];
  private cache: Map<string, CullItem & { triangles: number }> = new Map();

  constructor(terrain: TerrainLayer, plan: LodPlan) {
    this.terrain = terrain;
    this.plan = plan;
    for (const rg of plan.regions) this.byKey.set(rg.cx + "," + rg.cz, rg);
    this.rebuildAll();
  }

  private edgeKeyStrides(cx: number, cz: number): CullCacheKey {
    const region = this.byKey.get(cx + "," + cz);
    if (!region) return { s: -1, left: -1, right: -1, top: -1, bottom: -1 };
    const e = regionEdgeStrides(this.plan, region);
    return { s: e.s, left: e.left, right: e.right, top: e.top, bottom: e.bottom };
  }

  private compute(cx: number, cz: number): CullItem & { triangles: number } {
    const region = this.byKey.get(cx + "," + cz)!;
    const strides = this.edgeKeyStrides(cx, cz);
    // Region-identity-qualified key: the sphere is position-specific, so an
    // item cached for one region must never be handed to another.
    const key = cx + "," + cz + "|" + edgeKeyOf(strides);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const item = computeItem(this.terrain, this.plan, region, strides);
    this.cache.set(key, item);
    return item;
  }

  /** Region index within the plan enumeration order. */
  private index(cx: number, cz: number): number {
    return cz * this.plan.regionsPerAxis + cx;
  }

  private rebuildAll(): void {
    this.items = [];
    this.keys = [];
    for (const rg of this.plan.regions) {
      const item = this.compute(rg.cx, rg.cz);
      this.items.push(item);
      this.keys.push(edgeKeyOf(this.edgeKeyStrides(rg.cx, rg.cz)));
    }
  }

  /**
   * Mark a region demoted in the plan's budgetStride map, then refresh only the
   * changed region and its four edge-neighbors (the only items whose stride
   * tuple can change). Returns nothing; call drawn()/nearDrawn() after.
   */
  refresh(cx: number, cz: number): void {
    const touched = [
      [cx, cz],
      [cx - 1, cz],
      [cx + 1, cz],
      [cx, cz - 1],
      [cx, cz + 1],
    ];
    for (const [tx, tz] of touched) {
      const region = this.byKey.get(tx + "," + tz);
      if (!region) continue;
      const idx = this.index(tx, tz);
      const item = this.compute(tx, tz);
      this.items[idx] = item;
      this.keys[idx] = edgeKeyOf(this.edgeKeyStrides(tx, tz));
    }
  }

  /** Total post-cull drawn for the current stride set (shared estimator). */
  total(frustum: THREE.Frustum, marginM: number): number {
    return estimateDrawnTriangles(this.items, frustum, marginM).drawn;
  }

  /** Near-tier post-cull drawn + kept near-region count (same frustum). */
  near(frustum: THREE.Frustum, marginM: number): { drawn: number; kept: number } {
    const nearItems: CullItem[] = [];
    for (let i = 0; i < this.plan.regions.length; i += 1) {
      if (this.plan.regions[i].tier === "near") nearItems.push(this.items[i]);
    }
    const res = estimateDrawnTriangles(nearItems, frustum, marginM);
    return { drawn: res.drawn, kept: res.kept };
  }
}

/**
 * Predicted post-cull drawn (+ near-tier breakdown) for the plan's CURRENT
 * effective strides. Uses the shared frustum estimator so it matches the sweep
 * and HUD exactly. Pure; does not mutate the plan.
 */
export interface PredictedDrawn {
  total: number;
  near: number;
  nearRegionCount: number;
}

export function predictDrawn(
  terrain: TerrainLayer,
  plan: LodPlan,
  frustum: THREE.Frustum,
  marginM: number,
): PredictedDrawn {
  const est = new CullEstimator(terrain, plan);
  const n = est.near(frustum, marginM);
  return { total: est.total(frustum, marginM), near: n.drawn, nearRegionCount: n.kept };
}

/* ------------------------------------------------------------------ */
/* Deterministic demotion pass (§3.3, §3.5, §3.7)                      */
/* ------------------------------------------------------------------ */

export interface BudgetCeilingOptions {
  terrain: TerrainLayer;
  frustum: THREE.Frustum;
  marginM: number;
  vertexCount: number;
  /** Overrides the frozen cap table (test-only: ceiling-off comparison). */
  caps?: PerfCaps;
  thresholds?: NearDominantThresholds;
  /** Master switch: when false the base plan ships unchanged (ceiling-off). */
  enabled?: boolean;
}

export interface BudgetCeilingResult {
  /** Plan carrying the internal budgetStride override map (public snapshot unchanged). */
  plan: LodPlan;
  activeCap: number;
  capClass: CapClass;
  nearDominant: boolean;
  predictedDrawn: number;
  demotionCount: number;
  /** True when all allowed demotions were exhausted yet drawn > activeCap (§6.5). */
  unmet: boolean;
  /** Structured diagnostic tokens (empty on the healthy path). */
  diagnostics: string[];
}

/**
 * Stable total ordering for demotion: farthest region first (descending
 * centerDistance), tie-broken by (cz, cx). Deterministic, no float tie ambiguity
 * because centerDistance ties fall through to the integer region index (§6.2).
 */
function demotionOrder(a: LodRegion, b: LodRegion): number {
  if (b.centerDistance !== a.centerDistance) return b.centerDistance - a.centerDistance;
  if (a.cz !== b.cz) return a.cz - b.cz;
  return a.cx - b.cx;
}

/**
 * Ladder step for a region given its current effective stride, or null when it
 * is already at the far floor (stride 4). near/mid can coarsen; far cannot.
 */
function nextCoarser(stride: number, r: number): number | null {
  if (stride >= LOD_STRIDE_FAR) return null;
  if (stride < LOD_STRIDE_MID) return Math.min(LOD_STRIDE_MID, r);
  return Math.min(LOD_STRIDE_FAR, r);
}

function tierStride(tier: LodRegion["tier"]): number {
  switch (tier) {
    case "near": return LOD_STRIDE_NEAR;
    case "mid": return LOD_STRIDE_MID;
    case "far": return LOD_STRIDE_FAR;
    case "skybox": return LOD_STRIDE_FAR;
  }
}

/**
 * Apply the near-budget ceiling to a base plan. Returns an effective plan whose
 * internal `budgetStride` map coarsens whole regions (near-first, farthest-first)
 * until predicted drawn meets the active cap, or until the cascade is exhausted.
 * Never mutates the input plan or the public snapshot.
 */
export function applyNearBudgetCeiling(
  basePlan: LodPlan,
  opts: BudgetCeilingOptions,
): BudgetCeilingResult {
  const caps = opts.caps ?? scaleCaps(opts.vertexCount);
  const thresholds = opts.thresholds ?? DEFAULT_NEAR_DOMINANT;
  const diagnostics: string[] = [];

  // Working override map. Start from any pre-existing overrides (idempotent).
  const map = new Map<string, number>(basePlan.budgetStride ?? undefined);
  // Effective plan carrying the current overrides; the estimator reads strides
  // through regionEdgeStrides via this plan, so demotions must be applied here.
  const eff: LodPlan = { ...basePlan, budgetStride: map.size ? map : null };
  const syncMap = (): void => { eff.budgetStride = map.size ? map : null; };

  const est = new CullEstimator(opts.terrain, eff);
  const initial = est.near(opts.frustum, opts.marginM);
  const initialTotal = est.total(opts.frustum, opts.marginM);

  // Ceiling-off: ship the base plan untouched (no budgetStride applied).
  if (opts.enabled === false) {
    return {
      plan: { ...basePlan, budgetStride: basePlan.budgetStride ?? null },
      activeCap: caps.absolute,
      capClass: "absolute",
      nearDominant: false,
      predictedDrawn: initialTotal,
      demotionCount: map.size,
      unmet: false,
      diagnostics,
    };
  }

  // Near-dominant classification (§3.4): pure over plan/camera state.
  const nearDominant =
    initial.kept >= thresholds.minNearRegionCount ||
    (initialTotal > 0 && initial.drawn / initialTotal >= thresholds.minNearDrawnShare);

  // Active cap selection (§3.3 step 3). absolute is the universal guard; the
  // tightest applicable class cap is used. The default boot pose is well under
  // the 20k default cap by geometry, so it never fires here.
  let activeCap: number;
  let capClass: CapClass;
  if (nearDominant) {
    activeCap = Math.min(caps.nearDominant, caps.absolute);
    capClass = "near-dominant";
  } else {
    // Non-near-dominant: the mid cap is the operative CI bound (M-P2-AC-03),
    // never looser than the absolute cap.
    activeCap = Math.min(caps.mid, caps.absolute);
    capClass = "mid";
  }

  if (initialTotal <= activeCap) {
    return {
      plan: eff,
      activeCap,
      capClass,
      nearDominant,
      predictedDrawn: initialTotal,
      demotionCount: map.size,
      unmet: false,
      diagnostics,
    };
  }

  // Deterministic demotion candidates (§3.5 / §3.7):
  //   Phase A: near regions, farthest-first, each can step 1->2 then 2->4.
  //   Phase B (cascade): mid regions, farthest-first, each can step 2->4.
  // Far/skybox are never demoted. Whole regions only (§3.5).
  const near = basePlan.regions.filter((rg) => rg.tier === "near").sort(demotionOrder);
  const mid = basePlan.regions.filter((rg) => rg.tier === "mid").sort(demotionOrder);

  const steps: LodRegion[] = [];
  for (const rg of near) steps.push(rg, rg); // two ladder steps for near
  for (const rg of mid) steps.push(rg); // one ladder step for mid (2 -> 4)

  const currentStride = (region: LodRegion): number => {
    const ov = map.get(region.cx + "," + region.cz);
    const base = tierStride(region.tier);
    if (ov === undefined) return base;
    const clamped = Math.max(1, Math.min(Math.max(region.spanX, region.spanZ), ov));
    return clamped > base ? clamped : base;
  };

  let predicted = initialTotal;
  for (const region of steps) {
    if (predicted <= activeCap) break;
    const key = region.cx + "," + region.cz;
    const cur = currentStride(region);
    const next = nextCoarser(cur, Math.max(region.spanX, region.spanZ));
    if (next === null || next <= cur) continue; // already at far floor
    map.set(key, next);
    syncMap();
    est.refresh(region.cx, region.cz);
    predicted = est.total(opts.frustum, opts.marginM);
  }

  const demotionCount = map.size;
  const unmet = predicted > activeCap;
  if (unmet) {
    diagnostics.push(`budget:UNMET drawn=${Math.round(predicted)} cap=${activeCap} reason=cascade-exhausted`);
  }

  return {
    plan: eff,
    activeCap,
    capClass,
    nearDominant,
    predictedDrawn: predicted,
    demotionCount,
    unmet,
    diagnostics,
  };
}

/** Re-export so callers can build the frustum without importing frustum-cull directly. */
export type { CullCameraParams };
