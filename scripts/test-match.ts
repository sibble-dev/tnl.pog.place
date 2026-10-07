// Usage: node scripts/test-match.ts <screenshot.png> [slotId...]
// Prints the top matches for each slot (or just the given slots).
import fs from "node:fs";
import sharp from "sharp";
import { detectLayout, parseLayoutTemplate } from "../lib/layout.ts";
import { matchSlot, parseFeatures } from "../lib/matcher.ts";
import { SLOTS, slotBox, slotIcons } from "../lib/slots.ts";
import type { ItemData } from "../lib/types.ts";

const [shot, ...only] = process.argv.slice(2);
const data: ItemData = JSON.parse(fs.readFileSync("public/data/items.json", "utf8"));
const bin = fs.readFileSync("public/data/features.bin");
const fset = parseFeatures(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length), data.featureN);
const { data: px, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const lbin = fs.readFileSync("public/data/layout.bin");
const layout = detectLayout(px, info.width, info.height, parseLayoutTemplate(lbin.buffer.slice(lbin.byteOffset, lbin.byteOffset + lbin.length)));
console.log(`layout: scale ${layout.scale.toFixed(3)} offset (${layout.tx.toFixed(0)}, ${layout.ty.toFixed(0)}) score ${layout.score.toFixed(3)}${layout.detected ? "" : " (fallback)"}`);

for (const slot of SLOTS.filter((s) => !only.length || only.includes(s.id))) {
  const t = performance.now();
  const icons = slotIcons(slot, data.items);
  const m = matchSlot(px, info.width, info.height, slotBox(slot, layout), fset, { icons, k: 4 });
  const names = m.candidates.map(({ icon, score }) => {
    const item = data.items.find((i) => i.icon === icon)!;
    return `${score.toFixed(3)} ${item.name}`;
  });
  console.log(`${slot.label.padEnd(9)} ${String(icons.length).padStart(4)} icons ${(performance.now() - t).toFixed(0).padStart(5)}ms  ${names.join(" | ")}`);
}
