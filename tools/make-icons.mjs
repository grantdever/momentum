#!/usr/bin/env node
// Generates icons/icon-512.png from raw pixels (no image dependencies), then
// derives icon-192.png and apple-touch-icon.png (180x180) from it.
//
// Usage: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '..', 'icons');

const BG = [0x0b, 0x0f, 0x14];       // #0b0f14
const ACCENT = [0x2f, 0xb8, 0xa6];   // #2fb8a6, calm teal

// ---------- CRC32 (hand-rolled, no zlib.crc32 dependency) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- PNG chunk + encoder ----------

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgbaBuffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk('IHDR', ihdrData);

  // Raw scanlines, each prefixed with filter type 0 (none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    rgbaBuffer.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }

  const compressed = deflateSync(raw, { level: 9 });
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---------- Pixel drawing ----------

function setPixel(buf, size, x, y, rgba) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  buf[i] = rgba[0];
  buf[i + 1] = rgba[1];
  buf[i + 2] = rgba[2];
  buf[i + 3] = rgba[3] === undefined ? 255 : rgba[3];
}

function blend(buf, size, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  buf[i] = Math.round(buf[i] * (1 - a) + rgb[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + rgb[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + rgb[2] * a);
  buf[i + 3] = 255;
}

// Signed-distance-ish rounded rect coverage for anti-aliased corners.
function roundedRectCoverage(px, py, w, h, radius) {
  const dx = Math.max(radius - px, px - (w - radius), 0);
  const dy = Math.max(radius - py, py - (h - radius), 0);
  const cornerDist = Math.sqrt(dx * dx + dy * dy);
  return cornerDist <= radius ? 1 : 0;
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.22);

  // Background: rounded square in BG color.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const covered = roundedRectCoverage(x + 0.5, y + 0.5, size, size, radius);
      setPixel(buf, size, x, y, covered ? [...BG, 255] : [0, 0, 0, 0]);
    }
  }

  // Glyph: 4 ascending vertical bars suggesting a streak.
  const barCount = 4;
  const gap = Math.round(size * 0.045);
  const barWidth = Math.round((size * 0.56 - gap * (barCount - 1)) / barCount);
  const totalWidth = barWidth * barCount + gap * (barCount - 1);
  const startX = Math.round((size - totalWidth) / 2);
  const baseY = Math.round(size * 0.72);
  const maxBarHeight = Math.round(size * 0.42);
  const minBarHeight = Math.round(size * 0.16);
  const barRadius = Math.max(2, Math.round(barWidth * 0.28));

  for (let b = 0; b < barCount; b++) {
    const barHeight = Math.round(
      minBarHeight + (maxBarHeight - minBarHeight) * (b / (barCount - 1))
    );
    const x0 = startX + b * (barWidth + gap);
    const y0 = baseY - barHeight;

    for (let y = y0; y < baseY; y++) {
      for (let x = x0; x < x0 + barWidth; x++) {
        const localX = x - x0 + 0.5;
        const localY = y - y0 + 0.5;
        const covered = roundedRectCoverage(localX, localY, barWidth, barHeight, barRadius);
        if (covered) {
          blend(buf, size, x, y, ACCENT, 1);
        }
      }
    }
  }

  return buf;
}

// ---------- Fallback: pure-JS box-average downsample ----------

function downsamplePNG(srcBuf, srcSize, destSize) {
  // srcBuf is a raw RGBA buffer at srcSize x srcSize.
  const dest = Buffer.alloc(destSize * destSize * 4);
  const scale = srcSize / destSize;

  for (let dy = 0; dy < destSize; dy++) {
    for (let dx = 0; dx < destSize; dx++) {
      const sx0 = Math.floor(dx * scale);
      const sy0 = Math.floor(dy * scale);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * scale));
      const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * scale));

      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = sy0; sy < sy1 && sy < srcSize; sy++) {
        for (let sx = sx0; sx < sx1 && sx < srcSize; sx++) {
          const i = (sy * srcSize + sx) * 4;
          r += srcBuf[i];
          g += srcBuf[i + 1];
          b += srcBuf[i + 2];
          a += srcBuf[i + 3];
          count++;
        }
      }
      const di = (dy * destSize + dx) * 4;
      dest[di] = Math.round(r / count);
      dest[di + 1] = Math.round(g / count);
      dest[di + 2] = Math.round(b / count);
      dest[di + 3] = Math.round(a / count);
    }
  }

  return dest;
}

function trySips(srcPath, size, destPath) {
  try {
    execFileSync('sips', ['-z', String(size), String(size), srcPath, '--out', destPath], {
      stdio: 'pipe'
    });
    return existsSync(destPath);
  } catch {
    return false;
  }
}

// ---------- Main ----------

function main() {
  const size512 = 512;
  const pixels512 = drawIcon(size512);
  const png512 = encodePNG(size512, size512, pixels512);
  const path512 = path.join(ICONS_DIR, 'icon-512.png');
  writeFileSync(path512, png512);
  console.log(`Wrote ${path512} (${png512.length} bytes)`);

  const targets = [
    { size: 192, out: path.join(ICONS_DIR, 'icon-192.png') },
    { size: 180, out: path.join(ICONS_DIR, 'apple-touch-icon.png') }
  ];

  for (const { size, out } of targets) {
    const viaSips = trySips(path512, size, out);
    if (viaSips) {
      console.log(`Wrote ${out} via sips (${size}x${size})`);
      continue;
    }
    console.log(`sips unavailable/failed for ${size}x${size}; using JS box-average fallback`);
    const downsampled = downsamplePNG(pixels512, size512, size);
    const png = encodePNG(size, size, downsampled);
    writeFileSync(out, png);
    console.log(`Wrote ${out} via fallback (${png.length} bytes)`);
  }
}

main();
