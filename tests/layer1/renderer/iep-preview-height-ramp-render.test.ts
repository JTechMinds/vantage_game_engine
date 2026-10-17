/*
 * Render-path gate for the IEP height-ramp (Sarah KICK re-cert ask).
 *
 * Sarah's blocking VIS failure: on served :8137 the staged preview rendered a
 * flat light-gray plane — per-vertex colors computed headless (distinctColors≈57)
 * never reached the RENDER OBJECT. Root cause: a stale-bundle / cache delivery
 * issue — the base commit pinned the demo bundle cache-buster to
 * ?v=iep-usability, so a browser could load a pre-ramp MeshBasicMaterial
 * 0x888888 build. The cut bumps it to ?v=ramp1. The render code is correct.
 *
 * This gate closes the structural question in CI WITHOUT a GL context: mount the
 * scratch into a REAL THREE.Scene (three introspection is headless; no WebGL is
 * needed to read geometry.attributes / material flags) and assert the mounted
 * mesh's geometry carries a `color` BufferAttribute (three's name is `color`,
 * NOT `colors`; itemSize 3; one entry per vertex) sharing the live _colors
 * buffer, and that the material is a vertexColors MeshBasicMaterial. If a future
 * change drops the attribute name, forgets to attach it, or flips vertexColors
 * off, this fails — the exact class of bug Sarah caught by eye.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PreviewScratchMeshImpl } from '../../../src/engine/layer1/renderer/preview-scratch.ts';

test('Render path: mounted scratch geometry carries a color attribute on a vertexColors MeshBasicMaterial', () => {
  const scene = new THREE.Scene();
  const gridN = 8;
  const s = new PreviewScratchMeshImpl({ gridN, worldMeters: 100, scene });
  s.present(); // builds + attaches the THREE node (scene is non-null here)
  const heights = new Float64Array(gridN * gridN);
  for (let i = 0; i < heights.length; i++) heights[i] = i; // a real ramp field
  s.update(heights);

  const mesh = scene.getObjectByName('preview-scratch') as THREE.Mesh | undefined;
  assert.ok(mesh, 'scratch mesh is mounted in the scene under name preview-scratch');
  assert.equal(mesh!.userData.isPreview, true, 'mounted node is flagged as the preview');

  const geometry = mesh!.geometry as THREE.BufferGeometry;
  const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  assert.ok(colorAttr, 'geometry carries an attribute named color (three vertexColors reads attributes.color, NOT colors)');
  assert.equal(colorAttr!.itemSize, 3, 'color attribute is RGB (itemSize 3)');
  assert.equal(colorAttr!.count, gridN * gridN, 'color attribute has one entry per vertex');

  const arr = colorAttr!.array as Float32Array;
  assert.equal(arr.length, gridN * gridN * 3, 'color buffer length matches vertex*3');
  // The buffer must hold a real ramp, not zeros (dropped upload) or a flat fill.
  const seen = new Set<number>();
  for (let i = 0; i < colorAttr!.count; i++) {
    const r = Math.round(Math.min(1, Math.max(0, arr[i * 3])) * 255);
    const g = Math.round(Math.min(1, Math.max(0, arr[i * 3 + 1])) * 255);
    const b = Math.round(Math.min(1, Math.max(0, arr[i * 3 + 2])) * 255);
    seen.add((r << 16) | (g << 8) | b);
  }
  assert.ok(seen.size >= 8, 'mounted color buffer holds a real ramp (distinctColors >= 8)');

  const material = mesh!.material as THREE.MeshBasicMaterial;
  assert.equal(material.type, 'MeshBasicMaterial', 'preview material is the unlit MeshBasicMaterial');
  assert.equal(material.vertexColors, true, 'preview material has vertexColors:true so colors reach the pixels');

  s.dispose();
});
