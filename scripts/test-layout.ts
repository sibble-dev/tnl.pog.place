// Usage: node scripts/test-layout.ts <screenshot.png>...
// Prints the detected UI layout (reference px -> screenshot px) for each screenshot.
import fs from "node:fs";
import sharp from "sharp";
import { detectLayout, parseLayoutTemplate } from "../lib/layout.ts";

const bin = fs.readFileSync("public/data/layout.bin");
const tpl = parseLayoutTemplate(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
for (const file of process.argv.slice(2)) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const t = performance.now();
  const l = detectLayout(data, info.width, info.height, tpl);
  console.log(
    `${file.split(/[\/]/).pop()} ${info.width}x${info.height}: scale ${l.scale.toFixed(3)} offset (${l.tx.toFixed(0)}, ${l.ty.toFixed(0)}) ` +
      `score ${l.score.toFixed(3)}${l.detected ? "" : " (fallback)"} in ${(performance.now() - t).toFixed(0)}ms`,
  );
}
