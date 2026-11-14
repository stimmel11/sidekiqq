#!/usr/bin/env node
/**
 * Renders every favicon and app icon for the marketing site (/site) and the web app (/brain) from
 * the horse mark in design/mark/ (docs/WEBAPP.md §1). Zero dependencies (Node >= 18).
 *
 * Sources (coverage masks made once from the owner's drawing by design/mark/prepare.py):
 *   design/mark/horse.png       1024 px grayscale, 255 = line; used for icons of 128 px and up
 *   design/mark/horse-bold.png  the same lines thickened; used for favicon sizes so they stay visible
 *
 * The mark is drawn in TILE.fg on a Paper tile (TILE.bg). Each output pixel is the exact area
 * average of the mask under it (summed-area table), so small sizes don't alias.
 *
 *   node design/icons.mjs          # write all outputs (see OUTPUTS)
 *   node design/icons.mjs --check  # exit 1 if a committed icon is stale
 *
 * Variants:
 *   icon-192.png, icon-512.png   "any": rounded tile, transparent outside
 *   icon-maskable-512.png        "maskable": full-bleed tile, mark inside the 80% safe zone
 *   apple-touch-icon.png (180)   full-bleed square (iOS rounds the corners itself)
 *   favicon.ico                  16, 32 and 48 px rounded tiles (PNG-compressed ICO entries)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MARK = join(ROOT, "design/mark/horse.png");
export const MARK_BOLD = join(ROOT, "design/mark/horse-bold.png");

/** Paper tile (design/tokens.json brand.paper) with the drawing's own dark brown lines. */
export const TILE = { bg: [0xf6, 0xf4, 0xef], fg: [0x3b, 0x34, 0x2e], rx: 0.22, inset: 0.12 };
/** Sizes up to this use the bold mask. */
const BOLD_MAX = 64;

export const VARIANTS = [
  { file: "icon-192.png", size: 192, mode: "any" },
  { file: "icon-512.png", size: 512, mode: "any" },
  { file: "icon-maskable-512.png", size: 512, mode: "maskable" },
  { file: "apple-touch-icon.png", size: 180, mode: "fullbleed" },
  { file: "favicon.ico", sizes: [16, 32, 48], mode: "any" },
];

/** Where each file is written, relative to the repo root. */
export const OUTPUTS = {
  "icon-192.png": ["design/dist/icons", "brain/public/icons"],
  "icon-512.png": ["design/dist/icons", "brain/public/icons"],
  "icon-maskable-512.png": ["design/dist/icons", "brain/public/icons"],
  "apple-touch-icon.png": ["design/dist/icons", "brain/public/icons", "site/public"],
  // brain/src/app/favicon.ico is picked up by Next.js for every page (<link rel="icon">).
  "favicon.ico": ["design/dist/icons", "brain/src/app", "site/public"],
};

// ---------- PNG decoding (8-bit grayscale / gray+alpha / RGB / RGBA, non-interlaced) ----------

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function readChunks(buf) {
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = Buffer.from(data);
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  return { ihdr, raw: inflateSync(Buffer.concat(idat)) };
}

/** Decodes a PNG to { width, height, channels, data } with all scanline filters undone. */
export function decodePng(png) {
  const { ihdr, raw } = readChunks(Buffer.from(png));
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const channels = CHANNELS[ihdr[9]];
  if (depth !== 8 || !channels || ihdr[12] !== 0) throw new Error("only 8-bit, non-interlaced gray/RGB(A) PNGs are supported");
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[cur + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = line[x]; break;
        case 1: v = line[x] + a; break;
        case 2: v = line[x] + b; break;
        case 3: v = line[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[cur + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** Loads a square grayscale mask as coverage 0..1 with a summed-area table for box averages. */
export function loadMask(png) {
  const { width, height, channels, data } = decodePng(png);
  if (width !== height) throw new Error("mask must be square");
  const n = width;
  const sat = new Float64Array((n + 1) * (n + 1));
  for (let y = 0; y < n; y++) {
    let row = 0;
    for (let x = 0; x < n; x++) {
      row += data[(y * n + x) * channels] / 255;
      sat[(y + 1) * (n + 1) + x + 1] = sat[y * (n + 1) + x + 1] + row;
    }
  }
  return { n, sat };
}

/** Exact average coverage of the mask over [x0,x1) x [y0,y1) in mask pixels (fractional edges). */
function boxCoverage(mask, x0, y0, x1, y1) {
  const { n, sat } = mask;
  const S = (x, y) => {
    // Bilinear lookup in the SAT gives exact area integrals for fractional coordinates.
    x = Math.min(Math.max(x, 0), n);
    y = Math.min(Math.max(y, 0), n);
    const xi = Math.min(Math.floor(x), n - 1), yi = Math.min(Math.floor(y), n - 1);
    const fx = x - xi, fy = y - yi;
    const w = n + 1;
    const s00 = sat[yi * w + xi], s10 = sat[yi * w + xi + 1], s01 = sat[(yi + 1) * w + xi], s11 = sat[(yi + 1) * w + xi + 1];
    return s00 * (1 - fx) * (1 - fy) + s10 * fx * (1 - fy) + s01 * (1 - fx) * fy + s11 * fx * fy;
  };
  const area = (x1 - x0) * (y1 - y0);
  return area > 0 ? Math.min(1, Math.max(0, (S(x1, y1) - S(x0, y1) - S(x1, y0) + S(x0, y0)) / area)) : 0;
}

// ---------- rendering ----------

const SS = 4; // 4x4 samples per pixel for the tile's rounded corners

function tileCoverage(px, py, size, rxPx) {
  let inside = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
      const cx = Math.min(Math.max(x, rxPx), size - rxPx), cy = Math.min(Math.max(y, rxPx), size - rxPx);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rxPx * rxPx) inside++;
    }
  }
  return inside / (SS * SS);
}

/** Renders one square RGBA icon. `mode`: "any" (rounded tile), "maskable" or "fullbleed". */
export function render(mask, size, mode) {
  const inset = mode === "maskable" ? 0.1 + 0.8 * TILE.inset : TILE.inset;
  const markOrigin = size * inset;
  const markSide = size * (1 - 2 * inset);
  const k = mask.n / markSide; // mask pixels per output pixel
  const rxPx = mode === "any" ? size * TILE.rx : 0;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = rxPx ? tileCoverage(x, y, size, rxPx) : 1;
      const i = (y * size + x) * 4;
      if (t === 0) continue;
      const m = boxCoverage(mask, (x - markOrigin) * k, (y - markOrigin) * k, (x + 1 - markOrigin) * k, (y + 1 - markOrigin) * k);
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(TILE.bg[c] * (1 - m) + TILE.fg[c] * m);
      px[i + 3] = Math.round(t * 255);
    }
  }
  return px;
}

// ---------- PNG / ICO encoding ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO with PNG-compressed entries (supported by every current browser and Windows Vista+). */
export function encodeIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.png)]);
}

/** The PNG entries of an ICO written by encodeIco, as [{ size, png }]. */
export function decodeIco(ico) {
  const buf = Buffer.from(ico);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO");
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    out.push({ size: buf[e] || 256, png: buf.subarray(buf.readUInt32LE(e + 12), buf.readUInt32LE(e + 12) + buf.readUInt32LE(e + 8)) });
  }
  return out;
}

/**
 * --check compares pixels, not file bytes: zlib's compressed output can differ across Node builds/CPUs.
 * Works for our PNGs and for ICOs (entry by entry).
 */
export function samePixels(a, b) {
  try {
    const isIco = (x) => Buffer.from(x).readUInt32BE(0) === 0x00000100;
    if (isIco(a) || isIco(b)) {
      const x = decodeIco(a), y = decodeIco(b);
      return x.length === y.length && x.every((e, i) => e.size === y[i].size && samePixels(e.png, y[i].png));
    }
    const x = decodePng(a), y = decodePng(b);
    return x.width === y.width && x.height === y.height && x.channels === y.channels && x.data.equals(y.data);
  } catch {
    return false;
  }
}

export function buildIcons(markPng = readFileSync(MARK), boldPng = readFileSync(MARK_BOLD)) {
  const mark = loadMask(markPng);
  const bold = loadMask(boldPng);
  const pick = (size) => (size <= BOLD_MAX ? bold : mark);
  return VARIANTS.map((v) => {
    if (v.sizes) {
      const entries = v.sizes.map((size) => ({ size, png: encodePng(render(pick(size), size, v.mode), size) }));
      return { ...v, data: encodeIco(entries) };
    }
    return { ...v, data: encodePng(render(pick(v.size), v.size, v.mode), v.size) };
  });
}

function main() {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const icon of buildIcons()) {
    for (const rel of OUTPUTS[icon.file]) {
      const dir = join(ROOT, rel);
      const p = join(dir, icon.file);
      if (check) {
        if (!existsSync(p) || !samePixels(readFileSync(p), icon.data)) {
          console.error(`stale: ${p}`);
          stale++;
        }
      } else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(p, icon.data);
        console.log(`wrote ${p} (${icon.data.length} bytes)`);
      }
    }
  }
  if (check && stale) {
    console.error("Run: node design/icons.mjs");
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
