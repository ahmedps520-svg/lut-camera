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
    /** deviceId of the back camera's ultra-wide lens, once found — null until
     *  {@link discoverLenses} runs, or permanently if this device has none. */
    this.ultrawideId = null;
    this.primaryId = null;
    /** 'primary' | 'ultrawide' | null — which physical back lens is live. */
    this.activeLens = null;
    this._switchingLens = false;
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

    this.ultrawideId = null;
    this.primaryId = settings.deviceId || null;
    this.activeLens = this.isFront ? null : 'primary';
    // awaited so callers that check `hasUltrawide` right after start() (e.g.
    // to size the zoom control) see the real answer, not a false "no lens yet"
    if (!this.isFront) await this.discoverLenses();

    return this.track;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
    this.activeLens = null;
  }

  async flip(quality) {
    return this.start(this.isFront ? 'environment' : 'user', quality);
  }

  /**
   * Find the back camera's ultra-wide lens, if this device has one. iOS Safari
   * exposes each physical back lens as its own enumerated device once
   * permission is granted (labels look like "Back Ultra Wide Camera", "Back
   * Camera", "Back Telephoto Camera" — exact strings vary by device/iOS
   * version), which is the only way to reach true sub-1x framing: a digital
   * crop can only narrow the current lens's field of view, never widen it.
   */
  async discoverLenses() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const backCams = devices.filter((d) => d.kind === 'videoinput' && !/front/i.test(d.label));
      const ultra = backCams.find((d) => /ultra.?\s?wide/i.test(d.label));
      if (ultra) this.ultrawideId = ultra.deviceId;
    } catch { /* labels can be blank pre-permission on some browsers; no lens list then */ }
  }

  get hasUltrawide() { return !!this.ultrawideId; }

  /**
   * Switch the live stream to a different physical back lens. Best-effort:
   * on any failure the existing stream is left running untouched.
   * @param {'primary'|'ultrawide'} lens
   */
  async useLens(lens) {
    if (this.isFront || this._switchingLens || this.activeLens === lens) return true;
    const deviceId = lens === 'ultrawide' ? this.ultrawideId : this.primaryId;
    if (!deviceId) return false;

    this._switchingLens = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        audio: false,
      });
      const oldStream = this.stream;
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      this.video.srcObject = stream;
      await this.video.play().catch(() => {});
      oldStream?.getTracks().forEach((t) => t.stop());
      this.activeLens = lens;
      return true;
    } catch {
      return false;
    } finally {
      this._switchingLens = false;
    }
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
