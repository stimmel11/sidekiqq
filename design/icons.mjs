#!/usr/bin/env node
/**
 * Renders the web app icons from site/public/favicon.svg (docs/WEBAPP.md §1).
 * Zero dependencies (Node >= 18): a tiny rasterizer for the shapes the mark uses
 * (one <rect> with rx and <circle>s, filled or stroked), with 4x4 supersampling, and a PNG encoder.
 * Anything else in the SVG is an error, so a redesign of the mark can't silently render wrong.
 *
 *   node design/icons.mjs          # write design/dist/icons/*.png and brain/public/icons/*.png
 *   node design/icons.mjs --check  # exit 1 if a committed icon is stale
 *
 * Variants:
 *   icon-192.png, icon-512.png   "any": the favicon as drawn (rounded corners, transparent outside)
 *   icon-maskable-512.png        "maskable": full-bleed background, mark scaled into the 80% safe zone
 *   apple-touch-icon.png (180)   full-bleed square (iOS rounds the corners itself)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "site/public/favicon.svg");
const OUT_DIRS = [join(ROOT, "design/dist/icons"), join(ROOT, "brain/public/icons")];

export const VARIANTS = [
  { file: "icon-192.png", size: 192, mode: "any" },
  { file: "icon-512.png", size: 512, mode: "any" },
  { file: "icon-maskable-512.png", size: 512, mode: "maskable" },
  { file: "apple-touch-icon.png", size: 180, mode: "fullbleed" },
];

// ---------- SVG parsing (deliberately tiny) ----------

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function hex(c) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(c ?? "");
  if (!m) throw new Error(`unsupported colour ${c}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function parseMark(svg) {
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!root) throw new Error("no <svg>");
  const vb = (attrs(root[0]).viewBox ?? "").split(/\s+/).map(Number);
  if (vb.length !== 4 || vb[0] !== 0 || vb[1] !== 0 || vb[2] !== vb[3]) throw new Error("expected a square viewBox at 0 0");
  const view = vb[2];
  const body = svg.slice(root.index + root[0].length).replace(/<\/svg>\s*$/, "");
  const shapes = [];
  let bg = null;
  for (const m of body.matchAll(/<(\w+)\b([^>]*)\/>/g)) {
    const [, name, raw] = m;
    const a = attrs(raw);
    if (name === "rect") {
      if (bg) throw new Error("only one <rect> (the background) is supported");
      if (Number(a.width) !== view || Number(a.height) !== view || (a.x ?? "0") !== "0" || (a.y ?? "0") !== "0") throw new Error("the <rect> must fill the viewBox");
      bg = { rx: Number(a.rx ?? 0), color: hex(a.fill) };
    } else if (name === "circle") {
      const c = { cx: Number(a.cx), cy: Number(a.cy), r: Number(a.r) };
      if (a.fill && a.fill !== "none") shapes.push({ ...c, kind: "fill", color: hex(a.fill) });
      else if (a.stroke) shapes.push({ ...c, kind: "ring", width: Number(a["stroke-width"] ?? 1), color: hex(a.stroke) });
      else throw new Error("circle without fill or stroke");
    } else {
      throw new Error(`unsupported element <${name}>`);
    }
  }
  if (body.replace(/<(\w+)\b[^>]*\/>/g, "").trim()) throw new Error("unsupported SVG content");
  if (!bg) throw new Error("expected a background <rect>");
  return { view, bg, shapes };
}

// ---------- rasterizing ----------

const SS = 4; // 4x4 samples per pixel

function insideRoundedSquare(x, y, side, rx) {
  if (x < 0 || y < 0 || x > side || y > side) return false;
  const cx = Math.min(Math.max(x, rx), side - rx);
  const cy = Math.min(Math.max(y, rx), side - rx);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rx * rx;
}

function inShape(s, x, y) {
  const d = Math.hypot(x - s.cx, y - s.cy);
  return s.kind === "fill" ? d <= s.r : Math.abs(d - s.r) <= s.width / 2;
}

export function render(mark, size, mode) {
  const { view, bg, shapes } = mark;
  // Map pixel space to viewBox units. Maskable: the whole mark sits inside the central 80%.
  const scale = mode === "maskable" ? view / (size * 0.8) : view / size;
  const offset = mode === "maskable" ? (size * 0.1) * scale : 0;
  const rx = mode === "any" ? bg.rx : 0;
  const px = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (pxi + (sx + 0.5) / SS) * scale - offset;
          const uy = (py + (sy + 0.5) / SS) * scale - offset;
          // Full-bleed variants paint the background over the whole canvas.
          const covered = mode === "any" ? insideRoundedSquare(ux, uy, view, rx) : true;
          if (!covered) continue;
          let col = bg.color;
          for (const s of shapes) if (inShape(s, ux, uy)) col = s.color; // later shapes paint over earlier ones
          r += col[0]; g += col[1]; b += col[2]; a += 1;
        }
      }
      const i = (py * size + pxi) * 4;
      const n = SS * SS;
      if (a > 0) {
        // Straight (not premultiplied) alpha: average the colour of covered samples only.
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// ---------- PNG ----------

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

/**
 * Decodes one of our own PNGs (8-bit RGBA, filter 0, as written by encodePng) to IHDR + raw pixels.
 * --check compares pixels, not file bytes: zlib's compressed output can differ across Node builds/CPUs.
 */
export function decodePixels(png) {
  const buf = Buffer.from(png);
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
  return { ihdr, pixels: inflateSync(Buffer.concat(idat)) };
}

export function samePixels(a, b) {
  try {
    const x = decodePixels(a);
    const y = decodePixels(b);
    return x.ihdr.equals(y.ihdr) && x.pixels.equals(y.pixels);
  } catch {
    return false;
  }
}

export function buildIcons(svg = readFileSync(SOURCE, "utf8")) {
  const mark = parseMark(svg);
  return VARIANTS.map((v) => ({ ...v, png: encodePng(render(mark, v.size, v.mode), v.size) }));
}

function main() {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const icon of buildIcons()) {
    for (const dir of OUT_DIRS) {
      const p = join(dir, icon.file);
      if (check) {
        if (!existsSync(p) || !samePixels(readFileSync(p), icon.png)) {
          console.error(`stale: ${p}`);
          stale++;
        }
      } else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(p, icon.png);
        console.log(`wrote ${p} (${icon.png.length} bytes)`);
      }
    }
  }
  if (check && stale) {
    console.error("Run: node design/icons.mjs");
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
