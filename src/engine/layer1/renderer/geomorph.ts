/*
 * S2 geomorphing — pose-quantized LOD blend-state derivation.
 * spec-layer1-geomorphing-s2.md §4.1 / §4.2 / §4.3.
 *
 * Pure, deterministic, GPU-agnostic heart of S2. For each LOD region it decides
 * whether the camera-to-region distance currently lands inside a blend window
 * around a resident-tier boundary, and if so which two resident tiers blend
 * (source = closer tier, target = farther tier) and the quantized ratio t.
 * The renderer turns an active state into union-drawn (two visible meshes)
 * state plus a vertex-shader morph; this module owns ONLY the derivation so it
 * is assertable in CI with no WebGL context (spec §8.1).
 *
 * Hard constraints (spec §3.1, §3.3, §9, §11):
 *   - Pure function of (plan, assignment, config). No terrain mutation, no
 *     sampleHeight, no wall-clock (Date / performance.now / Clock), no
 *     Math.random, no per-frame accumulation.
 *   - No dependence on Map iteration order for observable output: the region
 *     list (an ordered array) is the sole iteration source.
 *   - Skybox is not a resident tier; far -> skybox never blends.
 *   - M-P2 budget-demoted regions never blend: the near-budget ceiling wins so
 *     geomorph union cost cannot defeat near-budget enforcement.
 */

import type { LodRegion, LodTier } from "./types.ts";
import type { LodPlan } from "./lod.ts";

/** Resident tiers only. Skybox is intentionally excluded (spec §4.1). */
export type GeomorphTier = Exclude<LodTier, "skybox">;

/** Blend state for one region. `active` false regions are not stored in the map. */
export interface GeomorphBlendState {
  /** Region key, `cx + "," + cz` (matches regionMeshByTier / assignment keys). */
  key: string;
  active: boolean;
  /** Closer tier — fully source-positioned at t = 0. */
  sourceTier: GeomorphTier;
  /** Farther tier — fully target-positioned at t = 1. */
  targetTier: GeomorphTier;
  /** Quantized step index within the window, 0..stepsPerBoundary. */
  stepIndex: number;
  /** Quantized blend ratio: stepIndex / stepsPerBoundary, one of {0,1/N,..,1}. */
  t: number;
}

/** One resident-tier boundary: closer `fromTier` -> farther `toTier` at distanceM. */
export interface GeomorphBoundary {
  fromTier: GeomorphTier;
  toTier: GeomorphTier;
  distanceM: number;
}

/** Renderer-internal geomorph tuning. Not public API (spec §10). */
export interface GeomorphConfig {
  enabled: boolean;
  stepsPerBoundary: number;
  stepSize: number;
  boundaries: readonly GeomorphBoundary[];
}

/* Provisional constants (spec §4.3, §12 OQ-3/OQ-4). */
export const DEFAULT_GEOMORPH_STEPS = 4;
export const MIN_GEOMORPH_STEP_SIZE = 0.5;

/**
 * One world-cell step size in meters, with a small floor. Provisional: the
 * region grid uses worldWidth / (vertexGrid - 1) cells; a 512 m / 512-vertex
 * world yields ~1 m. Never below MIN_GEOMORPH_STEP_SIZE (spec §4.3).
 */
export function geomorphStepSize(worldWidthMeters: number, vertexGrid: number): number {
  const n = vertexGrid - 1;
  if (!Number.isFinite(worldWidthMeters) || worldWidthMeters <= 0) return MIN_GEOMORPH_STEP_SIZE;
  if (!Number.isFinite(n) || n < 1) return MIN_GEOMORPH_STEP_SIZE;
  return Math.max(MIN_GEOMORPH_STEP_SIZE, worldWidthMeters / n);
}

/**
 * Resident-tier boundaries from the frozen LodConfig thresholds. near->mid at
 * nearM, mid->far at maxMidM. far->skybox (maxFarM) is deliberately omitted:
 * skybox is not a resident tier so it cannot be a blend target (spec §4.1).
 */
export function geomorphBoundaries(nearM: number, maxMidM: number): GeomorphBoundary[] {
  return [
    { fromTier: "near", toTier: "mid", distanceM: nearM },
    { fromTier: "mid", toTier: "far", distanceM: maxMidM },
  ];
}

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Derive the blend state for a single region, or null when it is not blending.
 * Pure. `assigned` is the region's effective selected tier (may be a ceiling
 * demotion or a skybox clamp); it is used only to detect cases that must NOT
 * blend, never to compute t (t comes from pose distance alone — spec §3.1).
 */
function deriveRegionState(
  region: LodRegion,
  assigned: LodTier | undefined,
  config: GeomorphConfig,
  windowWidth: number,
): GeomorphBlendState | null {
  const key = region.cx + "," + region.cz;
  const d = region.centerDistance;
  // Non-finite distance: no blend. Callers may record a diagnostic (spec §8.1).
  if (!Number.isFinite(d)) return null;
  // Skybox is not a resident tier — never a blend source or target.
  if (region.tier === "skybox") return null;
  // M-P2 ceiling demotion (raw near selected as mid): ceiling enforcement wins;
  // such a region must never enter blend union (spec §4.1 requirement).
  if (region.tier === "near" && assigned === "mid") return null;

  const half = windowWidth / 2;
  for (const b of config.boundaries) {
    if (!Number.isFinite(b.distanceM)) continue;
    const start = b.distanceM - half;
    const end = b.distanceM + half;
    if (d >= start && d <= end) {
      const rawStep = Math.floor((d - start) / config.stepSize);
      const stepIndex = clampInt(rawStep, 0, config.stepsPerBoundary);
      const t = stepIndex / config.stepsPerBoundary;
      return {
        key,
        active: true,
        sourceTier: b.fromTier,
        targetTier: b.toTier,
        stepIndex,
        t,
      };
    }
  }
  return null;
}

/**
 * Compute geomorph blend states for a plan. Returns a Map keyed by region key
 * containing ONLY active blend states (non-blending regions are absent, so the
 * renderer's single-tier path is the default). Pure and deterministic.
 *
 * When disabled, or with degenerate tuning (steps < 1 / stepSize <= 0), returns
 * an empty map so behavior is exactly M-P5 single-tier selection.
 *
 * Optional `diagnostics` is an out-sink for non-finite-distance regions; it is
 * never required and its absence keeps the call side-effect free.
 */
export function computeGeomorphStates(
  plan: LodPlan,
  assignment: Map<string, LodTier>,
  config: GeomorphConfig,
  diagnostics?: string[],
): Map<string, GeomorphBlendState> {
  const out = new Map<string, GeomorphBlendState>();
  if (!config.enabled) return out;
  if (config.stepsPerBoundary < 1 || !(config.stepSize > 0)) return out;

  const windowWidth = config.stepsPerBoundary * config.stepSize;
  // Single deterministic iteration source: the ordered region array.
  for (const region of plan.regions) {
    const key = region.cx + "," + region.cz;
    if (!Number.isFinite(region.centerDistance)) {
      if (diagnostics) {
        diagnostics.push("geomorph: non-finite centerDistance for region " + key + "; blend suppressed");
      }
      continue;
    }
    const state = deriveRegionState(region, assignment.get(key), config, windowWidth);
    if (state) out.set(key, state);
  }
  return out;
}
