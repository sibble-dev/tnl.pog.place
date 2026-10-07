// Builds public/data/layout.bin, the edge-map template used to find the character screen
// in a screenshot (lib/layout.ts), from a reference screenshot whose slot positions are
// the ones in lib/slots.ts.
//
// Usage: node scripts/build-layout.ts [reference.png]   (default ../layout_reference.png)
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { areaResize, gradient, grayOf } from "../lib/layout.ts";

const REF = process.argv[2] ?? path.resolve(import.meta.dirname, "..", "..", "layout_reference.png");
const OUT = path.resolve(import.meta.dirname, "..", "public", "data", "layout.bin");
// template heights, small -> large (coarse-to-fine search levels)
const LEVELS = [43, 86, 172];

// Regions (reference px) whose content changes between characters, left out of the template
const EXCLUDE: [number, number, number, number][] = [
  [560, 90, 965, 760], // the character
  [1150, 150, 1501, 760], // inventory grid contents
  [0, 0, 1501, 12], // window edge
];

const { data, info } = await sharp(REF).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const gray = grayOf(data, info.width, info.height);

const parts: Buffer[] = [];
const header = Buffer.alloc(6 + LEVELS.length * 4);
header.writeUInt16LE(info.width, 0);
header.writeUInt16LE(info.height, 2);
header.writeUInt16LE(LEVELS.length, 4);

for (const [i, h] of LEVELS.entries()) {
  const k = h / info.height;
  const w = Math.round(info.width * k);
  const g = gradient(areaResize(gray, info.width, info.height, w, h), w, h);
  let max = 0;
  for (const v of g) max = Math.max(max, v);

  const px = w * h;
  const buf = Buffer.alloc(2 * px);
  for (let p = 0; p < px; p++) {
    const x = p % w, y = Math.floor(p / w);
    const rx = x / k, ry = y / k;
    const border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
    const excluded = EXCLUDE.some(([x0, y0, x1, y1]) => rx >= x0 && rx < x1 && ry >= y0 && ry < y1);
    buf[p] = Math.round((g[p] / max) * 255);
    buf[px + p] = border || excluded ? 0 : 1;
  }
  header.writeUInt16LE(w, 6 + i * 4);
  header.writeUInt16LE(h, 8 + i * 4);
  parts.push(buf);
  console.log(`level ${h}px: ${w}x${h}`);
}

fs.writeFileSync(OUT, Buffer.concat([header, ...parts]));
console.log(`Wrote ${OUT} (${fs.statSync(OUT).size} bytes) from ${REF} (${info.width}x${info.height})`);
