/**
 * Capture + export.
 *
 * The still is rendered through the *same* shader as the viewfinder at full
 * sensor resolution, so the preview is the photo. Export goes out through the
 * native share sheet (on iOS that's "Save Image" → Photos), with a download
 * fallback everywhere else.
 */

const JPEG_QUALITY = 0.94;

export function frameSizeFor(video, aspect, maxLongEdge = Infinity) {
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const src = vw / vh;
  let w, h;
  if (src > aspect) { h = vh; w = Math.round(vh * aspect); }
  else { w = vw; h = Math.round(vw / aspect); }
  const long = Math.max(w, h);
  if (long > maxLongEdge) {
    const k = maxLongEdge / long;
    w = Math.round(w * k); h = Math.round(h * k);
  }
  return [Math.max(2, w), Math.max(2, h)];
}

/**
 * Render one full-resolution still.
 * @returns {Promise<{blob:Blob,width:number,height:number,thumb:string}>}
 */
export async function captureStill(renderer, video, opts) {
  const {
    aspect = 3 / 4, zoom = 1, mirror = false, lutId, mix,
    maxLongEdge = Infinity, watermark = false, lookName = '',
  } = opts;

  const [w, h] = frameSizeFor(video, aspect, maxLongEdge);

  renderer.uploadFrame(video, video.videoWidth, video.videoHeight);
  const gl = renderer.renderTo(w, h, { zoom, mirror, lutId, mix, aspect: w / h });

  // Copy out in the same tick — the drawing buffer is not preserved.
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(gl, 0, 0);

  if (watermark) drawWatermark(ctx, w, h);

  const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  const thumb = makeThumb(out, 320);
  return { blob, width: w, height: h, thumb, lookName };
}

function drawWatermark(ctx, w, h) {
  const s = Math.max(w, h);
  const pad = Math.round(s * 0.035);
  const size = Math.max(13, Math.round(s * 0.026));
  ctx.save();
  ctx.font = `600 ${size}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  const text = 'shot on LUMA';
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = size * 0.5;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillText(text, w - pad, h - pad);
  ctx.restore();
}

function makeThumb(canvas, edge) {
  const scale = edge / Math.max(canvas.width, canvas.height);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * scale));
  t.height = Math.max(1, Math.round(canvas.height * scale));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.72);
}

export function filenameFor(lookName = '', when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  const look = lookName ? '-' + lookName.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
  return `LUMA-${stamp}${look}.jpg`;
}

export function canShareFiles(blob) {
  if (!navigator.canShare || !navigator.share) return false;
  try {
    return navigator.canShare({ files: [new File([blob], 'x.jpg', { type: 'image/jpeg' })] });
  } catch { return false; }
}

/**
 * Hand the photo to the OS. On iOS/iPadOS the share sheet's "Save Image"
 * writes straight into the Photos library.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function exportToPhotos(blob, filename) {
  const file = new File([blob], filename, { type: 'image/jpeg' });
  if (canShareFiles(blob)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
