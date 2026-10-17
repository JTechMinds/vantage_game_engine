/**
 * Layer 1 M-T5 interactive consumer demo.
 *
 * A standalone, independently-playable shell: Jordan can open this page and
 * drive every terrain parameter, switch presets, type a seed, toggle wireframe,
 * and save/reload — without editing source. It is a pure CONSUMER of the frozen
 * M-T1 public API (via TerrainBinding), the reusable M-T3 PanelShell, and the
 * M-T2/M-T4 renderer. It imports no terrain or renderer internals and adds no
 * new engine surface.
 *
 * Architecture:
 *  - One shared TerrainLayer instance is the single source of truth.
 *  - The renderer subscribes to that layer's public events (mount()); any
 *    parameter change the panel makes through TerrainBinding flows to the mesh
 *    automatically (geometry-affecting → rebuild, appearance-only → relight).
 *  - The panel is mounted from createTerrainPanelDef with a binding whose
 *    factory returns the SAME layer, so the panel, the renderer, and the preset
 *    bar all drive one terrain.
 *  - Camera is a free-fly rig (drag to look, WASD camera-relative, Q/E
 *    world-vertical, Shift boost) driven through the public setCamera pose only.
 *
 * Regression posture: the M-T4 hash-driven capture path (#preset=, #cam=,
 * #time=, #wind=, #wire=, #lod=, #nosky=, ?basic=1, ?seamcheck=1, ?debug=1) is
 * preserved so existing Gate VIS evidence still reproduces. The panel and fly
 * controls are additive and never fire during a hash-only capture unless the
 * user interacts. bv screenshots still surface boot errors via document.title.
 */

import { createTerrainLayer, DEFAULT_WORLD_SIZE } from "../src/engine/layer1/terrain/index.ts";
import { createTerrainRenderer } from "../src/engine/layer1/renderer/terrain-renderer.ts";
import { TEX_DATA } from "./approved-textures-data.js";
import { buildTextureBundle } from "../src/engine/layer1/renderer/textures.ts";
import terrainManifest from "../assets/layer1/texture-manifest.json";
import { mountPanel, type PanelHandle } from "../src/ui/panel/index.ts";
import { createTerrainPanelDef } from "../src/ui/layers/terrain/TerrainPanelDef.ts";
import { createTerrainBinding } from "../src/ui/layers/terrain/TerrainBinding.ts";
import { createTerrainStorageAdapter } from "../src/ui/layers/terrain/TerrainStorageAdapter.ts";
import type { CameraPose, LodTier } from "../src/engine/layer1/renderer/types.ts";
import { poseFromFly } from "../src/engine/layer1/renderer/fly-camera.ts";
import { createFlyControls, flyStateFromPose } from "./fly-controls.ts";

/* ------------------------------------------------------------------ */
/* Error visibility                                                    */
/* ------------------------------------------------------------------ */

// The bv harness has no console access; the title is the only readable channel.
window.addEventListener("error", (e) => {
  document.title = "ERR: " + (e.message || "unknown").slice(0, 120);
});
window.addEventListener("unhandledrejection", (e: any) => {
  document.title = "REJ: " + String((e && e.reason && e.reason.message) || e.reason || "?").slice(0, 120);
});

/* ------------------------------------------------------------------ */
/* Debug flags (bv capture toggles)                                    */
/* ------------------------------------------------------------------ */

(window as any).__nosky = /[?#].*nosky=1/.test(location.href);
(globalThis as any).__noshader = /[?#].*noshader=1/.test(location.href);
(globalThis as any).__noibl = /[?#].*noibl=1/.test(location.href);
(globalThis as any).__albedoflat = /[?#].*albedoflat=1/.test(location.href);
const DEBUG = /[?#].*debug=1/.test(location.href);

// M-T5 AC-M5-016: ?shell=0 hides the interactive control shell (panel, preset
// bar, preset-state badge, HUD) for clean VIS captures. Render, camera, and the
// hash-driven boot path are untouched — only the chrome is hidden via CSS.
const CLEAN_SHELL = /[?].*shell=0/.test(location.href);

/* ------------------------------------------------------------------ */
/* Shared terrain — single source of truth                             */
/* ------------------------------------------------------------------ */

const terrain = createTerrainLayer({ worldSize: DEFAULT_WORLD_SIZE });

/* ------------------------------------------------------------------ */
/* Presets (in-app switching)                                          */
/* ------------------------------------------------------------------ */

interface Preset {
  seed: number;
  biome: string;
  elevation: number;
  mountainAggression: number;
  valleyAggression: number;
  riverAggression: number;
  time: number;
  wind: string; // "intensity/direction"
}

const PRESETS: Record<string, Preset> = {
  caribbean: { seed: 7788, biome: "caribbean", elevation: 2, mountainAggression: 3, valleyAggression: 3, riverAggression: 1, time: 11, wind: "5/220" },
  alpine: { seed: 1337, biome: "alpine", elevation: 8, mountainAggression: 9, valleyAggression: 6, riverAggression: 3, time: 15, wind: "5/200" },
  highlands: { seed: 4242, biome: "highlands", elevation: 5, mountainAggression: 5, valleyAggression: 5, riverAggression: 2, time: 16, wind: "3/180" },
  desert: { seed: 909, biome: "desert", elevation: 3, mountainAggression: 4, valleyAggression: 7, riverAggression: 1, time: 13, wind: "6/140" },
};

// Preset-specific review framings so a one-click preset also frames well.
const PRESET_FRAMINGS: Record<string, CameraPose> = {
  caribbean: { x: 70, y: 130, z: 250, targetX: 0, targetY: -1, targetZ: 70 },
  alpine: { x: -60, y: 160, z: 140, targetX: 0, targetY: 60, targetZ: 0 },
  highlands: { x: 80, y: 90, z: 120, targetX: 0, targetY: 10, targetZ: 0 },
  desert: { x: 120, y: 70, z: 180, targetX: 0, targetY: 5, targetZ: 0 },
};

function bootPresetName(): string | null {
  const pn = new URLSearchParams(location.hash.replace(/^#/, "")).get("preset");
  return pn && PRESETS[pn] ? pn : null;
}

const BOOT_PRESET = bootPresetName();

/* ------------------------------------------------------------------ */
/* Boot parameters                                                     */
/* ------------------------------------------------------------------ */

const bootPreset = BOOT_PRESET ? PRESETS[BOOT_PRESET] : PRESETS.alpine;
terrain.setParams({
  seed: bootPreset.seed,
  biome: bootPreset.biome as never,
  elevation: bootPreset.elevation,
  mountainAggression: bootPreset.mountainAggression,
  valleyAggression: bootPreset.valleyAggression,
  riverAggression: bootPreset.riverAggression,
});
terrain.generate();

/* ------------------------------------------------------------------ */
/* Canvas + renderer                                                   */
/* ------------------------------------------------------------------ */

function acquireCanvas(): HTMLCanvasElement {
  const existing = document.getElementById("terrain-canvas");
  if (existing instanceof HTMLCanvasElement) return existing;
  const canvas = document.createElement("canvas");
  canvas.id = "terrain-canvas";
  document.body.appendChild(canvas);
  return canvas;
}

const canvas = acquireCanvas();
canvas.width = canvas.clientWidth || window.innerWidth;
canvas.height = canvas.clientHeight || window.innerHeight;

// M-T4: bind the approved CC0 PBR bundle (real pixels) instead of dev placeholders.
// Paths are root-relative so the static server (repo root) resolves them; albedo maps
// come from the inlined TEX_DATA data URLs so a file:// capture is not cross-origin tainted.
const __ph = /[?#].*ph=1/.test(location.href);
const approvedBundle = buildTextureBundle(terrainManifest as any, {
  usePlaceholders: __ph,
  sourcePathFor: (asset: any, map: any) =>
    asset.targetSurface === "sky"
      ? `../assets/layer1/sky/` + asset.name + `.hdr`
      : (map === "albedo" && (TEX_DATA as any)[asset.targetSurface])
        ? (TEX_DATA as any)[asset.targetSurface]
        : `../assets/layer1/textures/` + asset.targetSurface + `/` + map + `.` + (map === "albedo" ? "jpg" : "png"),
});
const renderer = createTerrainRenderer({ terrain, canvas, textureBundle: approvedBundle });
renderer.mount();

/* ------------------------------------------------------------------ */
/* PanelShell — drives the SAME terrain through the frozen binding      */
/* ------------------------------------------------------------------ */

injectPanelStyles();

const panelContainer = document.createElement("aside");
panelContainer.id = "panel-container";
document.body.appendChild(panelContainer);

const binding = createTerrainBinding(() => terrain);
const storage = createTerrainStorageAdapter();
const panelDef = createTerrainPanelDef({ binding, storage });
// IEP Phase-2: forward the renderer non-enumerable preview seam onto the panel
// def so a regenerates-control drag drives the live scratch preview. The seam
// is devOnly (invisible to Object.keys); reading it here is the bounded
// composition-site wiring, not a public-surface change.
panelDef.previewSeam = (renderer as unknown as {
  preview?: {
    begin(): void;
    setLiveValue(patch: Record<string, unknown>): void;
    endCommit(): void;
    cancel(): void;
    dispose(): void;
  };
}).preview;
// IEP Usability F1: forward the renderer's non-enumerable devOnly committed-
// terrain visibility hook (debugHideSky family) onto the panel def so the
// staged-edit preview occludes committed terrain. Same bounded composition-site
// cast as previewSeam — NOT a public-surface change, NOT a seam widening.
panelDef.committedVisibility = (renderer as unknown as {
  setCommittedVisible?: (on: boolean) => void;
}).setCommittedVisible
  ? { set: (on) => (renderer as unknown as { setCommittedVisible: (o: boolean) => void }).setCommittedVisible(on) }
  : undefined;
// IEP Usability F2: a banner host pinned to the TOP of the scene viewport. The
// shell renders the marker + OK + Cancel here (instead of the in-panel row)
// when present. z-index 50: above the canvas, below the F3 overlay (60), and
// clear of the preset bar (30) / panel (40). pointer-events none on the host
// so it never blocks the canvas except where the banner itself sits.
const bannerHost = document.createElement("div");
bannerHost.id = "edit-banner-host";
document.body.appendChild(bannerHost);
/* VIS forced-delay shim (?vis=overlay): install BEFORE mountPanel so the panel
   controller captures the shimmed binding. Parks Committing with a synchronous
   generation-started and lands the real commit 4s later, so the F3 overlay is
   painted and capturable mid-generation on the otherwise-synchronous engine. */
if (new URLSearchParams(location.search).get("vis") === "overlay") {
  const real = panelDef.binding;
  const regs = new Map<string, Set<(p: unknown) => void>>();
  const emit = (ev: string, payload: unknown): void => { for (const fn of regs.get(ev) ?? []) fn(payload); };
  for (const ev of ["terrain-changed", "generation-started", "generation-complete", "error"]) {
    real.on(ev, (payload: unknown) => emit(ev, payload));
  }
  panelDef.binding = {
    ...real,
    on(ev, h) { if (!regs.has(ev)) regs.set(ev, new Set()); regs.get(ev)!.add(h); return () => { regs.get(ev)!.delete(h); }; },
    setParams(patch: Record<string, unknown>) {
      emit("generation-started", {}); // generationInFlight=true -> Committing holds
      setTimeout(() => real.setParams(patch), Number(new URLSearchParams(location.search).get("visdelay")) || 4000);
    },
  };
}

let panelHandle: PanelHandle | null = null;
try {
  panelHandle = mountPanel(panelDef, { container: panelContainer, className: "terrain-panel", bannerContainer: bannerHost });
} catch (e) {
  document.title = "PANEL ERR: " + (e instanceof Error ? e.message : String(e)).slice(0, 100);
}

/* ------------------------------------------------------------------ */
/* VIS harness hook (IEP usability cert) — ?vis=stage|commit|cancel|overlay |
/* Drives the REAL panel DOM (same event path a pointer uses) so the      */
/* browser-vision captures show the PRODUCTION UI states:                 */
/*   stage   — committed hidden, gray scratch + viewport-top banner        */
/*   cancel  — staged -> Cancel: committed restored, zero commit           */
/*   commit  — staged -> OK on the real sync engine (reveal timing)        */
/*   overlay — forced-delay stand-in (Phase-3 IEP-AC-09 precedent): the   */
/*             binding holds the commit 1.5s so the F3 overlay is painted */
/*             and capturable mid-generation on the synchronous build.    */
/* Query-param gated: absent param = untouched production demo.            */
/* ------------------------------------------------------------------ */
const VIS = new URLSearchParams(location.search).get("vis");
if (VIS) {
  const drive = (): void => {
    const el = document.querySelector<HTMLInputElement>('input[data-control-key="elevation"]');
    if (!el) { setTimeout(drive, 50); return; }
    const set = (v: string, type: string): void => {
      el.value = v;
      el.dispatchEvent(new Event(type, { bubbles: true }));
    };
    set("9", "input");
    set("9", "change"); // stage (release)
    if (VIS === "stage") return;
    const btn = document.querySelector<HTMLButtonElement>(
      VIS === "cancel" ? 'button[data-role="cancel-edit"]' : 'button[data-role="ok-batch"]',
    );
    if (btn) setTimeout(() => btn.click(), 900);
  };
  setTimeout(drive, 300);
}

// Keep the renderer's wireframe overlay authoritative from the terrain param.
// The panel's wireframe action calls binding.setWireframe → layer.setWireframe,
// which emits terrain-changed; we mirror it onto the renderer here so the two
// never diverge. (The frozen renderer API is the only writer of its own state.)
terrain.on("terrain-changed", () => {
  const on = (terrain.getParams() as Record<string, unknown>)["wireframe"] === true;
  renderer.setWireframe(on);
});

/* ------------------------------------------------------------------ */
/* Preset bar                                                          */
/* ------------------------------------------------------------------ */

const presetBar = document.createElement("div");
presetBar.id = "preset-bar";
document.body.appendChild(presetBar);
for (const name of Object.keys(PRESETS)) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preset-btn";
  btn.textContent = name;
  btn.dataset.preset = name;
  btn.addEventListener("click", () => applyPreset(name));
  presetBar.appendChild(btn);
}

// M-T5 AC-M5-008: visible preset-state badge. Shows the active preset name when
// the current controls exactly match a preset, else "Custom". Drives off the
// frozen public getParams() only; recomputed on every HUD tick and after preset
// apply, so manual panel edits flip it to Custom live and preset clicks clear it.
const presetState = document.createElement("div");
presetState.id = "preset-state";
document.body.appendChild(presetState);

function currentPresetName(): string | null {
  const p = terrain.getParams() as Record<string, unknown>;
  for (const [name, pre] of Object.entries(PRESETS)) {
    const [wi, wd] = pre.wind.split("/");
    if (
      p.seed === pre.seed &&
      p.biome === pre.biome &&
      p.elevation === pre.elevation &&
      p.mountainAggression === pre.mountainAggression &&
      p.valleyAggression === pre.valleyAggression &&
      p.riverAggression === pre.riverAggression &&
      p.timeOfDay === pre.time &&
      p.windIntensity === Number(wi) &&
      p.windDirection === Number(wd ?? 0)
    ) {
      return name;
    }
  }
  return null;
}

function updatePresetState(): void {
  const m = currentPresetName();
  if (m) {
    presetState.textContent = "Preset: " + m;
    presetState.classList.remove("is-custom");
  } else {
    presetState.textContent = "Custom";
    presetState.classList.add("is-custom");
  }
}

/** Apply a preset through the frozen public API, then re-frame the camera. */
function applyPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  const [wi, wd] = p.wind.split("/");
  terrain.setParams({
    seed: p.seed,
    biome: p.biome as never,
    elevation: p.elevation,
    mountainAggression: p.mountainAggression,
    valleyAggression: p.valleyAggression,
    riverAggression: p.riverAggression,
    timeOfDay: p.time,
    windIntensity: Number(wi),
    windDirection: Number(wd ?? 0),
  });
  terrain.generate();
  const fr = PRESET_FRAMINGS[name];
  if (fr) {
    flyControls.setState(flyStateFromPose(fr));
  }
  markActivePreset(name);
  panelHandle?.refresh();
  updateHud();
}

function markActivePreset(name: string): void {
  for (const b of Array.from(presetBar.querySelectorAll(".preset-btn"))) {
    (b as HTMLElement).classList.toggle("is-active", (b as HTMLElement).dataset.preset === name);
  }
}

/* ------------------------------------------------------------------ */
/* Camera free-fly rig (public setCamera pose only)                    */
/* ------------------------------------------------------------------ */

// M-P1a coalescing (spec 3.4): raw pointer/key handlers never call
// renderer.setCamera per event. They mutate FlyState / the held-key snapshot
// and flag cameraDirty; the rAF tick() applies at most ONE setCamera per
// frame. Combined with the renderer rebuild guard, that bounds geometry
// rebuilds to <=1/frame and removes the 0-FPS stall. The renderer itself stays
// scheduler-free (no rAF wrapper inside it).
let cameraDirty = false;

// PA-1a-08 coalescing primitive (spec 6 COMPAT-1): retained under its literal
// name so tests/layer1/renderer/camera-rebuild-guard.test.ts stays green
// UNCHANGED. It flags the pose dirty and never calls renderer.setCamera.
function cameraFromOrbit(): void {
  cameraDirty = true;
}

// The fly input controller (demo/fly-controls.ts): the ONLY place the fly
// gesture surface touches the DOM. Imported by the demo shell only, never by
// terrain-renderer.ts's factory, so the renderer's enumerable surface stays
// byte-identical (COMPAT-2). It translates canvas pointer + window key events
// into FlyState/FlyInput and calls cameraFromOrbit() to flag the coalescing
// flag; the tick() below is the single setCamera site.
const flyControls = createFlyControls({
  canvas,
  onPoseDirty: () => { cameraFromOrbit(); },
});

/**
 * Step the camera through a sequence of distances to exercise all LOD tiers.
 * Returns tier counts at each stop so the bv harness can assert determinism
 * and seam integrity without parsing pixels.
 */
function stepLOD(): Array<{ distance: number; tiers: Record<LodTier, number> }> {
  const stops = [50, 150, 350, 700];
  const results: Array<{ distance: number; tiers: Record<LodTier, number> }> = [];
  for (const d of stops) {
    flyControls.setState(flyStateFromPose({ x: 0, y: Math.max(60, d * 0.5), z: d, targetX: 0, targetY: 0, targetZ: 0 }));
    const regions = renderer.getLodRegions();
    const tiers: Record<LodTier, number> = { near: 0, mid: 0, far: 0, skybox: 0 };
    for (const r of regions) tiers[r.tier] += 1;
    results.push({ distance: d, tiers });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Debug overlays                                                      */
/* ------------------------------------------------------------------ */

let lodDebugOn = false;
function toggleLodDebug(): boolean {
  lodDebugOn = !lodDebugOn;
  renderer.setLodDebug(lodDebugOn);
  return lodDebugOn;
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */

const hud = document.createElement("div");
hud.id = "terrain-hud";
if (DEBUG || true) document.body.appendChild(hud);

function updateHud(): void {
  const status = renderer.getStatus();
  const regions = renderer.getLodRegions();
  const counts: Record<LodTier, number> = { near: 0, mid: 0, far: 0, skybox: 0 };
  for (const r of regions) counts[r.tier] += 1;
  const fps = frameCount > 0 ? Math.round((frameCount * 1000) / (performance.now() - bootTime)) : 0;
  // P-AC-07: the headline triangle number is DRAWN (post-cull), not built.
  // renderStats() is a non-enumerable devOnly diagnostic; in a mounted browser
  // it tracks the real gl.info.render.triangles, and in M-P0 (culling off)
  // drawn==built with the culled flag telling the reader it is the no-cull
  // state. Never widen the public renderer surface for this.
  const rs = (renderer as any).renderStats ? (renderer as any).renderStats() : null;
  updatePresetState();
  const sn = terrain.snapshot();
  hud.textContent =
    `M-T5 Demo | ${fps} fps | drag=look · WASD=fly · Q/E=up/down · Shift=boost\n` +
    `World: ${sn.worldSize.vertices}×${sn.worldSize.vertices} verts\n` +
    `LOD: near=${counts.near} mid=${counts.mid} far=${counts.far} sky=${counts.skybox}\n` +
    `Drawn: ${rs ? rs.drawn : '?'} tris | built=${rs ? rs.built : '?'} | culled=${rs && rs.culled ? 'on' : 'off'}\n` +
    `Textures: ${status.textureStatus} | Gate VIS: ${status.textureStatus === "approved" ? "READY" : "BLOCKED"}\n` +
    `Mesh integrity: ${status.mesh ? (status.mesh.pass ? "PASS" : "FAIL") : "pending"}\n` +
    `h=[${sn.heightMin.toFixed(1)},${sn.heightMax.toFixed(1)}]m\n` +
    (DEBUG ? renderer.debugSceneSummary() : "");
}

/* ------------------------------------------------------------------ */
/* Resize                                                              */
/* ------------------------------------------------------------------ */

// Canvas CSS is fixed inset:0 (100vw/100vh), so the layout box tracks the
// viewport; the backing store and camera aspect must be re-synced through the
// public renderer.resize() hook (gl.setSize + aspect + updateProjectionMatrix).
// Called on boot and on every window resize so the scene always refits.
function fitViewport(): void {
  renderer.resize();
}
window.addEventListener("resize", fitViewport);
fitViewport();

/* ------------------------------------------------------------------ */
/* Expose for bv harness and devtools console                          */
/* ------------------------------------------------------------------ */

(window as any).__terrain = terrain;
(window as any).__terrainRenderer = renderer;
(window as any).__panel = panelHandle;
(window as any).flyControls = flyControls;
(window as any).applyPreset = applyPreset;
(window as any).stepLOD = stepLOD;
(window as any).toggleLodDebug = toggleLodDebug;

/* ------------------------------------------------------------------ */
/* Hash-driven boot (M-T4 capture path — preserved)                    */
/* ------------------------------------------------------------------ */

function applyHashOptions(): void {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const presetName = h.get("preset");
  if (presetName && PRESETS[presetName]) {
    applyPreset(presetName);
    return;
  }
  // Appearance-only hash overrides (router relights without a geometry rebuild).
  const patch: Record<string, unknown> = {};
  if (h.get("time")) patch.timeOfDay = Number(h.get("time"));
  if (h.get("wind")) {
    const [i, d] = String(h.get("wind")).split("/");
    patch.windIntensity = Number(i);
    patch.windDirection = Number(d ?? 0);
  }
  if (Object.keys(patch).length > 0) terrain.setParams(patch as never);
  if (h.get("lod") === "on") toggleLodDebug();
  if (h.get("nosky") === "1") {
    (window as any).__hideSky = true;
    (renderer as any).debugHideSky && (renderer as any).debugHideSky(true);
  }
  if (h.get("wire") === "on") terrain.setParams({ wireframe: true } as never);

  const cam = h.get("cam");
  const hgt = h.get("h");
  if (cam || hgt) {
    flyControls.setState(flyStateFromPose({ x: (cam ? Number(cam) : 150), y: (hgt ? Number(hgt) : 120), z: 0, targetX: 0, targetY: 0, targetZ: 0 }));
  } else {
    // No explicit camera: frame the terrain bbox with a low oblique so the
    // sheet always fills the frame (fixes sky-only default framing).
    const sn = terrain.snapshot();
    const m = sn.worldSize.meters;
    const hm = (sn.heightMin + sn.heightMax) / 2;
    flyControls.setState(flyStateFromPose({ x: m * 0.62, y: sn.heightMax + m * 0.28, z: 0, targetX: 0, targetY: hm, targetZ: 0 }));
  }
}
applyHashOptions();
if (CLEAN_SHELL) document.body.classList.add("clean-shell");
if (/[?#].*basic=1/.test(location.href)) { (renderer as any).debugForceBasic(); }
if (/[?#].*seamcheck=1/.test(location.href)) {
  renderer.setCamera({ x: 0, y: 120, z: 180, targetX: 0, targetY: 0, targetZ: 0 });
  document.title = String((renderer as any).seamCheck());
}

/* ------------------------------------------------------------------ */
/* Fly VIS driver (?vis=fly&phase=1..4) — query-gated, absent = untouched */
/* Dispatches REAL canvas PointerEvents + window KeyboardEvents so the  */
/* production listener path runs, then advances a FIXED number of steps */
/* (deterministic per memory #6) and leaves no keys held, so the tick    */
/* stays stable for a bv frame. Sets document.title to the resulting     */
/* FlyState for readable capture evidence.                              */
/* ------------------------------------------------------------------ */
const FLY_VIS_P = new URLSearchParams(location.search).get("vis");
const FLY_PHASE = FLY_VIS_P === "fly" ? Number(new URLSearchParams(location.search).get("phase") || 0) : -1;
if (FLY_PHASE >= 0) {
  (window as any).__flyVis = (phase: number): void => {
    const cx = Math.floor(canvas.clientWidth / 2);
    const cy = Math.floor(canvas.clientHeight / 2);
    const pev = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0 });
    const kev = (type: string, code: string): KeyboardEvent =>
      new KeyboardEvent(type, { code, bubbles: true });
    const applyN = (n: number): void => {
      for (let i = 0; i < n; i++) {
        if (flyControls.advance(0.016)) cameraFromOrbit();
        renderer.setCamera(poseFromFly(flyControls.getState()));
        cameraDirty = false;
      }
    };
    flyControls.setState({ x: 0, y: 140, z: 220, yaw: 0, pitch: -0.15 });
    if (phase === 1) {
      canvas.dispatchEvent(pev("pointerdown", cx, cy));
      canvas.dispatchEvent(pev("pointermove", cx + 120, cy + 60));
      canvas.dispatchEvent(pev("pointermove", cx + 240, cy + 120));
      window.dispatchEvent(pev("pointerup", cx + 240, cy + 120));
      applyN(1);
    } else if (phase === 2) {
      canvas.dispatchEvent(pev("pointerdown", cx, cy));
      canvas.dispatchEvent(pev("pointermove", cx, cy + 200));
      window.dispatchEvent(pev("pointerup", cx, cy + 200));
      window.dispatchEvent(kev("keydown", "KeyW"));
      applyN(40);
      window.dispatchEvent(kev("keyup", "KeyW"));
    } else if (phase === 3) {
      window.dispatchEvent(kev("keydown", "KeyQ"));
      applyN(40);
      window.dispatchEvent(kev("keyup", "KeyQ"));
    } else if (phase === 4) {
      window.dispatchEvent(kev("keydown", "ShiftLeft"));
      window.dispatchEvent(kev("keydown", "KeyW"));
      applyN(40);
      window.dispatchEvent(kev("keyup", "KeyW"));
      window.dispatchEvent(kev("keyup", "ShiftLeft"));
    }
    const st = flyControls.getState();
    (document as any).title = "FLYVIS:" + phase + ":x" + st.x.toFixed(0) + " y" + st.y.toFixed(0) + " z" + st.z.toFixed(0) + " yaw" + st.yaw.toFixed(2) + " pitch" + st.pitch.toFixed(2);
  };
  setTimeout(() => (window as any).__flyVis(FLY_PHASE), 500);
}

/* ------------------------------------------------------------------ */
/* Render loop                                                         */
/* ------------------------------------------------------------------ */

let bootTime = performance.now();
let frameCount = 0;

let lastTick = performance.now();
requestAnimationFrame(function tick(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  if (flyControls.advance(dt)) cameraFromOrbit();
  if (cameraDirty) {
    renderer.setCamera(poseFromFly(flyControls.getState()));
    cameraDirty = false;
  }
  frameCount += 1;
  updateHud();
  if (frameCount % 30 === 0) {
    bootTime = performance.now();
    frameCount = 0;
  }
  requestAnimationFrame(tick);
});

/* ------------------------------------------------------------------ */
/* Inline panel + shell styles (demo-only; no build-loader dependency) */
/* ------------------------------------------------------------------ */

function injectPanelStyles(): void {
  if (document.getElementById("m-t5-demo-styles")) return;
  const style = document.createElement("style");
  style.id = "m-t5-demo-styles";
  style.textContent = `
    html,body{margin:0;height:100%;background:#0a0d12;overflow:hidden;font-family:system-ui,sans-serif}
    #terrain-canvas{position:fixed;inset:0;width:100vw;height:100vh;display:block;touch-action:none}
    #terrain-hud{position:fixed;top:8px;left:8px;z-index:20;font:12px/1.35 monospace;color:#fff;
      background:rgba(0,0,0,.6);padding:6px 10px;border-radius:4px;pointer-events:none;white-space:pre-line}
    #preset-bar{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:30;
      display:flex;gap:8px;background:rgba(10,13,18,.8);padding:8px 10px;border-radius:10px;
      border:1px solid #2a3140;backdrop-filter:blur(6px)}
    .preset-btn{font:13px/1 system-ui;color:#dfe6f0;background:#1b2330;border:1px solid #33405a;
      padding:8px 14px;border-radius:7px;cursor:pointer;text-transform:capitalize}
    .preset-btn:hover{background:#26314a}
    .preset-btn.is-active{background:#3a6df0;border-color:#5b8bff;color:#fff}
    #panel-container{position:fixed;top:0;right:0;height:100vh;width:340px;z-index:40;overflow-y:auto;
      background:rgba(13,17,24,.94);border-left:1px solid #2a3140;backdrop-filter:blur(8px)}
    @media (max-width:820px){#panel-container{width:100vw;height:46vh;top:auto;bottom:0;border-left:none;border-top:1px solid #2a3140}#preset-bar{bottom:calc(46vh + 8px)}}
    .terrain-panel{padding:14px}
    .panel-shell{color:#cdd6e4}
    .panel-shell__title{font-size:14px;margin:0 0 10px;color:#fff;font-weight:600}
    .panel-section{border:1px solid #263044;border-radius:8px;margin:0 0 12px;padding:10px}
    .panel-section legend{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#7f8da6;padding:0 6px}
    .panel-shell label{display:block;font-size:12px;margin:8px 0 2px;color:#aeb9cc}
    .panel-shell input[type=range]{width:100%}
    .panel-shell input[type=text],.panel-shell select{width:100%;box-sizing:border-box;background:#0e131c;
      color:#e6ecf6;border:1px solid #2c3850;border-radius:5px;padding:6px;font-size:12px}
    .panel-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .panel-actions__button{font:12px system-ui;color:#e6ecf6;background:#1b2330;border:1px solid #33405a;
      padding:6px 10px;border-radius:6px;cursor:pointer}
    .panel-actions__button:hover{background:#26314a}
    .panel-actions__toggle{font-size:12px;color:#aeb9cc;display:flex;align-items:center;gap:6px;margin-top:6px}
    .panel-shell__status{font-size:11px;color:#7f8da6;margin-top:8px;min-height:14px}
    .panel-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;background:#131824;color:#e6ecf6;border:1px solid #33405a;border-radius:10px;padding:16px;min-width:280px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
    .panel-dialog h3{margin:0 0 12px;font-size:14px}
    .panel-dialog input,.panel-dialog select{width:100%;box-sizing:border-box;background:#0e131c;color:#e6ecf6;border:1px solid #2c3850;border-radius:5px;padding:6px;font-size:12px;margin-bottom:8px}
    .panel-dialog__footer{display:flex;gap:8px;margin-top:4px}
    .panel-dialog__footer button{font:12px system-ui;color:#e6ecf6;background:#1b2330;border:1px solid #33405a;padding:6px 12px;border-radius:6px;cursor:pointer}
    #preset-state{position:fixed;bottom:58px;left:50%;transform:translateX(-50%);z-index:31;
      font:12px/1 system-ui;color:#9fb0c8;background:rgba(10,13,18,.8);padding:5px 10px;
      border-radius:8px;border:1px solid #2a3140;pointer-events:none}
    #preset-state.is-custom{color:#ffd479;border-color:#7a5a1e}
    #edit-banner-host{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;
      justify-content:center;pointer-events:none}
    #edit-banner-host .panel-banner{pointer-events:auto}
    body.clean-shell #panel-container,body.clean-shell #preset-bar,body.clean-shell #terrain-hud,
    body.clean-shell #preset-state,body.clean-shell #edit-banner-host,
    body.clean-shell .panel-gen-overlay{display:none!important}
  `;
  document.head.appendChild(style);
}


/* ------------------------------------------------------------------ */
/* M-P4 devOnly GPU-binding readout                                    */
/* ------------------------------------------------------------------ */
// devOnly diagnostic backing the M-P4 real-GPU 60fps read: surfaces WHICH GPU
// the browser actually bound so a SwiftShader (software) rasterizer is never
// mistaken for the discrete 5090. Queries WEBGL_debug_renderer_info's
// UNMASKED_RENDERER_WEBGL and falls back to gl.RENDERER. Purely additive and
// devOnly: it reads the SAME WebGL context the renderer already created on the
// canvas (getContext returns the existing context) — no public-surface change,
// no render-path change. Badge is debug-only; console line + window.__gpuRenderer
// are always available for bv/console evidence.
function readBoundGpu(): string {
  try {
    const glCtx: WebGLRenderingContext | WebGL2RenderingContext | null =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ||
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!glCtx) return "(no WebGL context)";
    const ext = glCtx.getExtension("WEBGL_debug_renderer_info");
    if (ext) {
      const unmasked = glCtx.getParameter((ext as any).UNMASKED_RENDERER_WEBGL);
      if (unmasked) return String(unmasked);
    }
    return String(glCtx.getParameter(glCtx.RENDERER));
  } catch (e) {
    return "(gpu read err: " + (e instanceof Error ? e.message : String(e)) + ")";
  }
}

const GPU_RENDERER = readBoundGpu();
(window as any).__gpuRenderer = GPU_RENDERER;
console.log("[M-P4] bound GPU:", GPU_RENDERER);

if (DEBUG) {
  const badge = document.createElement("div");
  badge.id = "gpu-badge";
  badge.textContent = "GPU: " + GPU_RENDERER;
  badge.setAttribute(
    "style",
    "position:fixed;bottom:8px;right:8px;z-index:40;font:12px/1.3 monospace;" +
      "color:#9fe0ff;background:rgba(8,12,18,.85);padding:5px 9px;border-radius:6px;" +
      "border:1px solid #2a3140;pointer-events:none;max-width:46vw;word-break:break-word",
  );
  document.body.appendChild(badge);
  // Hide under clean-shell captures alongside the other chrome.
  if (CLEAN_SHELL) badge.style.display = "none";
}
