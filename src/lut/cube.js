/**
 * .cube LUT parser (Adobe/IRIDAS Cube spec) + helpers.
 *
 * A parsed LUT is:
 *   { title, size, data: Float32Array(size^3 * 3), domainMin: [r,g,b], domainMax: [r,g,b] }
 *
 * Data layout matches both the .cube spec and WebGL's TEXTURE_3D layout:
 * red varies fastest, then green, then blue —
 *   index(r, g, b) = (r + g * size + b * size * size) * 3
 */

const MAX_SIZE = 96;          // 96^3 = 884k entries — well past anything shipped in the wild
const MAX_BYTES = 48 * 1024 * 1024;

export class LutParseError extends Error {}

/** Parse .cube text into a LUT object. Supports 3D and 1D LUTs. */
export function parseCube(text, fallbackName = 'Imported LUT') {
  if (typeof text !== 'string') throw new LutParseError('Not a text file.');
  if (text.length > MAX_BYTES) throw new LutParseError('File is too large.');

  let title = '';
  let size3d = 0;
  let size1d = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const rows = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const upper = line.toUpperCase();

    if (upper.startsWith('TITLE')) {
      const m = line.match(/"([^"]*)"/);
      title = (m ? m[1] : line.slice(5)).trim();
      continue;
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      size3d = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      size1d = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith('DOMAIN_MIN')) { domainMin = triple(line, domainMin); continue; }
    if (upper.startsWith('DOMAIN_MAX')) { domainMax = triple(line, domainMax); continue; }
    if (/^LUT_[13]D_INPUT_RANGE/.test(upper)) {
      const v = line.split(/\s+/).slice(1).map(Number);
      if (v.length >= 2 && v.every(Number.isFinite)) {
        domainMin = [v[0], v[0], v[0]];
        domainMax = [v[1], v[1], v[1]];
      }
      continue;
    }
    if (/^[A-Z_]+$/i.test(line.split(/\s+/)[0]) && !/^[-+.\d]/.test(line)) {
      continue; // unknown keyword line — skip rather than fail
    }

    const parts = line.split(/[\s,]+/);
    if (parts.length < 3) continue;
    const r = Number(parts[0]), g = Number(parts[1]), b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new LutParseError(`Bad number on line ${i + 1}.`);
    }
    rows.push(r, g, b);
  }

  if (size3d) {
    if (!(size3d >= 2 && size3d <= MAX_SIZE)) {
      throw new LutParseError(`Unsupported LUT_3D_SIZE ${size3d} (2–${MAX_SIZE}).`);
    }
    const need = size3d ** 3 * 3;
    if (rows.length < need) {
      throw new LutParseError(`Truncated LUT: expected ${need / 3} rows, found ${rows.length / 3}.`);
    }
    return {
      title: title || fallbackName,
      size: size3d,
      data: Float32Array.from(rows.slice(0, need)),
      domainMin, domainMax,
    };
  }

  if (size1d) {
    if (!(size1d >= 2 && size1d <= 65536)) throw new LutParseError(`Unsupported LUT_1D_SIZE ${size1d}.`);
    if (rows.length < size1d * 3) throw new LutParseError('Truncated 1D LUT.');
    return {
      title: title || fallbackName,
      ...expand1d(Float32Array.from(rows.slice(0, size1d * 3)), size1d, 33),
      domainMin, domainMax,
    };
  }

  throw new LutParseError('No LUT_3D_SIZE or LUT_1D_SIZE found — is this a .cube file?');
}

function triple(line, fallback) {
  const v = line.split(/[\s,]+/).slice(1).map(Number).filter(Number.isFinite);
  if (v.length === 3) return v;
  if (v.length === 1) return [v[0], v[0], v[0]];
  return fallback;
}

/** Turn a per-channel 1D curve into an equivalent 3D LUT. */
function expand1d(curve, n, size) {
  const data = new Float32Array(size ** 3 * 3);
  const sample = (ch, x) => {
    const t = Math.min(Math.max(x, 0), 1) * (n - 1);
    const i0 = Math.floor(t), i1 = Math.min(i0 + 1, n - 1), f = t - i0;
    return curve[i0 * 3 + ch] * (1 - f) + curve[i1 * 3 + ch] * f;
  };
  let p = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[p++] = sample(0, r / (size - 1));
        data[p++] = sample(1, g / (size - 1));
        data[p++] = sample(2, b / (size - 1));
      }
    }
  }
  return { size, data };
}

/** Neutral pass-through LUT. */
export function identityLut(size = 17) {
  const data = new Float32Array(size ** 3 * 3);
  let p = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[p++] = r / (size - 1);
        data[p++] = g / (size - 1);
        data[p++] = b / (size - 1);
      }
  return { title: 'Neutral', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

/** Pack a LUT into 8-bit RGBA, ready for gl.texImage3D. */
export function toRGBA8(lut) {
  const n = lut.size ** 3;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4 + 0] = clamp8(lut.data[i * 3 + 0]);
    out[i * 4 + 1] = clamp8(lut.data[i * 3 + 1]);
    out[i * 4 + 2] = clamp8(lut.data[i * 3 + 2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

const clamp8 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/** Serialise back to .cube text (used by "export look"). */
export function toCubeText(lut, title = lut.title || 'LUMA LUT') {
  const out = [`# Generated by LUMA`, `TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${lut.size}`, ''];
  const n = lut.size ** 3;
  for (let i = 0; i < n; i++) {
    out.push(
      `${lut.data[i * 3].toFixed(6)} ${lut.data[i * 3 + 1].toFixed(6)} ${lut.data[i * 3 + 2].toFixed(6)}`
    );
  }
  return out.join('\n') + '\n';
}
