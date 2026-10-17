/*!
 * IEP Phase-2 live-preview VERIFY harness (browser, real WebGL + real textures).
 *
 * Boots a real MOUNTED renderer with the approved CC0 texture bundle, then
 * drives the non-enumerable preview seam and LEAVES an active disposable scratch
 * preview on screen WITHOUT committing, so a bv screenshot proves the flat-shaded
 * gray unlit scratch mesh is painted during a held drag (IEP-AC-04b). A second
 * hash state performs the hard-swap (endCommit) so the next screenshot proves
 * the scratch is gone and only the committed textured terrain remains
 * (IEP-AC-04 hard-swap).
 *
 * Contrast strategy: committed terrain is a SHORT low textured biome (colored,
 * lit); the preview is a TALL alpine-shaped gray UNLIT sheet that towers over
 * and hides it while active, and vanishes on the hard-swap. The budget guard is
 * relaxed to a generous value so a regen is guaranteed to land in the harness;
 * the budget-drop ladder itself is covered by the unit gates.
 *
 *   ?preview=1 (default) -> preview active (tall gray sheet visible)
 *   ?preview=0           -> hard-swap done (only short textured terrain remains)
 *
 * document.title + an on-screen HUD carry the seam probe state (bv has no
 * console).
 */
import { createTerrainLayer, DEFAULT_WORLD_SIZE } from "../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../src/engine/layer1/renderer/terrain-renderer.ts";
import { buildTextureBundle } from "../src/engine/layer1/renderer/textures.ts";
import { TEX_DATA } from "./approved-textures-data.js";
import terrainManifest from "../assets/layer1/texture-manifest.json";

window.addEventListener("error", (e) => {
  document.title = "ERR: " + (e.message || "unknown").slice(0, 120);
});

interface SeamProbe {
  present: boolean;
  isVisible: boolean;
  gridN: number;
  farGridN: number;
  sampleHeight: number;
}
interface Seam {
  begin(): void;
  setLiveValue(patch: Record<string, unknown>): void;
  pump(): void;
  endCommit(): void;
  cancel(): void;
  dispose(): void;
  probe(): SeamProbe;
  setBudget(ms: number): void;
}

const canvas = document.createElement("canvas");
document.body.style.margin = "0";
canvas.style.display = "block";
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
document.body.appendChild(canvas);

// Real textured bundle so the committed terrain is unmistakably COLORED/LIT
// against the flat gray UNLIT preview scratch.
const bundle = buildTextureBundle(terrainManifest as never, {
  usePlaceholders: false,
  sourcePathFor: (asset: never, map: never) =>
    (asset as { targetSurface: string }).targetSurface === "sky"
      ? `../assets/layer1/sky/${(asset as { name: string }).name}.hdr`
      : (map === "albedo" && (TEX_DATA as Record<string, string>)[(asset as { targetSurface: string }).targetSurface])
        ? (TEX_DATA as Record<string, string>)[(asset as { targetSurface: string }).targetSurface]
        : `../assets/layer1/textures/${(asset as { targetSurface: string }).targetSurface}/${map}.${map === "albedo" ? "jpg" : "png"}`,
});

const terrain = createTerrainLayer({ worldSize: DEFAULT_WORLD_SIZE });
// Committed: SHORT low textured biome so the tall preview clearly stands out.
terrain.setParams({
  seed: 7788,
  biome: "caribbean",
  elevation: 1,
  mountainAggression: 1,
  valleyAggression: 1,
  riverAggression: 0,
});
terrain.generate();

const renderer = createTerrainRenderer({ terrain, canvas, textureBundle: bundle });
renderer.mount();
renderer.setCamera({ x: 0, y: 120, z: 300, targetX: 0, targetY: 40, targetZ: 0 });

const seam = (renderer as unknown as { preview: Seam }).preview;
const wantPreview = !/[?#].*preview=0/.test(location.href);

// Relax the frame budget in the harness so the coarse regen is accepted and the
// scratch actually paints (the ladder is unit-tested separately).
seam.setBudget(2000);
seam.begin();
// Preview: TALL alpine-shaped gray unlit sheet that towers over the low dunes.
seam.setLiveValue({ elevation: 10, mountainAggression: 10, valleyAggression: 0 });
for (let i = 0; i < 6; i++) seam.pump();

if (!wantPreview) {
  seam.endCommit(); // hard-swap: dispose scratch; committed terrain remains
}

const probe = seam.probe();
const commit = (renderer as unknown as { rebuildStats: () => Record<string, number> }).rebuildStats();
const line =
  (wantPreview ? "PREVIEW-ON" : "PREVIEW-OFF (hard-swap)") +
  " | scratchVisible=" + probe.isVisible +
  " grid=" + probe.gridN + "/" + probe.farGridN +
  " previewRebuilds=" + commit.previewRebuildCount +
  " commits=" + commit.commitRebuildCount;
document.title = "IEP2 " + line;

const hud = document.createElement("div");
hud.style.cssText = "position:fixed;top:8px;left:8px;color:#0f0;font:14px monospace;background:rgba(0,0,0,.6);padding:6px;z-index:10";
hud.textContent = document.title;
document.body.appendChild(hud);
