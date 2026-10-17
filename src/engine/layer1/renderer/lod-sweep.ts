import type { CameraPose, LodConfig, LodTier, TerrainLayer } from "./types.ts";
import { planLodRegions, buildLodRegionMeshes, DEFAULT_REGIONS_PER_AXIS } from "./lod.ts";
import {
  makeFrustumCamera,
  buildFrustum,
  sphereFromPositions,
  estimateDrawnTriangles as cullEstimate,
  type CullItem,
  type CullCameraParams,
} from "./frustum-cull.ts";
import { applyNearBudgetCeiling, type CapClass } from "./budget-ceiling.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SweepPoseResult {
  label: string;
  camera: CameraPose;
  tiers: { near: number; mid: number; far: number; skybox: number };
  builtTriangles: number;
  drawnTriangles: number;
  postCull: boolean;
  /** M-P2: active cap for this pose (scaled for the vertex grid). */
  activeCap?: number;
  /** M-P2: cap class selected for this pose. */
  capClass?: CapClass;
  /** M-P2: number of regions demoted by the near-budget ceiling. */
  demotionCount?: number;
  /** M-P2: whether this pose classified near-dominant. */
  nearDominant?: boolean;
  /** M-P2: true when the ceiling exhausted allowed demotions yet stayed over cap. */
  budgetUnmet?: boolean;
}

export interface SweepReport {
  poses: SweepPoseResult[];
  maxDrawn: number;
  world: { vertices: number; meters: number };
  /** Anti-pop safety margin (m) applied to every region sphere (M-P1b). */
  cullMarginMeters?: number;
}

export interface SweepPose {
  label: string;
  camera: CameraPose;
  configOverride?: Partial<LodConfig>;
}

export interface SweepOptions {
  worldSize?: { vertices: number; meters: number };
  configOverride?: Partial<LodConfig>;
  /** M-P1b: override the headless cull camera projection (default 55/1/0.5/4000). */
  cullCamera?: Partial<CullCameraParams>;
  /**
   * M-P1b anti-pop margin (m). Default = one region span. Deliberately NOT a
   * LodConfig field: LodConfig feeds the frozen M-P1a plan signature, and
   * §9-Q6 tuning authority is M-P2. A margin here is a sweep-time knob only.
   */
  cullMarginMeters?: number;
  /**
   * M-P2: master switch for the near-budget ceiling in the sweep. Default
   * true (production parity so PRESET_POSES drawn reflects the capped plan).
   * Set false for the ceiling-off comparison (M-P2-AC-01 drawnUncapped).
   */
  ceilingEnabled?: boolean;
}

// ─── Named preset poses (single source of truth, from profile §1/§4) ─────────

const WORLD_DIAG_512 = Math.sqrt(512 * 512 + 512 * 512); // ≈724m

export const PRESET_POSES: SweepPose[] = [
  {
    label: "default",
    camera: { x: 317.44, y: 290.18, z: 0, targetX: 0, targetY: 80.67, targetZ: 0 },
  },
  {
    label: "seamcheck",
    camera: { x: 0, y: 120, z: 180, targetX: 0, targetY: 80, targetZ: 0 },
  },
  {
    label: "dolly",
    camera: { x: 0, y: 40, z: 120, targetX: 0, targetY: 60, targetZ: 0 },
  },
  {
    label: "allnear",
    camera: { x: 0, y: 60, z: 0, targetX: 0, targetY: 60, targetZ: 0 },
    configOverride: { nearM: WORLD_DIAG_512 * 2 },
  },
];

// ─── Core sweep function ─────────────────────────────────────────────────────

/**
 * Deterministic, browser-free LOD sweep. For each pose, plans regions and
 * builds meshes (pure, no WebGL) to record tier histogram + built/drawn counts.
 *
 * In M-P0, culling is off so drawn === built. The postCull=false flag signals
 * this to downstream gates. M-P1 flips postCull=true and subtracts
 * frustum-rejected regions.
 */
export function runLodSweep(
  terrain: TerrainLayer,
  poses: SweepPose[],
  opts?: SweepOptions,
): SweepReport {
  const snap = terrain.snapshot();
  if (!snap.generated) {
    throw new Error(
      `runLodSweep requires a generated heightfield; call terrain.generate() first (checked before pose "${poses[0]?.label ?? "unknown"}")`,
    );
  }

  const worldMeters = opts?.worldSize?.meters ?? snap.worldSize.meters;
  const vertexGrid = opts?.worldSize?.vertices ?? snap.worldSize.vertices;

  // Default anti-pop margin = one region span (regionSpan * cell), matching
  // planLodRegions so the estimate never depends on a mounted camera.
  const regionSpan = Math.max(1, Math.floor((vertexGrid - 1) / DEFAULT_REGIONS_PER_AXIS));
  const cell = worldMeters / (vertexGrid - 1);
  const cullMarginMeters = opts?.cullMarginMeters ?? regionSpan * cell;

  const results: SweepPoseResult[] = [];

  for (const pose of poses) {
    const config: Partial<LodConfig> | undefined =
      pose.configOverride ?? opts?.configOverride;

    const basePlan = planLodRegions({
      worldWidth: worldMeters,
      worldDepth: worldMeters,
      vertexGrid,
      camera: pose.camera,
      config,
    });

    // BASE plan meshes drive the tier histogram and builtTriangles: the built
    // figure is the theoretical uncapped world geometry, the floor against which
    // the ceiling proves it cut submitted work rather than the world (P-AC-03).
    const baseMeshes = buildLodRegionMeshes(terrain, { plan: basePlan });

    const tiers = { near: 0, mid: 0, far: 0, skybox: 0 };
    let builtTriangles = 0;

    for (const { region, buffers } of baseMeshes) {
      tiers[region.tier as "near" | "mid" | "far" | "skybox"] += 1;
      builtTriangles += buffers.indices.length / 3;
    }

    const frustum = buildFrustum(makeFrustumCamera(pose.camera, opts?.cullCamera));

    // M-P2: apply the near-budget ceiling (farthest-near-first stride demotion)
    // so drawn reflects the capped plan. Reuses the same frustum + margin as the
    // cull estimate, so the ceiling prediction equals the reported drawn (§6.6).
    const budget = applyNearBudgetCeiling(basePlan, {
      terrain,
      frustum,
      marginM: cullMarginMeters,
      vertexCount: vertexGrid * vertexGrid,
      enabled: opts?.ceilingEnabled !== false,
    });

    // Rebuild meshes only when the ceiling actually demoted a region; otherwise
    // the base meshes already are the effective plan (no wasted allocation).
    const effMeshes =
      budget.demotionCount > 0 ? buildLodRegionMeshes(terrain, { plan: budget.plan }) : baseMeshes;

    // M-P1b: culling is ON. drawn is the frustum-sum of the EFFECTIVE (post-
    // ceiling) plan, never exceeding built. Single estimator shared with the HUD.
    const items: CullItem[] = effMeshes.map(({ buffers }) => ({
      sphere: sphereFromPositions(buffers.positions),
      triangles: buffers.indices.length / 3,
    }));
    const culled = cullEstimate(items, frustum, cullMarginMeters);
    const drawnTriangles = Math.min(culled.drawn, builtTriangles);

    results.push({
      label: pose.label,
      camera: { ...pose.camera },
      tiers,
      builtTriangles,
      drawnTriangles,
      postCull: true,
      activeCap: budget.activeCap,
      capClass: budget.capClass,
      demotionCount: budget.demotionCount,
      nearDominant: budget.nearDominant,
      budgetUnmet: budget.unmet,
    });
  }

  const maxDrawn = results.reduce((mx, r) => Math.max(mx, r.drawnTriangles), 0);

  return {
    poses: results,
    maxDrawn,
    world: { vertices: vertexGrid, meters: worldMeters },
    cullMarginMeters,
  };
}
