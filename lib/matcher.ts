// Icon matcher: compares a square region of a screenshot against item icons.
//
// The screenshot region is box-filtered down to an N x N luminance grid. Each icon is
// precomputed (scripts/build-data.mjs) as alpha + luminance and slid over the grid at
// several sizes. Each placement gets two correlation scores:
//   - masked:  alpha-weighted Pearson correlation of icon vs screenshot luminance, only
//              where the icon is drawn (ignores in-game background and glow colours)
//   - window:  correlation of the alpha-premultiplied icon, placed on an empty N x N
//              canvas, against the whole region (penalises thin icons that fit anything)
// Shape score = average of the two; the best placement per icon wins. Brightness alone
// can't tell colour variants apart (same necklace, different gem), so the finalists are
// then penalised by their colour (Cb/Cr, at half resolution) difference at that placement.

export type Box = { x: number; y: number; size: number };

export type ChromaEntry = { size: number; alpha: Float32Array; cb: Float32Array; cr: Float32Array; sumA: number };

export type FeatureEntry = {
  size: number;
  alpha: Float32Array;
  lum: Float32Array;
  sumA: number;
  sumAL: number;
  sumALL: number;
  sumPP: number;
  chroma: ChromaEntry; // the same icon at size / 2
};

export type FeatureSet = {
  n: number;
  count: number;
  entries: FeatureEntry[][]; // per icon, per size
};

/** Sizes each icon is tried at, as fractions of the N x N grid. */
export const ICON_SCALES = [0.6, 0.7, 0.8, 0.9, 1];

/** Weight of the colour penalty in the final score. */
export const COLOR_WEIGHT = 1;

/** 1D area-resampling weights from `from` source pixels to `to` target pixels. */
function areaWeights(from: number, to: number): Float32Array {
  const w = new Float32Array(to * from);
  const step = from / to;
  for (let i = 0; i < to; i++) {
    const a = i * step, b = (i + 1) * step;
    for (let j = Math.floor(a); j < Math.min(from, Math.ceil(b)); j++) {
      w[i * from + j] = (Math.min(b, j + 1) - Math.max(a, j)) / step;
    }
  }
  return w;
}

/** Area-resample a from x from grid to to x to (separable). */
function resample(src: Float32Array, from: number, to: number, w: Float32Array): Float32Array {
  const tmp = new Float32Array(to * from); // rows resampled: to x from
  for (let i = 0; i < to; i++)
    for (let j = 0; j < from; j++) {
      const wij = w[i * from + j];
      if (!wij) continue;
      for (let x = 0; x < from; x++) tmp[i * from + x] += wij * src[j * from + x];
    }
  const out = new Float32Array(to * to);
  for (let y = 0; y < to; y++)
    for (let i = 0; i < to; i++) {
      let v = 0;
      for (let j = 0; j < from; j++) v += w[i * from + j] * tmp[y * from + j];
      out[y * to + i] = v;
    }
  return out;
}

/** Area-resample alpha and alpha-premultiplied channels, then un-premultiply them. */
function resampleChannels(alpha: Float32Array, premul: Float32Array[], from: number, to: number) {
  const w = from === to ? null : areaWeights(from, to);
  const a = w ? resample(alpha, from, to, w) : alpha;
  const chans = premul.map((c) => {
    const r = w ? resample(c, from, to, w) : c;
    return r.map((v, p) => (a[p] > 1e-4 ? v / a[p] : 0));
  });
  return { a, chans };
}

function entry(size: number, alpha: Float32Array, lum: Float32Array, chroma: ChromaEntry): FeatureEntry {
  let sumA = 0, sumAL = 0, sumALL = 0, sumPP = 0;
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p], l = lum[p];
    sumA += a;
    sumAL += a * l;
    sumALL += a * l * l;
    sumPP += a * l * a * l;
  }
  return { size, alpha, lum, sumA, sumAL, sumALL, sumPP, chroma };
}

/**
 * Parse features.bin (scripts/build-data.mjs). Per icon: n*n alpha, n*n luminance, then
 * (n/2)^2 Cb and (n/2)^2 Cr bytes. Smaller placement sizes are derived here by area-resampling.
 */
export function parseFeatures(buf: ArrayBuffer, n: number): FeatureSet {
  const bytes = new Uint8Array(buf);
  const px = n * n;
  const h = n / 2;
  const hpx = h * h;
  const perIcon = 2 * px + 2 * hpx;
  const count = bytes.length / perIcon;
  // multiples of 4, so placements are even and map onto whole chroma pixels
  const sizes = ICON_SCALES.map((s) => Math.round((n * s) / 4) * 4);
  const halfWeights = areaWeights(n, h);
  const entries: FeatureEntry[][] = [];
  for (let i = 0; i < count; i++) {
    const off = i * perIcon;
    const alpha = new Float32Array(px);
    const premulL = new Float32Array(px);
    for (let p = 0; p < px; p++) {
      alpha[p] = bytes[off + p] / 255;
      premulL[p] = alpha[p] * (bytes[off + px + p] / 255);
    }
    // chroma is stored at n/2; its alpha is the full alpha downsampled
    const alphaH = resample(alpha, n, h, halfWeights);
    const premulCb = new Float32Array(hpx);
    const premulCr = new Float32Array(hpx);
    for (let p = 0; p < hpx; p++) {
      premulCb[p] = alphaH[p] * (bytes[off + 2 * px + p] / 255);
      premulCr[p] = alphaH[p] * (bytes[off + 2 * px + hpx + p] / 255);
    }
    entries.push(
      sizes.map((t) => {
        const l = resampleChannels(alpha, [premulL], n, t);
        const c = resampleChannels(alphaH, [premulCb, premulCr], h, t / 2);
        const sumA = c.a.reduce((x, y) => x + y, 0);
        return entry(t, l.a, l.chans[0], { size: t / 2, alpha: c.a, cb: c.chans[0], cr: c.chans[1], sumA });
      }),
    );
  }
  return { n, count, entries };
}

/** Box-filter a square region of RGBA pixels down to an n x n luminance grid (0..1). */
export function regionToGrid(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: Box,
  n: number,
): Float32Array {
  return regionChannels(pixels, width, height, box, n, false)[0];
}

/** Box-filter a square region down to n x n Cb and Cr grids (0..1, 0.5 = neutral). */
export function regionToChroma(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: Box,
  n: number,
): [Float32Array, Float32Array] {
  const [cb, cr] = regionChannels(pixels, width, height, box, n, true);
  return [cb, cr];
}

function regionChannels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: Box,
  n: number,
  chroma: boolean,
): Float32Array[] {
  const grid = new Float32Array(n * n);
  const grid2 = new Float32Array(chroma ? n * n : 0);
  const step = box.size / n;
  for (let gy = 0; gy < n; gy++) {
    const y0 = Math.floor(box.y + gy * step);
    const y1 = Math.max(y0 + 1, Math.floor(box.y + (gy + 1) * step));
    for (let gx = 0; gx < n; gx++) {
      const x0 = Math.floor(box.x + gx * step);
      const x1 = Math.max(x0 + 1, Math.floor(box.x + (gx + 1) * step));
      let sum = 0, sum2 = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= width) continue;
          const i = (y * width + x) * 4;
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          if (chroma) {
            sum += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
            sum2 += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
          } else {
            sum += r * 0.299 + g * 0.587 + b * 0.114;
          }
          cnt++;
        }
      }
      grid[gy * n + gx] = cnt ? sum / cnt / 255 : chroma ? 0.5 : 0;
      if (chroma) grid2[gy * n + gx] = cnt ? sum2 / cnt / 255 : 0.5;
    }
  }
  return chroma ? [grid, grid2] : [grid];
}

/** Placement offsets for an icon of `size` in an n-wide grid: centred, then every `stride` px. */
function offsets(n: number, size: number, stride: number): number[] {
  const c = (n - size) / 2;
  const out = [c];
  for (let d = stride; c - d >= 0; d += stride) out.push(c - d, c + d);
  return out;
}

export type Placement = { entry: number; ox: number; oy: number };

/**
 * Best shape score (-1..1) of each icon against the grid, indexed like the icon list.
 * `icons` limits scoring to a subset (others stay at -2); `stride` is the placement step.
 * If `placements` is given, each scored icon's best placement is written into it.
 */
export function scoreIcons(
  grid: Float32Array,
  fs: FeatureSet,
  icons?: number[],
  stride = 2,
  placements?: Placement[],
): Float32Array {
  const { n } = fs;
  const total = n * n;
  let sc = 0, scc = 0;
  for (let i = 0; i < total; i++) {
    sc += grid[i];
    scc += grid[i] * grid[i];
  }
  const varC = scc - (sc * sc) / total;

  const scores = new Float32Array(fs.count).fill(-2);
  for (const icon of icons ?? Array.from({ length: fs.count }, (_, i) => i)) {
    let best = -2;
    let bestPlace: Placement | undefined;
    for (const [ei, e] of fs.entries[icon].entries()) {
      const { size, alpha, lum, sumA, sumAL, sumALL, sumPP } = e;
      if (sumA < 1) continue;
      const meanL = sumAL / sumA;
      const varL = sumALL / sumA - meanL * meanL;
      const varP = sumPP - (sumAL * sumAL) / total;
      if (varL <= 0 || varP <= 0) continue;

      const offs = offsets(n, size, stride);
      for (const oy of offs) {
        for (const ox of offs) {
          let sAC = 0, sACC = 0, sALC = 0;
          for (let y = 0; y < size; y++) {
            const gRow = (oy + y) * n + ox;
            const iRow = y * size;
            for (let x = 0; x < size; x++) {
              const a = alpha[iRow + x];
              if (a === 0) continue;
              const c = grid[gRow + x];
              const ac = a * c;
              sAC += ac;
              sACC += ac * c;
              sALC += ac * lum[iRow + x];
            }
          }
          // masked, alpha-weighted Pearson
          const meanC = sAC / sumA;
          const varCm = sACC / sumA - meanC * meanC;
          const masked = varCm > 0 ? (sALC / sumA - meanL * meanC) / Math.sqrt(varL * varCm) : 0;
          // whole-window correlation of premultiplied icon vs region
          const windowed = varC > 0 ? (sALC - (sumAL * sc) / total) / Math.sqrt(varP * varC) : 0;
          const s = 0.5 * (masked + windowed);
          if (s > best) {
            best = s;
            bestPlace = { entry: ei, ox, oy };
          }
        }
      }
    }
    scores[icon] = best;
    if (placements && bestPlace) placements[icon] = bestPlace;
  }
  return scores;
}

/** Alpha-weighted mean Cb/Cr distance between an icon placed at (ox, oy) and the region's chroma grids (m x m). */
export function chromaDistance(
  c: ChromaEntry,
  ox: number,
  oy: number,
  cb: Float32Array,
  cr: Float32Array,
  m: number,
): number {
  if (c.sumA < 1e-3) return 0;
  let d = 0;
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      const p = y * c.size + x;
      const a = c.alpha[p];
      if (!a) continue;
      const g = (oy + y) * m + ox + x;
      d += a * Math.hypot(c.cb[p] - cb[g], c.cr[p] - cr[g]);
    }
  }
  return d / c.sumA;
}

/** Top-k icon indices by score (icons never scored, at -2, are left out). */
export function topIcons(scores: Float32Array, k: number): { icon: number; score: number }[] {
  return Array.from(scores, (score, icon) => ({ icon, score }))
    .filter((c) => c.score > -2)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export type SlotMatch = { box: Box; candidates: { icon: number; score: number }[] };

export type MatchOptions = {
  k?: number; // candidates returned
  refine?: boolean; // also try the box nudged around its position/size
  shortlist?: number; // icons carried from the coarse to the fine pass
  icons?: number[]; // only consider these icons (e.g. rings for a ring slot)
  colorWeight?: number; // how much the colour difference lowers a finalist's score
};

/**
 * Score icons for a slot, also trying the box nudged around the given position/size so a
 * roughly placed box still lines up. Coarse pass: every icon, every nudged box, sparse
 * placements. Fine pass: the best `shortlist` icons again with dense placements, then a
 * colour check at each finalist's best placement.
 * Each icon keeps its best score over all boxes; `box` is where the winner scored.
 */
export function matchSlot(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: Box,
  fs: FeatureSet,
  { k = 8, refine = true, shortlist = 25, icons, colorWeight = COLOR_WEIGHT }: MatchOptions = {},
): SlotMatch {
  const shifts = refine ? [-0.16, -0.08, 0, 0.08, 0.16] : [0];
  const scales = refine ? [0.9, 1, 1.12] : [1];
  const grids: { box: Box; grid: Float32Array }[] = [];
  for (const scale of scales) {
    const size = box.size * scale;
    for (const dy of shifts) {
      for (const dx of shifts) {
        const b = {
          x: box.x + box.size / 2 - size / 2 + dx * box.size,
          y: box.y + box.size / 2 - size / 2 + dy * box.size,
          size,
        };
        grids.push({ box: b, grid: regionToGrid(pixels, width, height, b, fs.n) });
      }
    }
  }

  const run = (subset: number[] | undefined, stride: number) => {
    const best = new Float32Array(fs.count).fill(-2);
    const bestBox: Box[] = new Array(fs.count);
    const bestPlace: Placement[] = new Array(fs.count);
    for (const { box: b, grid } of grids) {
      const placements: Placement[] = new Array(fs.count);
      const scores = scoreIcons(grid, fs, subset, stride, placements);
      for (let i = 0; i < fs.count; i++) {
        if (scores[i] > best[i]) {
          best[i] = scores[i];
          bestBox[i] = b;
          bestPlace[i] = placements[i];
        }
      }
    }
    return { best, bestBox, bestPlace };
  };

  const coarse = run(icons, 4);
  const finalists = topIcons(coarse.best, Math.max(k, shortlist)).map((c) => c.icon);
  const fine = run(finalists, 2);

  // Colour check for each finalist at its best placement
  const m = fs.n / 2;
  const chromaCache = new Map<Box, [Float32Array, Float32Array]>();
  const final = new Float32Array(fs.count).fill(-2);
  for (const icon of finalists) {
    const b = fine.bestBox[icon];
    const p = fine.bestPlace[icon];
    if (!b || !p) continue;
    let chroma = chromaCache.get(b);
    if (!chroma) {
      chroma = regionToChroma(pixels, width, height, b, m);
      chromaCache.set(b, chroma);
    }
    const c = fs.entries[icon][p.entry].chroma;
    final[icon] = fine.best[icon] - colorWeight * chromaDistance(c, p.ox / 2, p.oy / 2, chroma[0], chroma[1], m);
  }
  const candidates = topIcons(final, k);
  return { box: candidates.length ? fine.bestBox[candidates[0].icon] : box, candidates };
}
