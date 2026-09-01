/**
 * Generates the app icons (no dependencies — raw PNG encoder over zlib).
 *   node tools/make-icons.mjs
 *
 * Design: a rounded-square matte-black tile with a brushed-gold aperture
 * mark — a thick bevelled ring, a domed centre, four tick marks, and a warm
 * glow bleeding into the black. The "any"-purpose icons bake the rounded
 * corners in (for platforms that don't mask square PNGs themselves); the
 * maskable icon stays full-bleed per the web manifest spec, with the mark
 * kept inside the safe zone.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../assets/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── palette ────────────────────────────────────────────────
const BLACK = [7, 7, 8];
const TILE = [11, 12, 14];
const GOLD_SHADOW = [58, 38, 14];    // the dark side of the bevel
const GOLD_DEEP = [168, 122, 55];
const GOLD = [214, 165, 90];
const GOLD_HI = [247, 213, 154];
const GOLD_SPEC = [255, 244, 214];   // near-white specular highlight

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Signed distance from a superellipse rounded-rect boundary (n≈4.5 ~ iOS squircle). */
function roundedRectSD(x, y, halfW, halfH, radius, n = 4.5) {
  const qx = Math.abs(x) - (halfW - radius);
  const qy = Math.abs(y) - (halfH - radius);
  if (qx <= 0 && qy <= 0) return -radius;                       // deep interior
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  const superD = Math.pow(Math.pow(ax, n) + Math.pow(ay, n), 1 / n) - radius;
  return superD;
}

/**
 * Renders the aperture mark + tile at `size`, supersampled for clean edges.
 * @param roundedTile  bake rounded corners into the background (off for the
 *                      maskable variant, which must stay edge-to-edge).
 */
function drawIcon(size, { roundedTile = true, safeScale = 1 } = {}) {
  const SS = 4;
  const N = size * SS;
  const acc = new Float32Array(size * size * 4); // rgb + coverage
  const cornerRadius = size * 0.223;

  for (let py = 0; py < N; py++) {
    const sy = (py + 0.5) / SS - size / 2;
    for (let px = 0; px < N; px++) {
      const sx = (px + 0.5) / SS - size / 2;

      // tile shape (rounded-rect mask) vs. the pure-black margin around it
      let tileCoverage = 1;
      if (roundedTile) {
        const d = roundedRectSD(sx, sy, size / 2, size / 2, cornerRadius);
        tileCoverage = 1 - smooth(-0.75, 0.75, d);
      }

      const x = sx / (size / 2) / safeScale;   // normalised -1..1, safe-zone scaled
      const y = sy / (size / 2) / safeScale;
      const d = Math.hypot(x, y);
      const ang = Math.atan2(y, x);
      // light comes from the upper-left; facing has an ambient floor so the
      // shadow side reads as dim metal, not crushed black
      const lightX = -0.62, lightY = -0.72;
      const lightDot = (nx, ny) => clamp01((nx * lightX + ny * lightY) * 0.65 + 0.55);

      let col = roundedTile ? [...BLACK] : [...TILE];

      // soft warm glow bleeding out from the ring into the black
      const glow = Math.max(0, 1 - d / 0.85) ** 1.6;
      col = lerp3(col, GOLD_DEEP, glow * 0.30);

      // ── outer distance ring — faint, almost dissolved into the glow ──
      const outerR = 0.375, outerT = 0.01;
      const outerRing = 1 - smooth(outerT, outerT + 0.018, Math.abs(d - outerR));
      col = lerp3(col, GOLD, outerRing * 0.28);

      // ── tick marks at the cardinals, just past the outer ring ──
      for (let i = 0; i < 4; i++) {
        const a0 = (i * Math.PI) / 2;
        let da = Math.abs(((ang - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const tickR0 = 0.40, tickR1 = 0.452;
        if (da < 0.05 && d > tickR0 && d < tickR1) {
          const edge = smooth(0.05, 0.03, da) * smooth(tickR0, tickR0 + 0.01, d) * smooth(tickR1, tickR1 - 0.01, d);
          col = lerp3(col, GOLD_HI, edge * 0.9);
        }
      }

      // ── the thick bevelled washer ring — the dominant mark ──
      const ringOuter = 0.335, ringInner = 0.225;
      if (d < ringOuter + 0.02 && d > ringInner - 0.02) {
        const outerEdge = smooth(ringOuter, ringOuter - 0.008, d);
        const innerEdge = smooth(ringInner, ringInner + 0.008, d);
        const band = outerEdge * innerEdge;   // 1 inside the ring body, feathered at both edges
        if (band > 0.001) {
          // torus cross-section normal: at the outer lip it points outward/up,
          // at the inner lip it curls back under — a true bevel, not a flat ramp
          const t = clamp01((ringOuter - d) / (ringOuter - ringInner));   // 0 outer .. 1 inner
          const crossAngle = (t - 0.5) * Math.PI * 0.92;                  // -~83°..+~83°
          const nx = Math.cos(ang) * Math.cos(crossAngle);
          const ny = Math.sin(ang) * Math.cos(crossAngle);
          const nz = Math.sin(crossAngle);
          const facing = clamp01((nx * lightX + ny * lightY + nz * 0.55) * 0.62 + 0.5);

          let ringCol = lerp3(GOLD_SHADOW, GOLD_HI, facing);
          ringCol = lerp3(ringCol, GOLD, 0.18);   // lift the floor — this is lit metal, not a void
          // a crisp specular seam along the crest, offset toward the light
          const crest = 1 - Math.abs(t - 0.38);
          const seam = Math.max(0, crest - 0.86) / 0.14;
          ringCol = lerp3(ringCol, GOLD_SPEC, seam * facing * 0.7);
          col = lerp3(col, ringCol, band);
        }
      }

      // ── the domed centre ──────────────────────────────────
      const domeR = 0.148;
      if (d < domeR + 0.012) {
        const edge = smooth(domeR, domeR - 0.01, d);
        if (edge > 0.001) {
          const nx = x / Math.max(d, 1e-4), ny = y / Math.max(d, 1e-4);
          const h = Math.sqrt(Math.max(0, 1 - (d / domeR) ** 2));   // dome height, 1 at centre
          const facing = clamp01(lightDot(nx * (1 - h), ny * (1 - h)) + h * 0.6);
          let domeCol = lerp3(GOLD_DEEP, GOLD_HI, facing);
          // a small specular highlight, offset toward the light
          const specDx = x - domeR * 0.42 * lightX, specDy = y - domeR * 0.42 * lightY;
          const spec = Math.max(0, 1 - Math.hypot(specDx, specDy) / (domeR * 0.5)) ** 3;
          domeCol = lerp3(domeCol, GOLD_SPEC, spec * 0.9);
          // rim shadow at the very edge of the dome
          const rimShadow = smooth(0.84, 1, d / domeR);
          domeCol = lerp3(domeCol, GOLD_SHADOW, rimShadow * 0.55);
          col = lerp3(col, domeCol, edge);
        }
      }

      const o = (Math.floor(py / SS) * size + Math.floor(px / SS)) * 4;
      acc[o] += col[0] * tileCoverage;
      acc[o + 1] += col[1] * tileCoverage;
      acc[o + 2] += col[2] * tileCoverage;
      acc[o + 3] += tileCoverage;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const cov = acc[i * 4 + 3] / n;
    out[i * 4] = Math.round(acc[i * 4] / n / Math.max(cov, 1e-4));
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n / Math.max(cov, 1e-4));
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n / Math.max(cov, 1e-4));
    out[i * 4 + 3] = Math.round(cov * 255);
  }
  return encodePNG(size, size, out);
}

for (const size of [180, 192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, OUT), drawIcon(size, { roundedTile: true }));
  console.log(`assets/icon-${size}.png`);
}
// maskable: full-bleed square, mark shrunk to sit inside the ~80%-diameter
// safe circle so adaptive-icon shapes on Android don't crop the tick marks
writeFileSync(new URL('icon-maskable-512.png', OUT), drawIcon(512, { roundedTile: false, safeScale: 0.62 }));
console.log('assets/icon-maskable-512.png');

// favicon: small, so simplify to just the ring + dome at higher relative weight
writeFileSync(new URL('icon-32.png', OUT), drawIcon(32, { roundedTile: true }));
console.log('assets/icon-32.png');
