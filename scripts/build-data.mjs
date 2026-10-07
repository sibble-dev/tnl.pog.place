// Builds the static data the app needs from the scraped files in the parent folder.
//
// Inputs (../):  weapons.json, armor.json, accessories.json, stat_format.json,
//                icons/ + icons/manifest.json (from download_icons.py)
// Outputs (public/):
//   data/items.json     trimmed item records for tooltips + the icon list
//   data/stats.json     stat display names / formats (only the stats items use)
//   data/features.bin   per icon: N^2 alpha, N^2 luminance, (N/2)^2 Cb, (N/2)^2 Cr bytes
//   icons/...           the item icons (mirrors the CDN path)
//
// Run with `npm run data`.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// Must match what lib/matcher.ts parses
const FEATURE_N = 40;

const SOURCES = [
  { file: "weapons.json", group: "weapon" },
  { file: "armor.json", group: "armor" },
  { file: "accessories.json", group: "accessory" },
];

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PUBLIC = path.resolve(import.meta.dirname, "..", "public");

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const statFormat = readJson("stat_format.json");
const manifest = readJson("icons/manifest.json");

const stripHtml = (s) => (s ?? "").replace(/<[^>]+>/g, "").trim();
const lastKey = (obj) =>
  obj ? Object.keys(obj).sort((a, b) => Number(a) - Number(b)).at(-1) : undefined;

const iconIndex = new Map(); // icon path from API -> index in icon list
const icons = []; // { src, file } in feature order
const usedStats = new Set();
const collectStats = (obj) => Object.keys(obj ?? {}).forEach((k) => usedStats.add(k));
const counts = {};

const items = [];
for (const { file, group } of SOURCES) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    console.warn(`  ${file} not found, skipping ${group} items`);
    continue;
  }
  for (const [type, list] of Object.entries(readJson(file))) {
    for (const it of list) {
      const local = manifest[it.icon];
      if (!local) {
        console.warn(`  no local icon for ${it.id} (run download_icons.py), skipping`);
        continue;
      }
      if (!iconIndex.has(it.icon)) {
        iconIndex.set(it.icon, icons.length);
        // local is "icons/assets/..."; serve it from public/icons/assets/...
        icons.push({ src: path.join(ROOT, local), file: local });
      }

      const stats = it.itemStats ?? {};
      // itemStats.main / extra are keyed by item level
      const levels = {};
      for (const [lv, m] of Object.entries(stats.main ?? {})) {
        const { mainhand, shield, extra, armor } = m ?? {};
        levels[lv] = {
          damage: mainhand ? { min: mainhand.min, max: mainhand.max } : null,
          armor: armor ?? {},
          shield: shield ?? null,
          main: extra ?? {},
          extra: stats.extra?.[lv] ?? {},
        };
        collectStats(armor);
        collectStats(extra);
        collectStats(stats.extra?.[lv]);
        if (shield) usedStats.add(shield.statId);
      }
      for (const k of ["traits", "uniqueTraits", "resonance"]) collectStats(stats[k]);

      const randomGroups = Object.entries(stats)
        .filter(([k, v]) => k.startsWith("random_stat_group") && Array.isArray(v))
        .map(([, opts]) =>
          opts.map((o) => {
            usedStats.add(o.stat_id);
            return { stat: o.stat_id, min: o.base_value, max: o.levels?.at(-1) ?? o.base_value, probability: o.probability };
          }),
        );

      items.push({
        id: it.id,
        name: it.name,
        group,
        type,
        grade: it.grade,
        icon: iconIndex.get(it.icon),
        armorCategory: it.armorCategory ?? null,
        requiredLevel: it.requiredLevel,
        defaultLevel: lastKey(stats.main),
        levels,
        traits: stats.traits ?? {},
        uniqueTraits: stats.uniqueTraits ?? {},
        resonance: stats.resonance ?? {},
        randomGroups,
        enchantMax: Math.max(0, ...(it.itemEnchant ?? []).map((e) => e.level ?? 0)),
        description: stripHtml(it.description),
        sellPrice: it.sellPrice,
        isExchangeable: it.isExchangeable,
      });
      counts[`${group}/${type}`] = (counts[`${group}/${type}`] ?? 0) + 1;
    }
  }
}

// Icons + features
fs.rmSync(path.join(PUBLIC, "icons"), { recursive: true, force: true });
fs.mkdirSync(path.join(PUBLIC, "data"), { recursive: true });

const px = FEATURE_N * FEATURE_N;
const half = FEATURE_N / 2;
const hpx = half * half;
const perIcon = 2 * px + 2 * hpx;
const features = Buffer.alloc(perIcon * icons.length);
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
for (const [i, icon] of icons.entries()) {
  const dest = path.join(PUBLIC, icon.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(icon.src, dest);
  const raw = (n) =>
    sharp(icon.src).ensureAlpha().resize(n, n, { fit: "fill", kernel: "cubic" }).raw().toBuffer();
  const off = i * perIcon;
  // n*n alpha, n*n luminance
  const full = await raw(FEATURE_N);
  for (let p = 0; p < px; p++) {
    features[off + p] = full[p * 4 + 3];
    features[off + px + p] = clampByte(full[p * 4] * 0.299 + full[p * 4 + 1] * 0.587 + full[p * 4 + 2] * 0.114);
  }
  // (n/2)^2 Cb, (n/2)^2 Cr
  const small = await raw(half);
  for (let p = 0; p < hpx; p++) {
    const r = small[p * 4], g = small[p * 4 + 1], b = small[p * 4 + 2];
    features[off + 2 * px + p] = clampByte(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
    features[off + 2 * px + hpx + p] = clampByte(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
  }
}
fs.writeFileSync(path.join(PUBLIC, "data", "features.bin"), features);

const stats = {};
for (const id of [...usedStats].sort()) {
  const f = statFormat[id];
  stats[id] = f
    ? { name: f.name.trim(), format: f.valueFormat, multiplier: f.multiplier }
    : { name: id, format: "{0}", multiplier: 1 };
}

fs.rmSync(path.join(PUBLIC, "data", "weapons.json"), { force: true }); // replaced by items.json
fs.writeFileSync(
  path.join(PUBLIC, "data", "items.json"),
  JSON.stringify({ featureN: FEATURE_N, icons: icons.map((i) => i.file), items }),
);
fs.writeFileSync(path.join(PUBLIC, "data", "stats.json"), JSON.stringify(stats));

console.log(counts);
console.log(
  `${items.length} items, ${icons.length} icons, ${usedStats.size} stats, ` +
    `items.json ${(fs.statSync(path.join(PUBLIC, "data", "items.json")).size / 1e6).toFixed(1)} MB, ` +
    `features ${(features.length / 1e6).toFixed(1)} MB`,
);
