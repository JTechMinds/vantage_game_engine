#!/usr/bin/env node
/**
 * Layer 1 M-T4 — repo-local CC0 PBR texture fetch.
 *
 * Reads ONLY assets/layer1/texture-manifest.json, resolves each listed asset's
 * canonical Poly Haven download URL via api.polyhaven.com, and writes the
 * pixel maps into the repo-local asset directory. It refuses any asset not
 * listed in the manifest (manifest policy.enforcement) and rejects any resolved
 * output path that escapes the asset root (path-traversal + L1-AC-163 host-path
 * guard). No global installs: uses Node 24 built-in fetch + fs.
 *
 * Map-name -> Poly Haven map key + preferred format:
 *   albedo    -> Diffuse     (jpg, sRGB)
 *   normal    -> nor_gl      (png, linear)
 *   roughness -> Rough       (png, linear)
 *   ao        -> AO          (png, linear)
 *   height    -> Displacement(png, linear)
 *   radiance  -> hdri        (hdr, linear)  [sky only]
 *
 * Idempotent: a present non-zero file is skipped. A fetch report (name, map,
 * url, bytes, ext, colorSpace) is written to assets/layer1/fetch-report.json
 * for the Gate VIS texture-approval evidence.
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const ASSET_ROOT = path.join(REPO_ROOT, "assets", "layer1");
const MANIFEST_PATH = path.join(ASSET_ROOT, "texture-manifest.json");
const API = "https://api.polyhaven.com/files/";

const MAP_SPEC = {
  albedo: { key: "Diffuse", fmts: ["jpg", "png"] },
  normal: { key: "nor_gl", fmts: ["png", "exr"] },
  roughness: { key: "Rough", fmts: ["png", "jpg"] },
  ao: { key: "AO", fmts: ["png", "jpg"] },
  height: { key: "Displacement", fmts: ["png", "exr"] },
  radiance: { key: "hdri", fmts: ["hdr", "exr"] },
};
const RES_TAG = { 2048: "2k", 4096: "4k" };

function guardOut(rel) {
  const abs = path.resolve(ASSET_ROOT, rel);
  if (abs !== ASSET_ROOT && !abs.startsWith(ASSET_ROOT + path.sep)) {
    throw new Error(`path-traversal guard: ${rel} escapes asset root`);
  }
  return abs;
}

async function pickUrl(filesJson, mapName, res) {
  const spec = MAP_SPEC[mapName];
  if (!spec) throw new Error(`unknown map ${mapName}`);
  const tag = RES_TAG[res] || "2k";
  const bucket = filesJson[spec.key] && filesJson[spec.key][tag];
  if (!bucket) throw new Error(`no ${spec.key}/${tag} in asset files`);
  for (const f of spec.fmts) {
    if (bucket[f] && bucket[f].url) return { url: bucket[f].url, ext: f };
  }
  throw new Error(`no ${spec.key}/${tag} in formats ${spec.fmts.join(",")}`);
}

async function download(url, outAbs) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`empty body for ${url}`);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await writeFile(outAbs, buf);
  return buf.length;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const report = { fetchedAt: new Date().toISOString(), entries: [], skipped: [], refused: [] };

  const jobs = [];
  for (const asset of manifest.assets) {
    for (const map of asset.maps) {
      jobs.push({ asset, map, surface: asset.targetSurface });
    }
  }
  const sky = manifest.skyHdri;
  for (const map of sky.maps) jobs.push({ asset: sky, map, surface: "sky" });

  const cache = new Map();
  for (const job of jobs) {
    const { asset, map, surface } = job;
    if (!manifest.assets.some((a) => a.name === asset.name) && asset.name !== sky.name) {
      report.refused.push({ name: asset.name, map, why: "not listed in manifest" });
      continue;
    }
    const rel = surface === "sky"
      ? path.join("sky", `${asset.name}.${"hdr"}`)
      : path.join("textures", surface, `${map}.png`);
    // Resolve format from API first, then correct the ext in the relative path.
    let filesJson;
    if (cache.has(asset.name)) filesJson = cache.get(asset.name);
    else {
      const r = await fetch(API + asset.name);
      if (!r.ok) { report.refused.push({ name: asset.name, map, why: `api ${r.status}` }); continue; }
      filesJson = await r.json();
      cache.set(asset.name, filesJson);
    }
    let picked;
    try { picked = await pickUrl(filesJson, map, asset.resolution); }
    catch (e) { report.refused.push({ name: asset.name, map, why: e.message }); continue; }
    const finalRel = rel.replace(/\.[a-z0-9]+$/, `.${picked.ext}`);
    const outAbs = guardOut(finalRel);
    if (existsSync(outAbs)) {
      const s = await stat(outAbs);
      if (s.size > 0) { report.skipped.push({ name: asset.name, map, path: finalRel, bytes: s.size }); continue; }
    }
    const bytes = await download(picked.url, outAbs);
    report.entries.push({
      name: asset.name, surface, map,
      colorSpace: asset.colorSpace[map] || (map === "albedo" ? "srgb" : "linear"),
      resolution: asset.resolution, ext: picked.ext, url: picked.url, bytes, path: finalRel,
    });
    console.log(`OK ${surface}/${map} ${picked.ext} ${bytes}B`);
  }

  await writeFile(path.join(ASSET_ROOT, "fetch-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nfetched=${report.entries.length} skipped=${report.skipped.length} refused=${report.refused.length}`);
  if (report.refused.length) console.log("REFUSED:\n" + JSON.stringify(report.refused, null, 2));
}

main().catch((e) => { console.error("FETCH FAILED:", e.message); process.exit(1); });
