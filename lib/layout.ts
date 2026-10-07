// UI layout detection: where the character screen sits in a screenshot.
//
// The game draws the character screen at a size set by the window height and centres it,
// so different resolutions / aspect ratios move and scale every slot. A layout maps
// reference-screenshot pixels (lib/slots.ts coordinates) to screenshot pixels:
//   x' = x * scale + tx,   y' = y * scale + ty
//
// Detection compares edge maps: the reference screenshot's gradient magnitude, masked to
// static UI (panels, slot frames; not the character or inventory contents), precomputed at
// a few small sizes (scripts/build-layout.ts). The screenshot's own edge map is searched
// for the scale and offset where the two correlate best, coarse to fine.

export type Layout = {
  scale: number;
  tx: number;
  ty: number;
  score: number; // correlation of the best fit, 0..1
  detected: boolean; // false = fallback guess
};

export type TemplateLevel = { w: number; h: number; grad: Float32Array; mask: Uint8Array };
export type LayoutTemplate = { refW: number; refH: number; levels: TemplateLevel[] }; // levels small -> large

/** Below this the fit is considered unreliable and the fallback guess is used. */
export const MIN_LAYOUT_SCORE = 0.3;

// UI size relative to (screenshot height / reference height) that is searched
const F_MIN = 0.7;
const F_MAX = 1.25;
const F_STEP = 0.025;

/** Luminance (0..1) of RGBA pixels. */
export function grayOf(pixels: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = (pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114) / 255;
  }
  return g;
}

/** 1D area weights as [start index, weights[]] per output pixel. */
function axisWeights(from: number, to: number): { start: number; w: number[] }[] {
  const step = from / to;
  const out = [];
  for (let i = 0; i < to; i++) {
    const a = i * step, b = (i + 1) * step;
    const start = Math.floor(a);
    const w: number[] = [];
    for (let j = start; j < Math.min(from, Math.ceil(b)); j++) w.push((Math.min(b, j + 1) - Math.max(a, j)) / step);
    out.push({ start, w });
  }
  return out;
}

/** Area-resample a w x h grid to w2 x h2 (separable). Upsampling degrades to nearest-ish. */
export function areaResize(src: Float32Array, w: number, h: number, w2: number, h2: number): Float32Array {
  const xs = axisWeights(w, w2), ys = axisWeights(h, h2);
  const tmp = new Float32Array(w2 * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w2; x++) {
      const { start, w: ws } = xs[x];
      let v = 0;
      for (let j = 0; j < ws.length; j++) v += ws[j] * src[row + start + j];
      tmp[y * w2 + x] = v;
    }
  }
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const { start, w: ws } = ys[y];
    for (let x = 0; x < w2; x++) {
      let v = 0;
      for (let j = 0; j < ws.length; j++) v += ws[j] * tmp[(start + j) * w2 + x];
      out[y * w2 + x] = v;
    }
  }
  return out;
}

/** Central-difference gradient magnitude. */
export function gradient(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1];
      const gy = g[i + w] - g[i - w];
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/** Edge map of a gray image resized so that `k` screenshot px -> 1 level px. */
function edgeMap(gray: Float32Array, w: number, h: number, k: number) {
  const w2 = Math.max(3, Math.round(w * k)), h2 = Math.max(3, Math.round(h * k));
  return { w: w2, h: h2, g: gradient(areaResize(gray, w, h, w2, h2), w2, h2) };
}

/** Masked normalized cross-correlation of the template placed at (tx, ty) on the image. */
function ncc(t: TemplateLevel, img: { w: number; h: number; g: Float32Array }, tx: number, ty: number): number {
  const x0 = Math.max(0, tx), y0 = Math.max(0, ty);
  const x1 = Math.min(img.w, tx + t.w), y1 = Math.min(img.h, ty + t.h);
  // require most of the template to be inside the screenshot
  if ((x1 - x0) < t.w * 0.6 || (y1 - y0) < t.h * 0.75) return -1;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) {
    const trow = (y - ty) * t.w - tx;
    const irow = y * img.w;
    for (let x = x0; x < x1; x++) {
      if (!t.mask[trow + x]) continue;
      const a = t.grad[trow + x], b = img.g[irow + x];
      n++;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
  }
  if (n < 16) return -1;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
}

/** Guess used when detection fails: UI height-scaled and centred like the reference. */
export function fallbackLayout(width: number, height: number, tpl: { refW: number; refH: number }): Layout {
  const scale = height / tpl.refH;
  return { scale, tx: (width - tpl.refW * scale) / 2, ty: 0, score: 0, detected: false };
}

export function detectLayout(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  tpl: LayoutTemplate,
): Layout {
  // Work from a reduced copy: nothing below needs more than ~2x the largest level's detail
  const largest = tpl.levels[tpl.levels.length - 1];
  const reduce = Math.min(1, (2.5 * largest.h) / (F_MIN * height));
  const rw = Math.max(1, Math.round(width * reduce)), rh = Math.max(1, Math.round(height * reduce));
  let gray = grayOf(pixels, width, height);
  if (reduce < 1) gray = areaResize(gray, width, height, rw, rh);

  // level px per screenshot px, for UI scale f
  const kFor = (t: TemplateLevel, f: number) => t.h / tpl.refH / ((height / tpl.refH) * f);
  const mapFor = (t: TemplateLevel, f: number) => edgeMap(gray, rw, rh, kFor(t, f) / reduce);

  // Level 0: full search over scale and offset
  const t0 = tpl.levels[0];
  let best = { score: -2, f: 1, tx: 0, ty: 0 };
  for (let f = F_MIN; f <= F_MAX + 1e-9; f += F_STEP) {
    const img = mapFor(t0, f);
    const yr = Math.round(img.h / 3);
    for (let ty = -yr; ty <= yr; ty++) {
      for (let tx = -Math.round(t0.w / 2); tx <= img.w - Math.round(t0.w / 2); tx++) {
        const s = ncc(t0, img, tx, ty);
        if (s > best.score) best = { score: s, f, tx, ty };
      }
    }
  }

  // Finer levels: refine around the previous best
  let fStep = F_STEP;
  for (let li = 1; li < tpl.levels.length; li++) {
    const prev = tpl.levels[li - 1], t = tpl.levels[li];
    const ratio = t.h / prev.h;
    fStep /= 2;
    const cx = Math.round(best.tx * ratio), cy = Math.round(best.ty * ratio);
    const r = Math.ceil(ratio) + 1;
    const start = best;
    best = { score: -2, f: start.f, tx: cx, ty: cy };
    for (const f of [start.f - fStep, start.f, start.f + fStep]) {
      const img = mapFor(t, f);
      for (let ty = cy - r; ty <= cy + r; ty++) {
        for (let tx = cx - r; tx <= cx + r; tx++) {
          const s = ncc(t, img, tx, ty);
          if (s > best.score) best = { score: s, f, tx, ty };
        }
      }
    }
  }

  const t = tpl.levels[tpl.levels.length - 1];
  const k = kFor(t, best.f);
  const layout: Layout = {
    scale: (height / tpl.refH) * best.f,
    tx: best.tx / k,
    ty: best.ty / k,
    score: best.score,
    detected: true,
  };
  return layout.score >= MIN_LAYOUT_SCORE ? layout : { ...fallbackLayout(width, height, tpl), score: layout.score };
}

/** Serialized template: little-endian header [refW, refH, levels, (w, h)*levels], then per level grad (u8) + mask (u8). */
export function parseLayoutTemplate(buf: ArrayBuffer): LayoutTemplate {
  const view = new DataView(buf);
  const refW = view.getUint16(0, true), refH = view.getUint16(2, true), count = view.getUint16(4, true);
  let off = 6 + count * 4;
  const levels: TemplateLevel[] = [];
  for (let i = 0; i < count; i++) {
    const w = view.getUint16(6 + i * 4, true), h = view.getUint16(8 + i * 4, true);
    const px = w * h;
    const bytes = new Uint8Array(buf, off, 2 * px);
    const grad = new Float32Array(px);
    for (let p = 0; p < px; p++) grad[p] = bytes[p] / 255;
    levels.push({ w, h, grad, mask: bytes.slice(px, 2 * px) });
    off += 2 * px;
  }
  return { refW, refH, levels };
}
