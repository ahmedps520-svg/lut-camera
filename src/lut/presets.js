/**
 * The signature look library. Each entry is a grading spec that gets baked
 * into a 3D LUT on device — no binary assets to ship, and the same specs can
 * be exported as .cube files.
 *
 * free: available without a subscription.
 */

export const CATEGORIES = { film: 'Film', cine: 'Cinema', mono: 'Mono' };

export const PRESETS = [
  // ── FILM ────────────────────────────────────────────────────────────────
  { id: 'neutral', name: 'Neutral', cat: 'film', free: true, spec: {} },

  { id: 'portra', name: 'Portra', cat: 'film', free: true, spec: {
    exposure: 0.08, temp: 0.10, tint: -0.03, contrast: 0.06, toe: 0.22, shoulder: 0.30,
    sat: -0.06, vibrance: 0.14, lift: [0.020, 0.014, 0.016], gain: [1.02, 1.0, 0.985],
    curves: { rgb: [[0,0.02],[0.25,0.24],[0.75,0.78],[1,0.985]] },
    shadowTint: [0.30, 0.36, 0.44], highlightTint: [1.0, 0.95, 0.86], toneStrength: 0.22, balance: 0.55 } },

  { id: 'gold200', name: 'Gold 200', cat: 'film', spec: {
    exposure: 0.10, temp: 0.24, contrast: 0.10, toe: 0.18, shoulder: 0.34, vibrance: 0.18,
    gain: [1.05, 1.0, 0.93], lift: [0.018, 0.012, 0.006],
    highlightTint: [1.0, 0.92, 0.72], toneStrength: 0.3, balance: 0.5 } },

  { id: 'ektar', name: 'Ektar', cat: 'film', spec: {
    contrast: 0.20, toe: 0.30, shoulder: 0.24, sat: 0.16, vibrance: 0.10, temp: 0.03,
    curves: { r: [[0,0],[0.5,0.52],[1,1]], b: [[0,0.01],[0.5,0.485],[1,0.99]] } } },

  { id: 'superia', name: 'Superia', cat: 'film', spec: {
    temp: -0.08, tint: -0.10, contrast: 0.12, toe: 0.22, shoulder: 0.20, vibrance: 0.16,
    mix: [1.02,-0.02,0, -0.03,1.05,-0.02, 0,-0.06,1.06],
    shadowTint: [0.24, 0.42, 0.38], toneStrength: 0.26, balance: 0.5 } },

  { id: 'velvia', name: 'Velvia', cat: 'film', spec: {
    contrast: 0.26, toe: 0.36, shoulder: 0.18, sat: 0.30, vibrance: 0.06, temp: 0.04,
    curves: { rgb: [[0,0],[0.22,0.17],[0.78,0.83],[1,1]] } } },

  { id: 'cinestill', name: 'Cinestill 800T', cat: 'film', spec: {
    temp: -0.26, tint: 0.06, contrast: 0.08, toe: 0.14, shoulder: 0.30, vibrance: 0.12,
    lift: [0.030, 0.026, 0.048], gain: [1.06, 0.99, 1.02],
    shadowTint: [0.16, 0.34, 0.52], highlightTint: [1.0, 0.80, 0.74], toneStrength: 0.34, balance: 0.45 } },

  { id: 'polaroid', name: 'Polaroid', cat: 'film', spec: {
    exposure: 0.12, contrast: -0.06, fade: 0.42, sat: -0.10, vibrance: 0.10, temp: 0.06,
    lift: [0.050, 0.046, 0.042], gamma: [1.03, 1.0, 0.98],
    highlightTint: [0.98, 0.94, 0.80], toneStrength: 0.26, balance: 0.4 } },

  { id: 'faded', name: 'Faded', cat: 'film', spec: {
    contrast: -0.10, fade: 0.62, sat: -0.20, temp: 0.04,
    curves: { rgb: [[0,0.09],[0.5,0.52],[1,0.94]] },
    shadowTint: [0.34, 0.32, 0.38], toneStrength: 0.3, balance: 0.5 } },

  { id: 'pastel', name: 'Pastel', cat: 'film', spec: {
    exposure: 0.18, contrast: -0.12, fade: 0.30, sat: -0.22, vibrance: 0.24, temp: -0.04,
    gamma: [1.06, 1.05, 1.04], highlightTint: [1.0, 0.96, 0.94], toneStrength: 0.3, balance: 0.35 } },

  { id: 'sunkissed', name: 'Sunkissed', cat: 'film', spec: {
    exposure: 0.14, temp: 0.30, tint: -0.06, contrast: 0.08, toe: 0.16, shoulder: 0.34, vibrance: 0.20,
    gain: [1.07, 1.01, 0.90], highlightTint: [1.0, 0.88, 0.66], toneStrength: 0.34, balance: 0.45 } },

  { id: 'crossproc', name: 'Cross Process', cat: 'film', spec: {
    contrast: 0.22, toe: 0.24, sat: 0.16,
    curves: { r: [[0,0.04],[0.35,0.30],[1,1]], g: [[0,0],[0.5,0.54],[1,0.97]], b: [[0,0.14],[0.5,0.46],[1,0.88]] } } },

  // ── CINEMA ──────────────────────────────────────────────────────────────
  { id: 'tealorange', name: 'Teal & Orange', cat: 'cine', free: true, spec: {
    contrast: 0.16, toe: 0.30, shoulder: 0.32, vibrance: 0.14, sat: -0.04,
    shadowTint: [0.10, 0.34, 0.42], highlightTint: [1.0, 0.80, 0.60], toneStrength: 0.46, balance: 0.48,
    lift: [0.006, 0.020, 0.030] } },

  { id: 'blockbuster', name: 'Blockbuster', cat: 'cine', spec: {
    contrast: 0.24, toe: 0.38, shoulder: 0.30, sat: 0.06,
    mix: [1.06,-0.04,-0.02, -0.02,1.02,0, -0.02,-0.06,1.10],
    shadowTint: [0.06, 0.26, 0.40], highlightTint: [1.0, 0.86, 0.68], toneStrength: 0.4, balance: 0.55 } },

  { id: 'bleach', name: 'Bleach Bypass', cat: 'cine', spec: {
    contrast: 0.34, toe: 0.40, shoulder: 0.26, sat: -0.46, exposure: 0.06,
    curves: { rgb: [[0,0],[0.3,0.24],[0.7,0.80],[1,1]] },
    shadowTint: [0.30, 0.33, 0.36], toneStrength: 0.2, balance: 0.5 } },

  { id: 'noirblue', name: 'Nocturne', cat: 'cine', spec: {
    exposure: -0.10, temp: -0.30, contrast: 0.20, toe: 0.34, shoulder: 0.20, sat: -0.14,
    lift: [0.004, 0.012, 0.034],
    shadowTint: [0.10, 0.18, 0.36], highlightTint: [0.82, 0.88, 1.0], toneStrength: 0.36, balance: 0.5 } },

  { id: 'neon', name: 'Neon Nights', cat: 'cine', spec: {
    contrast: 0.26, toe: 0.30, sat: 0.30, temp: -0.20, hue: -6,
    lift: [0.030, 0.006, 0.046],
    shadowTint: [0.24, 0.06, 0.46], highlightTint: [0.30, 0.92, 1.0], toneStrength: 0.44, balance: 0.5 } },

  { id: 'desert', name: 'Desert', cat: 'cine', spec: {
    temp: 0.26, tint: -0.10, contrast: 0.16, toe: 0.22, shoulder: 0.34, sat: -0.10, vibrance: 0.14,
    mix: [1.05,0.02,-0.04, 0,1.0,-0.02, -0.02,0.02,0.94],
    highlightTint: [1.0, 0.90, 0.70], toneStrength: 0.3, balance: 0.45 } },

  { id: 'arctic', name: 'Arctic', cat: 'cine', spec: {
    temp: -0.28, tint: 0.04, contrast: 0.14, toe: 0.24, shoulder: 0.28, sat: -0.24, exposure: 0.08,
    highlightTint: [0.88, 0.95, 1.0], toneStrength: 0.3, balance: 0.4 } },

  { id: 'matte', name: 'Matte Black', cat: 'cine', spec: {
    contrast: 0.10, fade: 0.34, sat: -0.12, toe: 0.10, shoulder: 0.34,
    curves: { rgb: [[0,0.07],[0.4,0.40],[1,0.96]] },
    shadowTint: [0.18, 0.20, 0.24], toneStrength: 0.3, balance: 0.5 } },

  { id: 'moonlight', name: 'Moonlight', cat: 'cine', spec: {
    exposure: -0.16, temp: -0.34, tint: 0.10, contrast: 0.22, toe: 0.40, sat: -0.06,
    lift: [0.006, 0.016, 0.040], gain: [0.94, 0.98, 1.08],
    shadowTint: [0.08, 0.16, 0.34], toneStrength: 0.34, balance: 0.6 } },

  { id: 'ember', name: 'Ember', cat: 'cine', spec: {
    temp: 0.34, contrast: 0.20, toe: 0.34, shoulder: 0.26, vibrance: 0.10,
    gain: [1.10, 0.98, 0.86], lift: [0.026, 0.010, 0.004],
    shadowTint: [0.28, 0.12, 0.06], highlightTint: [1.0, 0.84, 0.58], toneStrength: 0.36, balance: 0.5 } },

  { id: 'sage', name: 'Sage', cat: 'cine', spec: {
    tint: -0.16, contrast: 0.10, toe: 0.20, shoulder: 0.30, sat: -0.18, vibrance: 0.10,
    mix: [0.98,0.04,0, 0,1.03,0.01, 0,0.04,0.96],
    shadowTint: [0.22, 0.30, 0.24], highlightTint: [0.96, 1.0, 0.92], toneStrength: 0.3, balance: 0.5 } },

  { id: 'anamorphic', name: 'Anamorphic', cat: 'cine', spec: {
    contrast: 0.18, toe: 0.34, shoulder: 0.36, sat: -0.02, temp: -0.10,
    lift: [0.010, 0.018, 0.038], gamma: [1.0, 1.01, 1.03],
    shadowTint: [0.12, 0.22, 0.40], highlightTint: [1.0, 0.90, 0.78], toneStrength: 0.34, balance: 0.52 } },

  { id: 'kodachrome', name: 'Kodachrome', cat: 'cine', spec: {
    contrast: 0.22, toe: 0.32, shoulder: 0.22, sat: 0.14, temp: 0.06,
    curves: { r: [[0,0],[0.4,0.43],[1,1]], g: [[0,0],[0.5,0.49],[1,0.99]], b: [[0,0.02],[0.5,0.46],[1,0.96]] },
    shadowTint: [0.16, 0.18, 0.26], toneStrength: 0.24, balance: 0.55 } },

  // ── MONO ────────────────────────────────────────────────────────────────
  { id: 'noir', name: 'Noir', cat: 'mono', free: true, spec: {
    contrast: 0.30, toe: 0.42, shoulder: 0.24,
    mono: { weights: [0.26, 0.62, 0.12], curve: [[0,0],[0.28,0.20],[0.72,0.82],[1,1]] } } },

  { id: 'silvergel', name: 'Silver Gelatin', cat: 'mono', spec: {
    contrast: 0.16, toe: 0.24, shoulder: 0.30,
    mono: { weights: [0.30, 0.58, 0.12], tone: [0.51, 0.50, 0.49], toneStrength: 0.10,
            curve: [[0,0.03],[0.3,0.28],[0.7,0.76],[1,0.98]] } } },

  { id: 'platinum', name: 'Platinum', cat: 'mono', spec: {
    contrast: 0.08, fade: 0.22,
    mono: { weights: [0.32, 0.56, 0.12], tone: [0.53, 0.50, 0.46], toneStrength: 0.22,
            curve: [[0,0.06],[0.5,0.53],[1,0.96]] } } },

  { id: 'selenium', name: 'Selenium', cat: 'mono', spec: {
    contrast: 0.24, toe: 0.30,
    mono: { weights: [0.28, 0.60, 0.12], tone: [0.47, 0.49, 0.56], toneStrength: 0.26 } } },

  { id: 'sepia', name: 'Sepia', cat: 'mono', spec: {
    contrast: 0.12, fade: 0.18,
    mono: { weights: [0.34, 0.54, 0.12], tone: [0.58, 0.50, 0.39], toneStrength: 0.34,
            curve: [[0,0.05],[0.5,0.52],[1,0.97]] } } },

  { id: 'infrared', name: 'Infrared', cat: 'mono', spec: {
    contrast: 0.30, toe: 0.30, shoulder: 0.34, exposure: 0.10,
    mono: { weights: [0.10, 0.86, 0.04], curve: [[0,0],[0.35,0.42],[1,1]] } } },

  { id: 'ilford', name: 'HP5 Push', cat: 'mono', spec: {
    contrast: 0.34, toe: 0.46, shoulder: 0.14, exposure: 0.06,
    mono: { weights: [0.30, 0.58, 0.12], curve: [[0,0.02],[0.25,0.16],[0.75,0.86],[1,1]] } } },

  { id: 'fogmono', name: 'Fog', cat: 'mono', spec: {
    contrast: -0.10, fade: 0.54,
    mono: { weights: [0.30, 0.58, 0.12], tone: [0.50, 0.51, 0.54], toneStrength: 0.16,
            curve: [[0,0.12],[0.5,0.55],[1,0.92]] } } },
];

export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
export const FREE_PRESET_IDS = PRESETS.filter((p) => p.free).map((p) => p.id);
