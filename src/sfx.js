/**
 * UI sound.
 *
 * Every cue is synthesised with Web Audio — no files to download, nothing to
 * wait for, and the whole set costs a few hundred bytes. iOS only allows an
 * AudioContext to start inside a user gesture, so `unlock()` is called from the
 * first touch and everything before that is silently skipped.
 */
import { prefs } from './store.js';

const MASTER_GAIN = 0.32;

class SFX {
  constructor() {
    this.enabled = prefs.get('sound', true);
    this.ctx = null;
    this.master = null;
    this.muted = false;          // set while recording, so UI cues don't bleed in
    this.lastPlay = new Map();
  }

  setEnabled(on) {
    this.enabled = !!on;
    prefs.set('sound', this.enabled);
    if (this.enabled) this.play('toggleOn'); // confirm with the thing itself
  }

  /** Must run inside a user gesture on iOS. Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = MASTER_GAIN;
        this.master.connect(this.ctx.destination);
      } catch { this.ctx = null; }
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running' && this.enabled && !this.muted; }

  /* ── voices ─────────────────────────────────────────────── */

  #tone({ freq, dur = 0.06, type = 'sine', gain = 0.5, delay = 0, slideTo = null, curve = 2 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t0 + dur);

    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.008, dur / 3));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * curve);

    osc.connect(amp).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur * curve + 0.02);
  }

  #noise({ dur = 0.05, gain = 0.4, delay = 0, freq = 2400, q = 1.2, sweepTo = null }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.value = q;
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 40), t0 + dur);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter).connect(amp).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /* ── the cue sheet ──────────────────────────────────────── */

  play(name, { throttle = 0 } = {}) {
    if (!this.ready) return;
    if (throttle) {
      const now = performance.now();
      if (now - (this.lastPlay.get(name) || 0) < throttle) return;
      this.lastPlay.set(name, now);
    }
    try { this.#render(name); } catch { /* never let a sound break a tap */ }
  }

  #render(name) {
    switch (name) {
      case 'tap':
        this.#tone({ freq: 1380, dur: 0.022, gain: 0.16, type: 'triangle' });
        break;
      case 'chip':
        this.#tone({ freq: 1150, dur: 0.026, gain: 0.2, type: 'triangle' });
        break;
      case 'tab':
        this.#tone({ freq: 720, dur: 0.04, gain: 0.22, slideTo: 940, type: 'sine' });
        break;
      case 'select':                       // a look, a plan, a filter
        this.#tone({ freq: 880, dur: 0.035, gain: 0.24, slideTo: 1320, type: 'sine' });
        break;
      case 'zoom':
        this.#tone({ freq: 1700, dur: 0.016, gain: 0.12, type: 'sine' });
        break;
      case 'slider':
        this.#tone({ freq: 2100, dur: 0.01, gain: 0.07, type: 'sine' });
        break;
      case 'focus':
        this.#tone({ freq: 2100, dur: 0.03, gain: 0.16 });
        this.#tone({ freq: 2100, dur: 0.03, gain: 0.16, delay: 0.075 });
        break;
      case 'shutter':                      // mechanical: click, then thunk
        this.#noise({ dur: 0.035, gain: 0.5, freq: 3600, q: 0.8 });
        this.#tone({ freq: 190, dur: 0.05, gain: 0.34, type: 'square', delay: 0.03 });
        this.#noise({ dur: 0.05, gain: 0.28, freq: 1400, q: 0.6, delay: 0.045, sweepTo: 500 });
        break;
      case 'mode':
        this.#tone({ freq: 420, dur: 0.11, gain: 0.2, slideTo: 1180, type: 'sine' });
        break;
      case 'recordStart':
        this.#tone({ freq: 660, dur: 0.07, gain: 0.26 });
        this.#tone({ freq: 990, dur: 0.09, gain: 0.26, delay: 0.09 });
        break;
      case 'recordStop':
        this.#tone({ freq: 990, dur: 0.07, gain: 0.26 });
        this.#tone({ freq: 620, dur: 0.11, gain: 0.26, delay: 0.09 });
        break;
      case 'timer':
        this.#tone({ freq: 1000, dur: 0.05, gain: 0.24, type: 'triangle' });
        break;
      case 'sheetOpen':
        this.#noise({ dur: 0.2, gain: 0.16, freq: 500, q: 0.7, sweepTo: 2600 });
        break;
      case 'sheetClose':
        this.#noise({ dur: 0.17, gain: 0.14, freq: 2400, q: 0.7, sweepTo: 420 });
        break;
      case 'toggleOn':
        this.#tone({ freq: 900, dur: 0.04, gain: 0.22, slideTo: 1500 });
        break;
      case 'toggleOff':
        this.#tone({ freq: 1400, dur: 0.04, gain: 0.2, slideTo: 820 });
        break;
      case 'success':                      // capture saved, import done
        [660, 880, 1320].forEach((f, i) =>
          this.#tone({ freq: f, dur: 0.09, gain: 0.2, delay: i * 0.055, type: 'sine' }));
        break;
      case 'error':
        this.#tone({ freq: 170, dur: 0.14, gain: 0.26, type: 'square' });
        this.#tone({ freq: 120, dur: 0.18, gain: 0.22, type: 'square', delay: 0.1 });
        break;
      case 'delete':
        this.#tone({ freq: 340, dur: 0.13, gain: 0.24, slideTo: 110, type: 'sawtooth' });
        break;
      case 'lock':                         // something Pro was tapped
        this.#tone({ freq: 520, dur: 0.06, gain: 0.22, type: 'triangle' });
        this.#tone({ freq: 392, dur: 0.1, gain: 0.22, type: 'triangle', delay: 0.07 });
        break;
      case 'purchase': {                   // the payoff
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((f, i) =>
          this.#tone({ freq: f, dur: 0.16, gain: 0.24, delay: i * 0.085, type: 'sine', curve: 3 }));
        this.#tone({ freq: 261.6, dur: 0.9, gain: 0.12, type: 'triangle', delay: 0.1, curve: 1.2 });
        this.#noise({ dur: 0.5, gain: 0.1, freq: 900, q: 0.5, sweepTo: 5200, delay: 0.05 });
        break;
      }
      default:
        this.#tone({ freq: 1200, dur: 0.02, gain: 0.12 });
    }
  }
}

export const sfx = new SFX();

/** Sound for a tapped element, by intent. */
export function cueFor(element) {
  if (!element) return null;
  if (element.dataset?.sfx) return element.dataset.sfx;
  if (element.classList.contains('look') || element.classList.contains('lut-card')) return 'select';
  if (element.classList.contains('plan') || element.classList.contains('seg')) return 'select';
  if (element.classList.contains('tab')) return 'tab';
  if (element.classList.contains('chip')) return 'chip';
  if (element.classList.contains('mode')) return 'mode';
  if (element.classList.contains('zoom')) return 'zoom';
  if (element.classList.contains('shot')) return 'tap';
  return 'tap';
}
