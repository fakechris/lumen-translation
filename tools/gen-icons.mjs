// Zero-dependency PNG icon generator for the Lumen extension.
// Produces 16/32/48/128 px PNGs with a simple "L" mark on a blue gradient.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../apps/extension/public/icon");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = rgba(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Background: vertical gradient from #2563eb (top) to #1e40af (bottom).
// Foreground: white "L" shape (rounded by anti-aliasing via coverage).
function pixel(size) {
  return (x, y) => {
    const t = y / (size - 1);
    const r = Math.round(0x25 + (0x1e - 0x25) * t);
    const g = Math.round(0x63 + (0x40 - 0x63) * t);
    const b = Math.round(0xeb + (0xaf - 0xeb) * t);
    // L shape: vertical bar on left third, horizontal bar on bottom third.
    const margin = size * 0.22;
    const barW = size * 0.16;
    const leftBar = x >= margin && x <= margin + barW && y >= margin && y <= size - margin;
    const bottomBar =
      y >= size - margin - barW && y <= size - margin && x >= margin && x <= size * 0.72;
    if (leftBar || bottomBar) return [255, 255, 255, 255];
    // Subtle rounded corner: fade alpha near corners.
    const radius = size * 0.18;
    let alpha = 255;
    const cornerDist = (cx, cy) => Math.hypot(x - cx, y - cy);
    if (x < radius && y < radius && cornerDist(radius, radius) > radius)
      alpha = 0;
    if (x > size - radius && y < radius && cornerDist(size - radius, radius) > radius)
      alpha = 0;
    if (x < radius && y > size - radius && cornerDist(radius, size - radius) > radius)
      alpha = 0;
    if (
      x > size - radius &&
      y > size - radius &&
      cornerDist(size - radius, size - radius) > radius
    )
      alpha = 0;
    return [r, g, b, alpha];
  };
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const buf = makePng(size, pixel(size));
  writeFileSync(resolve(OUT_DIR, `${size}.png`), buf);
  console.log(`wrote ${size}.png (${buf.length} bytes)`);
}
