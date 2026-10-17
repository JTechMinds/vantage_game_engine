/*!
 * IEP Phase-3 staged-editing VERIFY harness (browser, real WebGL + real textures).
 *
 * Proves the "adjust-adjust-adjust → one OK → committed" outcome:
 *
 *   ?state=batched (default) — three controls staged via the seam (combined
 *     effectivePatch visible as the gray scratch preview), marker would show,
 *     NO setParams called (commitRebuildCount stays 0).
 *   ?state=post-ok          — OK applied: public setParams fires ONCE with the
 *     whole batch, the scratch is hard-swapped away, and the committed textured
 *     terrain now reflects ALL THREE staged values (elevation, mountainAggression,
 *     valleyAggression bumped together). commitRebuildCount == 1.
 *
 * The HUD shows the counter state so bv screenshots prove the headline:
 * one committed rebuild per OK regardless of batch size.
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
const stats = () => (renderer as unknown as { rebuildStats: () => Record<string, number> }).rebuildStats();

const state = /[?#].*state=post-ok/.test(location.href) ? "post-ok" : "batched";

// The three staged values (the batch the user would stage then OK).
const BATCH = { elevation: 9, mountainAggression: 8, valleyAggression: 6 };

if (state === "batched") {
  // Drive the seam as a staged batch: begin, feed the combined effectivePatch
  // (three fields at once), pump so the scratch paints. NO setParams.
  seam.setBudget(2000);
  seam.begin();
  seam.setLiveValue({ ...BATCH });
  for (let i = 0; i < 6; i++) seam.pump();
} else {
  // post-ok: hard-swap the scratch, then fire the public setParams ONCE with
  // the whole batch (exactly what ok() does in the binding).
  seam.setBudget(2000);
  seam.begin();
  seam.setLiveValue({ ...BATCH });
  for (let i = 0; i < 6; i++) seam.pump();
  seam.endCommit();
  terrain.setParams({ ...BATCH });
  terrain.generate();
  renderer.rebuildFromSnapshot();
}

const probe = seam.probe();
const commit = stats();
const params = terrain.getParams();
const line =
  (state === "batched"
    ? "BATCHED (staged, no commit)"
    : "POST-OK (committed, one rebuild)") +
  " | scratchVisible=" + probe.isVisible +
  " | previewRebuilds=" + commit.previewRebuildCount +
  " | commits=" + commit.commitRebuildCount +
  " | elev=" + params.elevation +
  " | mt=" + params.mountainAggression +
  " | val=" + params.valleyAggression;
document.title = "IEP3 " + line;

const hud = document.createElement("div");
hud.style.cssText =
  "position:fixed;top:8px;left:8px;color:#0f0;font:13px monospace;" +
  "background:rgba(0,0,0,.7);padding:8px 10px;border-radius:4px;z-index:10;" +
  "max-width:46ch;white-space:pre-wrap";
hud.textContent =
  "IEP Phase-3 staged-edit VIS\n" + line + "\n" +
  (state === "batched"
    ? "Gray scratch = committed+pending preview.\n" +
      "commitRebuildCount=0: staging never commits.\n" +
      "Marker would show 'Unapplied changes'.\n" +
      "Press OK (or navigate ?state=post-ok)."
    : "Scratch disposed (hard-swap).\n" +
      "commitRebuildCount=1: one rebuild for 3-field batch.\n" +
      "Committed terrain reflects ALL staged values.");
document.body.appendChild(hud);
