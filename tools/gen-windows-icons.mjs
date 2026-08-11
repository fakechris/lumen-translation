// Render the Windows app icons from the same AppIcon.svg the macOS .icns is
// built from (see gen-app-icns.sh), so the two platforms can never drift.
//
//   node tools/gen-windows-icons.mjs
//
// Needs rsvg-convert (`brew install librsvg`, `apt install librsvg2-bin`).
// The outputs are committed, so CI never has to run this — Windows runners
// have no SVG rasteriser and shouldn't need one.
//
// The .ico is packed here rather than with a dependency: an ICO is a 6-byte
// header plus one 16-byte directory entry per image, and Vista and later
// accept PNG payloads verbatim.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../apps/popclip-window/LumenTranslation/AppIcon.svg");
const OUT_DIR = resolve(__dirname, "../apps/desktop/src-tauri/icons");

/** Sizes Windows Explorer, the taskbar, and the tray actually ask for. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Standalone PNGs referenced by tauri.conf.json and the MSIX packager. */
const PNG_OUTPUTS = [
  { size: 32, name: "32x32.png" },
  { size: 128, name: "128x128.png" },
  { size: 256, name: "128x128@2x.png" },
  { size: 512, name: "icon.png" },
];

function render(size) {
  return execFileSync(
    "rsvg-convert",
    ["-w", String(size), "-h", String(size), SRC],
    { maxBuffer: 32 * 1024 * 1024 },
  );
}

/**
 * Pack PNGs into an .ico. A 256 px image records its width/height as 0, which
 * is the format's way of saying "256".
 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // palette size: not paletted
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const { size, name } of PNG_OUTPUTS) {
  const png = render(size);
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`wrote ${name} (${png.length} bytes)`);
}

const ico = packIco(ICO_SIZES.map((size) => ({ size, png: render(size) })));
writeFileSync(resolve(OUT_DIR, "icon.ico"), ico);
console.log(`wrote icon.ico (${ico.length} bytes, ${ICO_SIZES.length} sizes)`);

// Sanity check: re-read the .ico and confirm every directory entry points at a
// PNG signature. A malformed icon fails deep inside the NSIS build with a
// useless error, so it is worth catching here.
const written = readFileSync(resolve(OUT_DIR, "icon.ico"));
const count = written.readUInt16LE(4);
for (let i = 0; i < count; i++) {
  const at = 6 + i * 16;
  const start = written.readUInt32LE(at + 12);
  const signature = written.subarray(start, start + 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`icon.ico entry ${i} does not start with a PNG signature`);
  }
}
console.log(`verified ${count} icon entries`);
