/**
 * LUMA Motion — video recorded straight off the graded canvas.
 *
 * The viewfinder canvas is already the finished image, so `captureStream()`
 * gives a video feed with the look, the grain and every adjustment baked in.
 * There is no second render path and no post-processing pass: what you see
 * recording is exactly what lands in the file.
 */

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',   // Safari / iOS
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export const MAX_CLIP_SECONDS = 300;

/** How long to wait for the microphone before recording silently. */
const MIC_TIMEOUT_MS = 2500;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** A bitrate that scales with actual pixel throughput instead of assuming 1080p. */
function bitrateFor(width, height, fps) {
  const pixelsPerSecond = width * height * fps;
  return Math.round(Math.min(50_000_000, Math.max(8_000_000, pixelsPerSecond * 0.12)));
}

export class VideoRecorder {
  constructor() {
    this.recorder = null;
    this.micStream = null;
    this.micPending = null;
    this.micDenied = false;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = '';
    this.autoStopTimer = 0;
    this.onAutoStop = null;
  }

  static get supported() {
    return typeof MediaRecorder !== 'undefined'
      && typeof HTMLCanvasElement.prototype.captureStream === 'function'
      && !!VideoRecorder.pickMimeType();
  }

  static pickMimeType() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  static extensionFor(mimeType) {
    return mimeType.includes('mp4') ? 'mp4' : 'webm';
  }

  get isRecording() { return !!this.recorder && this.recorder.state === 'recording'; }

  /**
   * Ask for the microphone up front — when the user switches into video mode —
   * so the permission prompt never sits between pressing record and the take
   * actually starting.
   * @returns {Promise<boolean>} whether a mic stream is ready
   */
  async warmUpMic({ retry = false } = {}) {
    if (this.micStream) return true;
    if (this.micDenied && !retry) return false;
    if (retry) this.micDenied = false;
    // Reuse the in-flight request: pressing record while the prompt is still
    // open must not fire a second getUserMedia.
    if (!this.micPending) {
      this.micPending = withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        }),
        MIC_TIMEOUT_MS
      ).then((stream) => {
        this.micStream = stream;
        return true;
      }).catch(() => {
        // Remember the refusal: a take must never wait on a mic that already
        // said no, or every subsequent recording starts seconds late.
        this.micStream = null;
        this.micDenied = true;
        return false;
      }).finally(() => {
        this.micPending = null;
      });
    }
    return this.micPending;
  }

  /** Try the microphone again — e.g. after the user re-enables audio. */
  retryMic() { return this.warmUpMic({ retry: true }); }

  /** Drop the mic so the OS recording indicator goes away. */
  releaseMic() {
    if (this.isRecording) return;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
  }

  get elapsed() { return this.isRecording ? (performance.now() - this.startedAt) / 1000 : 0; }

  /**
   * @param {HTMLCanvasElement} canvas the live viewfinder
   * @param {{audio?: boolean, fps?: number, maxSeconds?: number}} options
   * @returns {Promise<{audio: boolean}>} whether audio actually made it in
   */
  async start(canvas, { audio = true, fps = 30, maxSeconds = MAX_CLIP_SECONDS } = {}) {
    if (this.isRecording) throw new Error('Already recording.');
    if (!VideoRecorder.supported) throw new Error('This browser cannot record video.');

    const stream = canvas.captureStream(fps);
    let withAudio = false;

    if (audio && !this.micDenied) {
      // Normally already warm from the mode switch; if not, this races a short
      // timeout so an unanswered prompt can't hold up the take.
      if (!this.micStream) await this.warmUpMic();
    }
    const tracks = this.micStream?.getAudioTracks() ?? [];
    for (const track of tracks) stream.addTrack(track);
    withAudio = tracks.length > 0;

    this.mimeType = VideoRecorder.pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: bitrateFor(canvas.width, canvas.height, fps),
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start(1000);
    this.startedAt = performance.now();

    clearTimeout(this.autoStopTimer);
    this.autoStopTimer = setTimeout(() => { this.onAutoStop?.(); }, maxSeconds * 1000);

    return { audio: withAudio };
  }

  /** @returns {Promise<{blob: Blob, mimeType: string, duration: number}>} */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) { reject(new Error('Not recording.')); return; }
      clearTimeout(this.autoStopTimer);
      const duration = this.elapsed;

      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType || 'video/webm' });
        this.cleanup({ keepMic: true });   // stay ready for the next take
        resolve({ blob, mimeType: this.mimeType || 'video/webm', duration });
      };
      this.recorder.onerror = (event) => {
        this.cleanup();
        reject(event.error || new Error('Recording failed.'));
      };
      this.recorder.stop();
    });
  }

  cancel() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.cleanup();
  }

  cleanup({ keepMic = false } = {}) {
    clearTimeout(this.autoStopTimer);
    this.recorder = null;
    this.chunks = [];
    if (!keepMic) {
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
