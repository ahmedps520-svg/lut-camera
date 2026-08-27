/**
 * Camera device handling: stream lifecycle, facing mode, torch, zoom, focus.
 * Everything degrades quietly — iOS Safari exposes far fewer track capabilities
 * than Chrome, so each feature is probed rather than assumed.
 */
export class Camera {
  constructor() {
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    this.video = v;
    this.stream = null;
    this.facing = 'environment';
    this.track = null;
  }

  get isFront() { return this.facing === 'user'; }
  get ready() { return !!this.track && this.video.readyState >= 2; }
  get size() { return [this.video.videoWidth || 0, this.video.videoHeight || 0]; }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start(facing = this.facing, quality = 'max') {
    if (!Camera.supported) throw new Error('This browser has no camera API.');
    this.stop();
    this.facing = facing;

    const ideal = quality === 'max'
      ? { width: { ideal: 4096 }, height: { ideal: 3072 } }
      : { width: { ideal: 1920 }, height: { ideal: 1440 } };

    const attempts = [
      { video: { facingMode: { exact: facing }, ...ideal }, audio: false },
      { video: { facingMode: { ideal: facing }, ...ideal }, audio: false },
      { video: { facingMode: facing }, audio: false },
      { video: true, audio: false },
    ];

    let lastErr;
    for (const c of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (err) {
        lastErr = err;
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
      }
    }
    if (!this.stream) throw lastErr || new Error('No camera available.');

    this.track = this.stream.getVideoTracks()[0];
    const settings = this.track.getSettings?.() || {};
    if (settings.facingMode) this.facing = settings.facingMode;

    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if (this.video.readyState < 2) {
      await new Promise((res) => {
        const done = () => { this.video.removeEventListener('loadeddata', done); res(); };
        this.video.addEventListener('loadeddata', done);
        setTimeout(res, 3000);
      });
    }
    return this.track;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  async flip(quality) {
    return this.start(this.isFront ? 'environment' : 'user', quality);
  }

  caps() {
    try { return this.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  get hasTorch() { return 'torch' in this.caps(); }
  get zoomRange() {
    const c = this.caps();
    return c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step || 0.1 } : null;
  }

  async setTorch(on) {
    if (!this.track || !this.hasTorch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch { return false; }
  }

  /** Native optical/sensor zoom when available; caller falls back to digital. */
  async setZoom(z) {
    const r = this.zoomRange;
    if (!r) return false;
    try {
      await this.track.applyConstraints({
        advanced: [{ zoom: Math.min(r.max, Math.max(r.min, z)) }],
      });
      return true;
    } catch { return false; }
  }

  /** x, y are 0..1 in frame space. */
  async focusAt(x, y) {
    const c = this.caps();
    const adv = [];
    if (c.focusMode?.includes?.('single-shot')) adv.push({ focusMode: 'single-shot' });
    if (c.pointsOfInterest) adv.push({ pointsOfInterest: [{ x, y }] });
    if (!adv.length) return false;
    try { await this.track.applyConstraints({ advanced: adv }); return true; }
    catch { return false; }
  }
}

/** Human-readable reason for a getUserMedia failure. */
export function cameraErrorMessage(err) {
  if (!err) return 'Camera unavailable.';
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Enable it for this site in Settings → Safari → Camera, then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close it and try again.';
    default:
      return err.message || 'Could not start the camera.';
  }
}
