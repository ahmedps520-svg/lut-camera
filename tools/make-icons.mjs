/**
 * Generates the app icons (no dependencies — raw PNG encoder over zlib).
 *   node tools/make-icons.mjs
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

const GOLD = [227, 184, 116];
const GOLD_HI = [245, 217, 168];

/** Aperture mark on a warm-black field, supersampled 3× for clean edges. */
function drawIcon(size, { maskable = false } = {}) {
  const SS = 3;
  const acc = new Float32Array(size * size * 3);
  const N = size * SS;
  const scale = maskable ? 0.78 : 1;

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5) / N - 0.5;
      const y = (py + 0.5) / N - 0.5;
      const d = Math.hypot(x, y) / scale;
      const ang = Math.atan2(y, x);

      // background: warm black with a subtle glow behind the mark
      const glow = Math.max(0, 1 - d * 2.1) ** 2;
      let r = 11 + glow * 22, g = 13 + glow * 18, b = 16 + glow * 10;

      const ink = (t, col, a = 1) => {
        if (t <= 0) return;
        const k = Math.min(1, t) * a;
        r += (col[0] - r) * k; g += (col[1] - g) * k; b += (col[2] - b) * k;
      };

      const ring = (radius, thickness, col, a = 1) => {
        const t = 1 - Math.min(1, Math.abs(d - radius) / thickness);
        ink(t * t * (3 - 2 * t), col, a);
      };

      ring(0.375, 0.012, GOLD, 0.45);          // outer ring
      ring(0.215, 0.026, GOLD_HI, 0.95);       // inner ring
      if (d < 0.082) ink(1 - Math.max(0, (d - 0.062) / 0.02), GOLD_HI);  // centre

      // four ticks at the cardinals
      for (let i = 0; i < 4; i++) {
        const a0 = (i * Math.PI) / 2;
        let da = Math.abs(((ang - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (da < 0.055 && d > 0.285 && d < 0.345) ink(1 - da / 0.055, GOLD, 0.75);
      }

      const o = (Math.floor(py / SS) * size + Math.floor(px / SS)) * 3;
      acc[o] += r; acc[o + 1] += g; acc[o + 2] += b;
    }
  }

  const px = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = Math.round(acc[i * 3] / n);
    px[i * 4 + 1] = Math.round(acc[i * 3 + 1] / n);
    px[i * 4 + 2] = Math.round(acc[i * 3 + 2] / n);
    px[i * 4 + 3] = 255;
  }
  return encodePNG(size, size, px);
}

for (const size of [180, 192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, OUT), drawIcon(size));
  console.log(`assets/icon-${size}.png`);
}
writeFileSync(new URL('icon-maskable-512.png', OUT), drawIcon(512, { maskable: true }));
console.log('assets/icon-maskable-512.png');
