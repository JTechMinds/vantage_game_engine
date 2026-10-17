/**
 * TerrainPanelDef — Layer 1 terrain panel definition (data only).
 *
 * Control keys match M-T1 parameter keys exactly (no aliasing). Sections:
 * Terrain Shape (geometry) and Environment (shader-only). Regenerating keys
 * are flagged for debounce per spec §8.2.
 */

import type { ControlDef, PanelDef, SectionDef } from "../../panel/index.ts";
import { createTerrainBinding } from "./TerrainBinding.ts";
import { createTerrainStorageAdapter } from "./TerrainStorageAdapter.ts";

export const TERRAIN_SECTIONS: SectionDef[] = [
  { id: "terrain-shape", label: "Terrain Shape" },
  { id: "environment", label: "Environment" },
];

const BIOME_OPTIONS = [
  { value: "desert", label: "Desert" },
  { value: "highlands", label: "Highlands" },
  { value: "alpine", label: "Alpine" },
  { value: "water", label: "Water" },
  { value: "caribbean", label: "Caribbean" },
];

export const TERRAIN_CONTROLS: ControlDef[] = [
  {
    key: "mountainAggression",
    label: "Mountain Aggression",
    type: "slider",
    section: "terrain-shape",
    order: 1,
    min: 0,
    max: 10,
    step: 0.1,
    default: 5,
    regenerates: true,
  },
  {
    key: "valleyAggression",
    label: "Valley Aggression",
    type: "slider",
    section: "terrain-shape",
    order: 2,
    min: 0,
    max: 10,
    step: 0.1,
    default: 4,
    regenerates: true,
  },
  {
    key: "riverAggression",
    label: "River Aggression",
    type: "slider",
    section: "terrain-shape",
    order: 3,
    min: 0,
    max: 10,
    step: 0.1,
    default: 3,
    regenerates: true,
  },
  {
    key: "elevation",
    label: "Elevation",
    type: "slider",
    section: "terrain-shape",
    order: 4,
    min: 0,
    max: 10,
    step: 0.1,
    default: 5,
    regenerates: true,
  },
  {
    key: "biome",
    label: "Biome",
    type: "select",
    section: "terrain-shape",
    order: 5,
    default: "highlands",
    options: BIOME_OPTIONS,
    regenerates: true,
  },
  {
    key: "seed",
    label: "Seed",
    type: "text",
    section: "terrain-shape",
    order: 6,
    default: 1,
    regenerates: true,
    tooltip: "Finite integer seed. Determinism: same seed + params → same terrain.",
  },
  {
    key: "timeOfDay",
    label: "Time of Day",
    type: "slider",
    section: "environment",
    order: 1,
    min: 0,
    max: 24,
    step: 0.1,
    default: 10,
    unit: "hrs",
  },
  {
    key: "windIntensity",
    label: "Wind Intensity",
    type: "slider",
    section: "environment",
    order: 2,
    min: 0,
    max: 10,
    step: 0.1,
    default: 3,
  },
  {
    key: "windDirection",
    label: "Wind Direction",
    type: "slider",
    section: "environment",
    order: 3,
    min: 0,
    max: 359,
    step: 1,
    default: 180,
    unit: "°",
  },
];

export interface TerrainPanelDefOptions {
  binding?: PanelDef["binding"];
  storage?: PanelDef["storage"];
}

export function createTerrainPanelDef(options: TerrainPanelDefOptions = {}): PanelDef {
  return {
    title: "Layer 1 — Terrain",
    sections: TERRAIN_SECTIONS,
    controls: TERRAIN_CONTROLS,
    actions: ["randomize", "reset", "save", "load", "wireframe"],
    binding: options.binding ?? createTerrainBinding(),
    storage: options.storage ?? createTerrainStorageAdapter(),
    mode: "inline",
  };
}
