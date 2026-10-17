/**
 * Layer2PanelDef — dummy Layer 2 panel (reuse proof, L1-AC-039).
 *
 * Imports ONLY from the reusable panel module (../../panel/index.ts) and its
 * own local binding. Zero imports from layer1/terrain, layer1/core, engine
 * internals, biome enums, or heightfield utilities. A CI/test audit enforces
 * this (spec §6.3, §9 risk table).
 *
 * Demonstrates modal mode while the terrain panel is inline (spec §2.11).
 */

import type { PanelDef } from "../../panel/index.ts";
import { createLayer2Binding } from "./Layer2Binding.ts";

export function createLayer2PanelDef(): PanelDef {
  return {
    title: "Layer 2 — Object Placement (Stub)",
    sections: [
      { id: "placement", label: "Placement" },
      { id: "display", label: "Display" },
    ],
    controls: [
      {
        key: "objectCount",
        label: "Object Count",
        type: "slider",
        section: "placement",
        order: 1,
        min: 0,
        max: 100,
        step: 1,
        default: 10,
      },
      {
        key: "showGrid",
        label: "Show Grid",
        type: "toggle",
        section: "display",
        order: 1,
        defaultBool: false,
      },
    ],
    actions: ["reset"],
    binding: createLayer2Binding(),
    mode: "modal",
  };
}
