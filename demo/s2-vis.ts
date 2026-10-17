// S2 draw-time VIS harness: mount renderer with the approved bundle (like the
// demo), drive the camera through a near->mid blend window, and paint the
// per-mesh draw-time morph probe (S2-AC-10) so a browser screenshot proves the
// morph actually activates per draw (no dead code) and the union pair is biased
// (no z-fight). file://-safe: albedo from inlined TEX_DATA data URLs.
import { createTerrainLayer, DEFAULT_WORLD_SIZE } from "../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../src/engine/layer1/renderer/terrain-renderer.ts";
import { buildTextureBundle } from "../src/engine/layer1/renderer/textures.ts";
import { TEX_DATA } from "./approved-textures-data.js";
import terrainManifest from "../assets/layer1/texture-manifest.json";

const canvas = document.createElement("canvas") as HTMLCanvasElement;
canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0";
document.body.appendChild(canvas);
canvas.width = window.innerWidth; canvas.height = window.innerHeight;

const overlay = document.createElement("pre");
overlay.style.cssText = "position:fixed;left:8px;top:8px;color:#0f0;background:rgba(0,0,0,.75);font:12px monospace;padding:8px;z-index:9;max-width:70vw;white-space:pre-wrap";
document.body.appendChild(overlay);

const terrain = createTerrainLayer({ worldSize: DEFAULT_WORLD_SIZE });
terrain.setParams({ seed: 7, biome: "caribbean" } as never);
terrain.generate();
const bundle = buildTextureBundle(terrainManifest as any, {
  usePlaceholders: false,
  sourcePathFor: (asset: any, map: any) =>
    asset.targetSurface === "sky"
      ? "../assets/layer1/sky/" + asset.name + ".hdr"
      : (map === "albedo" && (TEX_DATA as any)[asset.targetSurface])
        ? (TEX_DATA as any)[asset.targetSurface]
        : "../assets/layer1/textures/" + asset.targetSurface + "/" + map + "." + (map === "albedo" ? "jpg" : "png"),
});
const renderer = createTerrainRenderer({ terrain, canvas, textureBundle: bundle, lodConfig: { nearM: 60, maxMidM: 160, maxFarM: 400 } });
renderer.mount();
renderer.resize();
const anyR = renderer as any;

let blendZ = -1;
for (let d = 30; d <= 240; d += 2) {
  anyR.setCamera({ x: 0, y: d * 0.5, z: d, targetX: 0, targetY: 0, targetZ: 0 });
  const gs = anyR.geomorphStats();
  if (gs && gs.blendRegionCount > 0) { blendZ = d; break; }
}

function renderProbe(): string {
  if (blendZ < 0) return "NO-BLEND-FOUND (tune lodConfig)";
  anyR.setCamera({ x: 0, y: blendZ * 0.5, z: blendZ, targetX: 0, targetY: 0, targetZ: 0 });
  const p = anyR.geomorphProbe();
  const vis = p.meshes.filter((m: any) => m.visible);
  const activeUnion = vis.filter((m: any) => m.active);
  const lines: string[] = [];
  lines.push("blendZ=" + blendZ + " blendRegions=" + p.blendRegions + " unionActive=" + activeUnion.length + "/" + vis.length);
  lines.push("storeActive(afterDraw)=" + p.storeActive + " storeT=" + p.storeT);
  lines.push("visible meshes:");
  for (const m of vis) {
    lines.push("  " + m.name + " active=" + m.active + " t=" + m.t + " role=" + m.role + " hook=" + m.hasHook + " mapBound=" + m.mapBound);
  }
  const allHooked = activeUnion.every((m: any) => m.hasHook);
  const mapsBound = activeUnion.length === 0 || p.storeActive === 1;
  lines.push("AC-10 " + (activeUnion.length > 0 && allHooked && mapsBound ? "PASS" : "CHECK") + " (union morph active + hook installed + map bound)");
  return lines.join(String.fromCharCode(10));
}

const probe = renderProbe();
overlay.textContent = "S2-VIS draw-time morph" + String.fromCharCode(10) + probe;
(window as any).__s2 = { renderer, probe };
let f = 0;
(function loop(){ f++; anyR.setCamera({ x: 0, y: blendZ>0?blendZ*0.5:90, z: (blendZ>0?blendZ:120) + Math.sin(f*0.02)*30, targetX: 0, targetY: 0, targetZ: 0 }); requestAnimationFrame(loop); })();
