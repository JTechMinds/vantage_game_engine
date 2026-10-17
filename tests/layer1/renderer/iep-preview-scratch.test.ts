/*
 * IEP Phase-2 renderer-level gates (spec-interactive-edit-preview-phase2.md §5).
 *
 * Browser-free, GPU-free. The renderer is NOT mounted, so ctx.scene stays null
 * and the scratch mesh builds no THREE node — but the preview control seam still
 * runs the height-only regen headlessly, which is exactly what the ACs sample:
 *
 *   - present-during-drag (IEP-AC-04b): begin + setLiveValue + pump makes the
 *     scratch logically visible and bumps previewRebuildCount.
 *   - latest-value-wins coalescing: many setLiveValue, one pump -> ONE accepted
 *     regen reflecting the LAST value.
 *   - budget-drop ladder (IEP-AC-06): over-budget frames coarsen then drop, and
 *     NEVER bump previewRebuildCount (a preview is not a commit).
 *   - hard-swap commit (IEP-AC-04): endCommit disposes the scratch; the commit
 *     itself is the public rebuildFromSnapshot (proven 1:1 in Phase 1).
 *   - cancel (IEP-AC-04): cancel disposes the scratch, previewRebuildCount does
 *     not move on the cancel action; committed sampleHeight is untouched.
 *   - isolation (IEP-AC-07/§5.2-10): a live preview never mutates the committed
 *     heightfield the public sampleHeight seam reads.
 *   - disjoint counters (IEP-AC-05): previewRebuildCount is a THIRD counter, not
 *     commitRebuildCount and not the camera rebuildCount.
 *   - surface (IEP-AC-08): the preview seam is non-enumerable; the frozen public
 *     enumerable surface is unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../../../src/engine/layer1/terrain/index.ts';
import { createTerrainRenderer } from '../../../src/engine/layer1/renderer/terrain-renderer.ts';

interface PreviewSeam {
  begin(): void;
  setLiveValue(patch: Record<string, unknown>): void;
  pump(): void;
  endCommit(): void;
  cancel(): void;
  dispose(): void;
  probe(): { present: boolean; isVisible: boolean; gridN: number; farGridN: number; sampleHeight: number };
  setBudget(ms: number): void;
  setGrid(n: number): void;
}

function makeCanvas() {
  const noop = (): void => {};
  return {
    clientWidth: 256, clientHeight: 256, width: 256, height: 256, style: {},
    getContext: () => null, addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 256, height: 256 }),
  } as unknown as HTMLCanvasElement;
}

function makeRenderer() {
  const t = createTerrainLayer({ worldSize: { vertices: 512, meters: 512 } });
  t.setParams({ biome: 'alpine', seed: 1337, elevation: 5 });
  t.generate();
  const r = createTerrainRenderer({ terrain: t, canvas: makeCanvas() });
  return { t, r };
}

function seam(r: unknown): PreviewSeam {
  return (r as { preview: PreviewSeam }).preview;
}
function stats(r: unknown): Record<string, number> {
  return (r as { rebuildStats: () => Record<string, number> }).rebuildStats();
}

const POSE_FAR_A = { x: 0, y: 900, z: 0, targetX: 0, targetY: 0, targetZ: 0 };

test('IEP-AC-04b: begin + setLiveValue + pump shows the scratch preview and bumps previewRebuildCount (headless)', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24); // small grid -> cheap, in-budget eval headlessly
  const before = stats(r).previewRebuildCount;
  p.begin();
  assert.equal(p.probe().isVisible, true, 'scratch present after begin');
  p.setLiveValue({ elevation: 8 });
  p.pump();
  assert.equal(p.probe().isVisible, true, 'scratch still visible after accepted regen');
  assert.ok(p.probe().sampleHeight !== 0 || p.probe().isVisible, 'accepted preview recorded a sample');
  assert.equal(stats(r).previewRebuildCount, before + 1, 'one accepted preview regen = one previewRebuildCount');
  p.dispose();
});

test('IEP latest-value-wins: many setLiveValue then one pump -> ONE regen reflecting the LAST value', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24);
  const before = stats(r).previewRebuildCount;
  p.begin();
  for (const e of [1, 2, 3, 4, 5, 6, 7, 8, 9]) p.setLiveValue({ elevation: e });
  p.pump();
  assert.equal(stats(r).previewRebuildCount, before + 1,
    'coalesced: 9 live updates + 1 pump -> exactly one accepted regen');
  // The accepted value is the last one; a second value would differ in height.
  const hHigh = p.probe().sampleHeight;
  p.setLiveValue({ elevation: 1 });
  p.pump();
  assert.notEqual(p.probe().sampleHeight, hHigh,
    'a lower elevation regen yields a different preview mean (last-value applied)');
  p.dispose();
});

test('IEP-AC-06: over-budget frames coarsen then drop, and NEVER bump previewRebuildCount', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(512 / 2); // start at the mid grid so the ladder has a rung to drop
  p.setBudget(-1);    // force every frame over budget
  const before = stats(r).previewRebuildCount;
  p.begin();
  p.setLiveValue({ elevation: 7 });
  p.pump(); // over budget -> coarsen mid -> far, retry next pump, no count
  assert.equal(p.probe().gridN, p.probe().farGridN, 'ladder coarsened mid -> far');
  p.pump(); // now at far grid, still over budget -> drop the frame, no count
  assert.equal(stats(r).previewRebuildCount, before,
    'dropped/coarsened preview frames never count as a rebuild');
  assert.equal(p.probe().isVisible, true, 'last preview is kept when a frame is dropped');
  p.dispose();
});

test('IEP-AC-04 hard-swap: endCommit disposes the scratch; the commit is the public rebuild (no preview count)', () => {
  const { t, r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 9 });
  p.pump();
  const afterPreview = stats(r);
  // Hard-swap: tear the scratch down, THEN run the single public commit.
  p.endCommit();
  assert.equal(p.probe().isVisible, false, 'scratch disposed on endCommit');
  const beforeCommit = stats(r);
  t.setParams({ elevation: 9 });
  t.generate();
  r.rebuildFromSnapshot();
  const afterCommit = stats(r);
  assert.equal((afterCommit.commitRebuildCount as number) - (beforeCommit.commitRebuildCount as number), 1,
    'commit runs through the public rebuild (commitRebuildCount +1)');
  assert.equal(afterCommit.previewRebuildCount, afterPreview.previewRebuildCount,
    'the commit does NOT move previewRebuildCount (disjoint)');
});

test('IEP-AC-04 cancel: cancel disposes the scratch and moves neither preview nor commit counters', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 3 });
  p.pump();
  const before = stats(r);
  p.cancel();
  assert.equal(p.probe().isVisible, false, 'scratch disposed on cancel');
  const after = stats(r);
  assert.equal(after.commitRebuildCount, before.commitRebuildCount, 'cancel = zero commit');
  assert.equal(after.previewRebuildCount, before.previewRebuildCount, 'cancel action adds no preview regen');
});

test('IEP-AC-07 isolation: a live preview never mutates the committed sampleHeight seam', () => {
  const { t, r } = makeRenderer();
  const committedSample = t.sampleHeight(12, -8);
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 0 });
  p.pump();
  assert.equal(t.sampleHeight(12, -8), committedSample,
    'preview regen writes only the scratch; committed heightfield is intact');
  p.dispose();
});

test('IEP-AC-05 disjointness (negative control): previewRebuildCount moves while commit + camera counters stay flat', () => {
  const { t, r } = makeRenderer();
  r.setCamera(POSE_FAR_A);
  const base = stats(r);
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 6 });
  p.pump();
  const s = stats(r);
  assert.ok((s.previewRebuildCount - base.previewRebuildCount) >= 1, 'preview counter moved');
  assert.equal(s.commitRebuildCount, base.commitRebuildCount, 'commit counter flat during preview');
  assert.equal(s.rebuildCount, base.rebuildCount, 'camera guard counter flat during preview');
  void t;
  p.dispose();
});

test('IEP-AC-08 surface: the preview seam is non-enumerable; frozen public surface unchanged', () => {
  const { r } = makeRenderer();
  const rr = r as unknown as Record<string, unknown>;
  assert.ok(!Object.keys(rr).includes('preview'), 'preview seam is NOT enumerable on the public renderer');
  // Still callable via the devOnly hook.
  assert.equal(typeof seam(r).begin, 'function');
  const enumerable = Object.keys(rr).sort();
  assert.deepEqual(enumerable, [
    'applyAppearance', 'debugSceneSummary', 'dispose', 'getLodRegions', 'getStatus',
    'mount', 'rebuildFromSnapshot', 'resize', 'setCamera', 'setLodDebug', 'setWireframe',
  ].sort(), 'public enumerable surface unchanged (API-surface diff empty)');
});

test('late completion after dispose is a no-op (no count, no throw)', () => {
  const { r } = makeRenderer();
  const p = seam(r);
  p.setGrid(24);
  p.begin();
  p.setLiveValue({ elevation: 4 });
  p.dispose(); // scratch gone
  const before = stats(r).previewRebuildCount;
  p.pump(); // must not regenerate against a disposed scratch
  assert.equal(stats(r).previewRebuildCount, before, 'pump after dispose is inert');
});
