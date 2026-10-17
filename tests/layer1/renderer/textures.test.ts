import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildTextureBundle,
  gateVisReady,
  REQUIRED_SURFACES,
  ANALYTIC_SURFACES,
} from "../../../src/engine/layer1/renderer/textures.ts";

// The curated asset manifest is the single approved source for PBR pixels
// (spec M-T2 §1). It lives in the repo-local assets dir and is committed, so
// a clean clone can resolve it without any network fetch.
const MANIFEST_URL = new URL(
  "../../../assets/layer1/texture-manifest.json",
  import.meta.url,
);

interface ManifestColorSpace {
  [map: string]: string | undefined;
}

interface ManifestAsset {
  name: string;
  targetSurface: string;
  sourceUrl: string;
  license: string;
  resolution: unknown;
  maps?: unknown;
  colorSpace?: ManifestColorSpace;
}

interface Manifest {
  assets: ManifestAsset[];
  skyHdri: { name: string; sourceUrl: string; license: string; colorSpace?: ManifestColorSpace };
}

function loadManifest(): Manifest {
  const raw = readFileSync(fileURLToPath(MANIFEST_URL), "utf8");
  return JSON.parse(raw) as Manifest;
}

/* ---------------- Manifest integrity (spec §1) ---------------- */

test("texture manifest is valid JSON with the expected top-level shape", () => {
  const m = loadManifest();
  assert.ok(Array.isArray(m.assets) && m.assets.length > 0, "manifest must list assets");
  assert.ok(m.skyHdri && typeof m.skyHdri.name === "string", "manifest must define a sky HDRI");
});

test("every manifest asset is CC0 licensed from Poly Haven", () => {
  const m = loadManifest();
  for (const a of m.assets) {
    assert.match(
      a.sourceUrl,
      /polyhaven\.com/i,
      `asset ${a.name} must come from Poly Haven, got ${a.sourceUrl}`,
    );
    assert.equal(
      a.license.toUpperCase().startsWith("CC0"),
      true,
      `asset ${a.name} must be CC0-licensed`,
    );
  }
  assert.match(m.skyHdri.sourceUrl, /polyhaven\.com/i, "sky HDRI must come from Poly Haven");
  assert.ok(m.skyHdri.license.toUpperCase().startsWith("CC0"), "sky HDRI must be CC0-licensed");
});

test("color spaces follow the rule: albedo=sRGB, all data maps=linear", () => {
  const m = loadManifest();
  const assets = [...m.assets, { ...m.skyHdri, targetSurface: "sky" }];
  for (const a of assets) {
    const cs = a.colorSpace;
    if (!cs) continue;
    for (const [map, space] of Object.entries(cs)) {
      if (space === undefined) continue;
      if (map === "albedo") {
        assert.equal(
          space,
          "srgb",
          `${a.name}.${map} is a color map and must be sRGB, got ${space}`,
        );
      } else {
        // normal / roughness / ao / height are data maps, never sRGB.
        assert.equal(
          space,
          "linear",
          `${a.name}.${map} is a data map and must be linear, got ${space}`,
        );
      }
    }
  }
});

test("manifest covers every required surface (spec §1 Gate VIS surface set)", () => {
  const m = loadManifest();
  const covered = new Set<string>(m.assets.map((a) => a.targetSurface));
  if (m.skyHdri) covered.add("sky");
  for (const surface of REQUIRED_SURFACES) {
    if (ANALYTIC_SURFACES.includes(surface)) continue; // analytic water has no texture-map source (spec M-T4 water amendment)
    assert.ok(
      covered.has(surface),
      `required surface "${surface}" is missing from the manifest`,
    );
  }
});

test("asset target surfaces are unique (no two assets fight for a surface)", () => {
  const m = loadManifest();
  const seen = new Set<string>();
  for (const a of m.assets) {
    assert.ok(!seen.has(a.targetSurface), `duplicate targetSurface ${a.targetSurface}`);
    seen.add(a.targetSurface);
  }
});

/* ---------------- Bundle status + Gate VIS blocker (spec §1, §6) ---------------- */

test("placeholder bundle reports status=placeholder and keeps Gate VIS blocked", () => {
  const m = loadManifest();
  const bundle = buildTextureBundle(m, { usePlaceholders: true });
  assert.equal(bundle.status, "placeholder");
  assert.equal(
    gateVisReady(bundle),
    false,
    "a placeholder-backed bundle must never pass Gate VIS",
  );
  // The blocker must be recorded in diagnostics so evidence notes carry it.
  assert.ok(
    bundle.diagnostics.some((d) => /Gate VIS is blocked/i.test(d)),
    "placeholder bundle must record a Gate VIS blocker diagnostic",
  );
});

test("asking for an approved bundle without real pixels falls back to placeholder", () => {
  const m = loadManifest();
  // No sourcePathFor: the resolver cannot find approved pixels, so the bundle
  // must degrade to placeholder rather than falsely claiming approval.
  const bundle = buildTextureBundle(m, { usePlaceholders: false });
  assert.equal(bundle.status, "placeholder");
  assert.equal(gateVisReady(bundle), false);
  assert.ok(
    bundle.diagnostics.length > 0,
    "an unresolvable approved build must record why it fell back",
  );
});

test("approved build with a resolver that cannot load pixels still blocks Gate VIS", () => {
  const m = loadManifest();
  const bundle = buildTextureBundle(m, {
    usePlaceholders: false,
    // Point every map at a path that does not exist on disk; resolution fails
    // per-surface and the aggregate stays placeholder — never a false pass.
    sourcePathFor: () => { throw new Error("pixel file not found on disk"); },
  });
  assert.equal(bundle.status, "placeholder");
  assert.equal(gateVisReady(bundle), false);
});

test("every surface in a placeholder bundle is individually marked placeholder", () => {
  const m = loadManifest();
  const bundle = buildTextureBundle(m, { usePlaceholders: true });
  for (const surface of REQUIRED_SURFACES) {
    const set = surface === "sky" ? bundle.sky : bundle.surfaces[surface];
    assert.ok(set, `surface "${surface}" must exist on the bundle`);
    assert.equal(set.status, "placeholder", `${surface} must be placeholder-backed`);
  }
});
