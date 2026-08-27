/**
 * Grading maths used to bake preset LUTs on-device.
 * Everything here is pure: (spec, rgb) -> rgb, so a preset is just data.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const srgbToLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

export const linearToSrgb = (c) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;

export const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (r, g, b) => r * LUMA[0] + g * LUMA[1] + b * LUMA[2];

/** Monotone cubic (PCHIP) through control points, baked to a 256-entry table. */
export function curveTable(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);

  const n = pts.length;
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1][0] - pts[i][0];
    d[i] = (pts[i + 1][1] - pts[i][1]) / h[i];
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }

  const table = new Float32Array(256);
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
    const t = (x - pts[seg][0]) / h[seg];
    const t2 = t * t, t3 = t2 * t;
    table[i] =
      (2 * t3 - 3 * t2 + 1) * pts[seg][1] +
      (t3 - 2 * t2 + t) * h[seg] * m[seg] +
      (-2 * t3 + 3 * t2) * pts[seg + 1][1] +
      (t3 - t2) * h[seg] * m[seg + 1];
  }
  return table;
}

export function applyTable(table, x) {
  const t = clamp01(x) * 255;
  const i0 = Math.floor(t), i1 = Math.min(i0 + 1, 255), f = t - i0;
  return table[i0] * (1 - f) + table[i1] * f;
}

/** Kelvin-ish white balance as linear channel gains, luminance-preserving. */
function wbGains(temp, tint) {
  const r = 1 + 0.42 * temp + 0.02 * tint;
  const g = 1 - 0.10 * Math.abs(temp) - 0.30 * tint;
  const b = 1 - 0.38 * temp + 0.06 * tint;
  const l = luma(r, g, b) || 1;
  return [r / l, g / l, b / l];
}

/** Filmic S-curve: toe crushes, shoulder rolls off. */
function filmic(x, toe, shoulder) {
  const s = 1 / (1 + Math.exp(-(x - 0.5) * 6));
  const soft = (s - 0.0474) / 0.9052;              // renormalised sigmoid
  const lo = x < 0.5 ? toe : shoulder;
  return x + (soft - x) * lo;
}

function hueRotate(r, g, b, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  return [
    r * m[0] + g * m[1] + b * m[2],
    r * m[3] + g * m[4] + b * m[5],
    r * m[6] + g * m[7] + b * m[8],
  ];
}

/**
 * Compile a preset spec into a fast (r,g,b)->[r,g,b] function.
 * Tables and matrices are resolved once, not per lattice point.
 */
export function compileGrade(spec = {}) {
  const s = {
    exposure: 0, temp: 0, tint: 0,
    contrast: 0, pivot: 0.44, toe: 0, shoulder: 0,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
    sat: 0, vibrance: 0, hue: 0, fade: 0,
    shadowTint: null, highlightTint: null, toneStrength: 0, balance: 0,
    mono: null, curves: null, mix: null,
    ...spec,
  };

  const expMul = Math.pow(2, s.exposure);
  const [gr, gg, gb] = wbGains(s.temp, s.tint);
  const master = s.curves?.rgb ? curveTable(s.curves.rgb) : null;
  const cr = s.curves?.r ? curveTable(s.curves.r) : null;
  const cg = s.curves?.g ? curveTable(s.curves.g) : null;
  const cb = s.curves?.b ? curveTable(s.curves.b) : null;
  const mix = s.mix;

  return function grade(r0, g0, b0) {
    // ── linear-light stage ────────────────────────────────
    let r = srgbToLinear(r0) * expMul * gr;
    let g = srgbToLinear(g0) * expMul * gg;
    let b = srgbToLinear(b0) * expMul * gb;

    if (mix) {
      const nr = r * mix[0] + g * mix[1] + b * mix[2];
      const ng = r * mix[3] + g * mix[4] + b * mix[5];
      const nb = r * mix[6] + g * mix[7] + b * mix[8];
      r = nr; g = ng; b = nb;
    }

    r = clamp01(linearToSrgb(r));
    g = clamp01(linearToSrgb(g));
    b = clamp01(linearToSrgb(b));

    // ── display-referred stage ────────────────────────────
    if (s.contrast) {
      const k = 1 + s.contrast;
      r = clamp01((r - s.pivot) * k + s.pivot);
      g = clamp01((g - s.pivot) * k + s.pivot);
      b = clamp01((b - s.pivot) * k + s.pivot);
    }
    if (s.toe || s.shoulder) {
      r = clamp01(filmic(r, s.toe, s.shoulder));
      g = clamp01(filmic(g, s.toe, s.shoulder));
      b = clamp01(filmic(b, s.toe, s.shoulder));
    }
    if (master) { r = applyTable(master, r); g = applyTable(master, g); b = applyTable(master, b); }
    if (cr) r = applyTable(cr, r);
    if (cg) g = applyTable(cg, g);
    if (cb) b = applyTable(cb, b);

    // lift / gamma / gain
    r = clamp01(Math.pow(Math.max(r * s.gain[0] + s.lift[0] * (1 - r), 0), 1 / s.gamma[0]));
    g = clamp01(Math.pow(Math.max(g * s.gain[1] + s.lift[1] * (1 - g), 0), 1 / s.gamma[1]));
    b = clamp01(Math.pow(Math.max(b * s.gain[2] + s.lift[2] * (1 - b), 0), 1 / s.gamma[2]));

    // split toning
    if (s.toneStrength && (s.shadowTint || s.highlightTint)) {
      const l = luma(r, g, b);
      const hiW = clamp01((l - s.balance) / (1 - s.balance || 1));
      const loW = clamp01(1 - l / (1 - s.balance || 1));
      if (s.shadowTint) {
        const w = loW * s.toneStrength;
        r += (s.shadowTint[0] - r) * w * 0.5;
        g += (s.shadowTint[1] - g) * w * 0.5;
        b += (s.shadowTint[2] - b) * w * 0.5;
      }
      if (s.highlightTint) {
        const w = hiW * s.toneStrength;
        r += (s.highlightTint[0] - r) * w * 0.35;
        g += (s.highlightTint[1] - g) * w * 0.35;
        b += (s.highlightTint[2] - b) * w * 0.35;
      }
    }

    if (s.hue) [r, g, b] = hueRotate(r, g, b, s.hue);

    if (s.sat || s.vibrance) {
      const l = luma(r, g, b);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const cur = mx - mn;
      const amt = 1 + s.sat + s.vibrance * (1 - cur);
      r = l + (r - l) * amt;
      g = l + (g - l) * amt;
      b = l + (b - l) * amt;
    }

    if (s.mono) {
      const w = s.mono.weights || LUMA;
      let y = clamp01(r * w[0] + g * w[1] + b * w[2]);
      if (s.mono.curve) y = applyTable(compileGrade._cache(s.mono.curve), y);
      const tone = s.mono.tone;
      if (tone && s.mono.toneStrength) {
        const t = s.mono.toneStrength;
        r = y + (tone[0] - 0.5) * t * (1 - Math.abs(y - 0.5) * 1.2);
        g = y + (tone[1] - 0.5) * t * (1 - Math.abs(y - 0.5) * 1.2);
        b = y + (tone[2] - 0.5) * t * (1 - Math.abs(y - 0.5) * 1.2);
      } else { r = g = b = y; }
    }

    if (s.fade) {
      const f = s.fade;
      r = r * (1 - f * 0.35) + f * 0.13;
      g = g * (1 - f * 0.35) + f * 0.13;
      b = b * (1 - f * 0.35) + f * 0.14;
    }

    return [clamp01(r), clamp01(g), clamp01(b)];
  };
}

// tiny memo so a mono curve isn't rebuilt per lattice point
const _tables = new Map();
compileGrade._cache = (pts) => {
  const key = JSON.stringify(pts);
  let t = _tables.get(key);
  if (!t) { t = curveTable(pts); _tables.set(key, t); }
  return t;
};

/** Bake a compiled grade into a size³ LUT (red fastest — matches .cube / TEXTURE_3D). */
export function bakeLut(spec, size = 33, title = 'Look') {
  const grade = compileGrade(spec);
  const data = new Float32Array(size ** 3 * 3);
  const inv = 1 / (size - 1);
  let p = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const c = grade(r * inv, g * inv, b * inv);
        data[p++] = c[0]; data[p++] = c[1]; data[p++] = c[2];
      }
    }
  }
  return { title, size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}
