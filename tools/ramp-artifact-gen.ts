/*
 * Deterministic height-ramp artifact generator (evidence tool, not shipped).
 * Reproduces the EXACT shipped color path: the real staged-preview height field
 * (generatePreviewHeights) mapped through the shipped applyHeightRamp + default
 * palette, then linear->sRGB encoded to a PNG. Proves the staged preview is
 * height-distinguishable without a GPU/browser, byte-for-byte reproducible.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generatePreviewHeights } from '../src/engine/layer1/renderer/preview-eval.ts';
import { applyHeightRamp, DEFAULT_RAMP_SRGB, type RampPalette } from '../src/engine/layer1/renderer/preview-ramp.ts';

// sRGB hex -> linear (matches three Color.convertSRGBToLinear).
function toLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// linear -> sRGB byte (inverse of convertSRGBToLinear).
function toSrgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}
const stops = DEFAULT_RAMP_SRGB.flatMap((hex) => [toLinear((hex >> 16) & 0xff), toLinear((hex >> 8) & 0xff), toLinear(hex & 0xff)]);
const palette: RampPalette = { stops: stops as unknown as RampPalette['stops'] };

const gridN = 128;
const field = generatePreviewHeights({ biome: 'alpine', seed: 1337, elevation: 5, mountainAggression: 7, valleyAggression: 4, riverAggression: 3 } as never, 512, gridN);
const colors = new Float32Array(gridN * gridN * 3);
applyHeightRamp(field.heights, gridN * gridN, colors, palette);

// Upscale gridN -> 512 nearest-neighbour into an RGB pixel buffer (row-major, top=+z).
const out = 512;
const scale = out / gridN;
const rows: Buffer[] = [];
const seen = new Set<number>();
for (let y = 0; y < out; y++) {
  const row = Buffer.alloc(1 + out * 3); // filter byte 0 + RGB
  const gz = gridN - 1 - Math.min(gridN - 1, Math.floor(y / scale)); // flip so high z at top
  for (let x = 0; x < out; x++) {
    const gx = Math.min(gridN - 1, Math.floor(x / scale));
    const i = (gz * gridN + gx) * 3;
    const r = toSrgbByte(colors[i]);
    const g = toSrgbByte(colors[i + 1]);
    const b = toSrgbByte(colors[i + 2]);
    seen.add((r << 16) | (g << 8) | b);
    row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
  }
  rows.push(row);
}
const raw = Buffer.concat(rows);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let n = 0; n < buf.length; n++) {
    c ^= buf[n];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(out, 0); ihdr.writeUInt32BE(out, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync('evidence/layer1/preview-height-ramp.png', png);
console.log('WROTE png bytes=', png.length, 'distinctColors=', seen.size);
