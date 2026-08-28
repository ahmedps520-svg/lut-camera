import { Camera, cameraErrorMessage } from './camera.js';
import { Renderer } from './gl/renderer.js';
import { PRESETS, PRESET_BY_ID } from './lut/presets.js';
import { bakeLut } from './lut/grade.js';
import { parseCube, toCubeText, LutParseError } from './lut/cube.js';
import * as db from './store.js';
import { prefs, uid } from './store.js';
import { billing } from './billing.js';
import { captureStill, exportToPhotos, downloadBlob, filenameFor } from './capture.js';
import { VideoRecorder, formatDuration, MAX_CLIP_SECONDS } from './video.js';
import { pricing } from './pricing.js';
import { Sheets, toast, haptic, sliderRow, switchRow, actionRow } from './ui/ui.js';
import { Paywall } from './ui/paywall.js';
import { sfx, cueFor } from './sfx.js';
import { celebrate } from './ui/celebrate.js';

/* ────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────── */

const RATIOS = [
  { id: '3:4', label: '3:4', value: 3 / 4 },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '9:16', label: '9:16', value: 9 / 16 },
  { id: '2.39', label: '2.39', value: 2.39 },
];
const TIMERS = [0, 3, 10];
const PREVIEW_LUT_SIZE = 33;
const THUMB_LUT_SIZE = 17;

const state = {
  lookId: prefs.get('lookId', 'neutral'),
  mix: prefs.get('mix', 1),
  ratioIndex: Math.max(0, RATIOS.findIndex((r) => r.id === prefs.get('ratio', '3:4'))),
  timerIndex: 0,
  zoom: 1,
  grid: prefs.get('grid', false),
  torch: false,
  compare: false,
  mode: 'photo',      // 'photo' | 'video'
  recording: false,
  running: false,
  busy: false,
  frames: 0,          // rendered viewfinder frames — handy when chasing jank
  // merged with the defaults so a stored blob from an older build can't leave a
  // control undefined
  adjust: {
    exposure: 0, contrast: 0, saturation: 0, temp: 0, tint: 0,
    fade: 0, sharp: 0, grain: 0, vignette: 0, halation: 0,
    ...prefs.get('adjust', {}),
  },
  settings: {
    mirrorSelfie: true,
    autoExport: false,
    quality: 'max',
    liveThumbs: true,
    recordAudio: true,
    sound: true,
    ...prefs.get('settings', {}),
  },
};

const el = (id) => document.getElementById(id);
const dom = {
  frame: el('frame'), preview: el('preview'), gate: el('gate'), gateSub: el('gateSub'),
  stage: el('stage'), controls: el('controls'),
  topbar: el('topbar'), grid: el('gridOverlay'), focus: el('focusRing'), flash: el('shutterFlash'),
  compare: el('compareBadge'), countdown: el('countdown'),
  filmstrip: el('filmstrip'), lutName: el('lutName'), strength: el('strength'), strengthVal: el('strengthVal'),
  shutter: el('shutter'), lastShot: el('lastShot'), zoomRail: el('zoomRail'),
  proLabel: el('proLabel'), btnPro: el('btnPro'),
  lutGrid: el('lutGrid'), shotGrid: el('shotGrid'), galleryEmpty: el('galleryEmpty'),
  adjustBody: el('adjustBody'), settingsBody: el('settingsBody'),
  fileInput: el('fileInput'), dropzone: el('dropzone'),
  viewer: el('viewer'), viewerImg: el('viewerImg'), viewerMeta: el('viewerMeta'),
  viewerVideo: el('viewerVideo'),
  modeSwitch: el('modeSwitch'), modeLock: el('modeLock'),
  recHud: el('recHud'), recTime: el('recTime'),
};

const camera = new Camera();
const recorder = new VideoRecorder();
const sheets = new Sheets(el('scrim'));
const paywall = new Paywall();

let preview = null;    // Renderer for the viewfinder + full-res capture
let thumbs = null;     // Renderer for filmstrip / grid thumbnails
let looks = [];        // [{id,name,cat,free,custom}]
const bakeCache = new Map();   // `${id}@${size}` -> parsed LUT

const ratio = () => RATIOS[state.ratioIndex];
const currentLook = () => looks.find((l) => l.id === state.lookId) || looks[0];

/* ────────────────────────────────────────────────────────────
   Look library
   ──────────────────────────────────────────────────────────── */

async function loadLooks() {
  const custom = await db.allLuts().catch(() => []);
  looks = [
    ...PRESETS.map((p) => ({ id: p.id, name: p.name, cat: p.cat, free: !!p.free, custom: false })),
    ...custom
      .sort((a, b) => a.createdAt - b.createdAt)
      // an imported LUT is always usable — the free tier limits how many you
      // can hold, not whether you can shoot with the one you have
      .map((c) => ({ id: c.id, name: c.name, cat: 'custom', free: true, custom: true, size: c.size })),
  ];
  if (!looks.some((l) => l.id === state.lookId)) state.lookId = 'neutral';
}

/** Get (and cache) the baked/parsed LUT for a look at a given lattice size. */
async function lutFor(id, size) {
  const key = `${id}@${size}`;
  const hit = bakeCache.get(key);
  if (hit) return hit;

  const look = looks.find((l) => l.id === id);
  let lut;
  if (look?.custom) {
    const rec = await db.allLuts().then((all) => all.find((x) => x.id === id));
    if (!rec) throw new Error('LUT missing');
    lut = { title: rec.name, size: rec.size, data: rec.data, domainMin: rec.domainMin, domainMax: rec.domainMax };
  } else {
    const preset = PRESET_BY_ID.get(id);
    lut = bakeLut(preset ? preset.spec : {}, size, preset?.name || 'Look');
  }
  bakeCache.set(key, lut);
  return lut;
}

async function ensureUploaded(renderer, id, size) {
  const key = renderer === preview ? `p:${id}:${size}` : `t:${id}:${size}`;
  if (renderer.hasLut(id) && renderer._uploaded?.get(id) === key) return;
  const lut = await lutFor(id, size);
  renderer.setLut(id, lut);
  (renderer._uploaded ||= new Map()).set(id, key);
}

/* ────────────────────────────────────────────────────────────
   Render loop
   ──────────────────────────────────────────────────────────── */

let lastBox = '';

/**
 * Size the viewfinder to the selected aspect.
 *
 * Measured against the stage and the control block rather than the frame
 * itself, so setting the frame's size can't feed back into the measurement.
 */
function syncFrameBox() {
  const stage = dom.stage.getBoundingClientRect();
  const controls = dom.controls.getBoundingClientRect();
  if (!stage.width) return;

  const availW = Math.max(1, stage.width - 20);
  const availH = Math.max(1, stage.height - controls.height - 6);
  const r = ratio().value;

  let w = availW;
  let h = availW / r;
  if (h > availH) { h = availH; w = availH * r; }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const sig = `${w.toFixed(2)}x${h.toFixed(2)}@${dpr}`;
  if (sig === lastBox) return;
  lastBox = sig;

  dom.frame.style.width = w + 'px';
  dom.frame.style.height = h + 'px';
  preview.resize(w * dpr, h * dpr);
}

function drawPreview() {
  if (!preview || !camera.ready) return;
  preview.uploadFrame(camera.video, camera.video.videoWidth, camera.video.videoHeight);
  preview.draw({
    aspect: ratio().value,
    zoom: state.zoom,
    mirror: camera.isFront,
    lutId: state.compare ? '__identity__' : state.lookId,
    mix: state.compare ? 0 : state.mix,
  });
}

let rafId = 0;
let lastThumbRefresh = 0;

/** Full-screen surfaces cover the viewfinder — stop feeding it while they're up. */
function viewfinderObscured() {
  return paywall.isOpen || !dom.viewer.hidden || document.hidden;
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  if (!state.running || state.busy || viewfinderObscured()) return;
  syncFrameBox();
  drawPreview();
  state.frames++;
  if (state.settings.liveThumbs && now - lastThumbRefresh > 2000) {
    lastThumbRefresh = now;
    refreshThumbs();
  }
}

/* ────────────────────────────────────────────────────────────
   Thumbnails
   ──────────────────────────────────────────────────────────── */

const refCanvas = document.createElement('canvas');
refCanvas.width = refCanvas.height = 144;

function grabReference() {
  const ctx = refCanvas.getContext('2d');
  if (camera.ready) {
    const v = camera.video;
    const s = Math.min(v.videoWidth, v.videoHeight);
    ctx.save();
    if (camera.isFront) { ctx.translate(refCanvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, 144, 144);
    ctx.restore();
  } else {
    // A calibration ramp so looks still read when the camera is off.
    const g = ctx.createLinearGradient(0, 0, 144, 144);
    g.addColorStop(0, '#f2c48a'); g.addColorStop(0.35, '#9aa7b4');
    g.addColorStop(0.7, '#3d5566'); g.addColorStop(1, '#12161b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 144, 144);
    ctx.fillStyle = '#d8a882'; ctx.beginPath(); ctx.arc(52, 60, 30, 0, 7); ctx.fill();
    ctx.fillStyle = '#e8e4dc'; ctx.fillRect(0, 120, 144, 24);
  }
  return refCanvas;
}

let thumbQueue = [];
let thumbTicking = false;

/**
 * Thumbnails only re-render for canvases actually on screen. The filmstrip
 * scrolls horizontally and the Looks sheet is usually closed, so this keeps
 * the work at a handful of 120px draws per refresh instead of all 33 looks —
 * which matters a lot for battery and heat on a phone.
 */
const thumbTargets = new Set();
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(
      (entries) => { for (const e of entries) e.target._visible = e.isIntersecting; },
      { threshold: 0.01 }
    )
  : null;

function registerThumb(id, canvas) {
  canvas._lookId = id;
  thumbTargets.add(canvas);
  thumbObserver?.observe(canvas);
}

function clearThumbRegistry() {
  for (const c of thumbTargets) thumbObserver?.unobserve(c);
  thumbTargets.clear();
}

function pruneThumbs() {
  for (const c of thumbTargets) {
    if (!c.isConnected) { thumbObserver?.unobserve(c); thumbTargets.delete(c); }
  }
}

function visibleThumbIds() {
  const byId = new Map();
  for (const c of thumbTargets) {
    if (c._visible === false) continue;      // undefined = not observed yet, draw it once
    const list = byId.get(c._lookId) || [];
    list.push(c);
    byId.set(c._lookId, list);
  }
  return byId;
}

const TILE = 120;
const atlas = document.createElement('canvas');
const atlasCtx = atlas.getContext('2d');
const MAX_TILES = 8;

/**
 * Render up to MAX_TILES looks per pass as tiles of one GL surface, then read
 * the whole surface back once. Reading a WebGL canvas back into 2D is by far
 * the most expensive step here, so doing it once per batch instead of once per
 * look is what keeps the strip smooth (and the phone cool).
 */
function refreshThumbs() {
  if (!thumbs) return;
  pruneThumbs();
  const byId = visibleThumbIds();
  if (!byId.size) return;
  thumbQueue = [...byId.entries()];
  if (!thumbTicking) { thumbTicking = true; requestAnimationFrame(drainThumbQueue); }
}

async function drainThumbQueue() {
  const batch = thumbQueue.splice(0, MAX_TILES);
  const live = batch
    .map(([id, canvases]) => [id, canvases.filter((c) => c.isConnected && c._visible !== false)])
    .filter(([, canvases]) => canvases.length);

  if (live.length) {
    // Resolve every LUT upload first: the draw + readback below must run in one
    // synchronous block, or the drawing buffer can be cleared underneath us.
    for (const [id] of live) {
      try { await ensureUploaded(thumbs, id, THUMB_LUT_SIZE); }
      catch { /* skip a LUT that failed to load */ }
    }
    const drawable = live.filter(([id]) => thumbs.hasLut(id));
    if (drawable.length) {
      grabReference();
      thumbs.uploadFrame(refCanvas, 144, 144);
      thumbs.resize(TILE * drawable.length, TILE);
      drawable.forEach(([id], i) => {
        thumbs.draw({ lutId: id, mix: 1, aspect: 1, grain: 0, viewport: [i * TILE, 0, TILE, TILE] });
      });

      atlas.width = thumbs.canvas.width;
      atlas.height = TILE;
      atlasCtx.drawImage(thumbs.canvas, 0, 0);   // the one readback

      drawable.forEach(([, canvases], i) => {
        for (const c of canvases) {
          if (c.width !== TILE) { c.width = TILE; c.height = TILE; }
          c.getContext('2d').drawImage(atlas, i * TILE, 0, TILE, TILE, 0, 0, TILE, TILE);
        }
      });
    }
  }

  if (thumbQueue.length) requestAnimationFrame(drainThumbQueue);
  else thumbTicking = false;
}

/* ────────────────────────────────────────────────────────────
   Filmstrip + look selection
   ──────────────────────────────────────────────────────────── */

const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/></svg>';

function buildFilmstrip() {
  dom.filmstrip.textContent = '';
  clearThumbRegistry();
  for (const look of looks) {
    const btn = document.createElement('button');
    btn.className = 'look' + (look.id === state.lookId ? ' on' : '');
    btn.dataset.id = look.id;
    btn.setAttribute('role', 'tab');

    const wrap = document.createElement('span');
    wrap.className = 'look-thumb';
    const c = document.createElement('canvas');
    wrap.appendChild(c);
    registerThumb(look.id, c);

    if (!billing.canUseLook(look)) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.innerHTML = LOCK_SVG;
      wrap.appendChild(lock);
    }

    const name = document.createElement('span');
    name.className = 'look-name';
    name.textContent = look.name;

    btn.append(wrap, name);
    btn.addEventListener('click', () => selectLook(look.id));
    dom.filmstrip.appendChild(btn);
  }
  refreshThumbs();
  scrollLookIntoView(false);
}

function scrollLookIntoView(smooth = true) {
  const active = dom.filmstrip.querySelector('.look.on');
  active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
}

async function selectLook(id) {
  const look = looks.find((l) => l.id === id);
  if (!look) return;
  if (!billing.canUseLook(look)) {
    haptic(14);
    sfx.play('lock');
    paywall.open(`“${look.name}” is part of LUMA Pro`);
    return;
  }
  state.lookId = id;
  prefs.set('lookId', id);
  haptic(6);
  dom.lutName.textContent = look.name;
  for (const b of dom.filmstrip.children) b.classList.toggle('on', b.dataset.id === id);
  for (const c of dom.lutGrid.children) c.classList.toggle('on', c.dataset.id === id);
  scrollLookIntoView();
  try {
    await ensureUploaded(preview, id, PREVIEW_LUT_SIZE);
  } catch (err) {
    toast('That LUT could not be loaded.', 'bad');
  }
}

/* ────────────────────────────────────────────────────────────
   LUT sheet
   ──────────────────────────────────────────────────────────── */

let lutFilter = 'all';

function buildLutGrid() {
  dom.lutGrid.textContent = '';
  const list = looks.filter((l) => lutFilter === 'all'
    || (lutFilter === 'custom' ? l.custom : l.cat === lutFilter));

  for (const look of list) {
    const card = document.createElement('div');
    card.className = 'lut-card' + (look.id === state.lookId ? ' on' : '');
    card.dataset.id = look.id;

    const pane = document.createElement('div');
    pane.className = 'pane';
    const c = document.createElement('canvas');
    pane.appendChild(c);
    registerThumb(look.id, c);

    if (!billing.canUseLook(look)) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'PRO';
      pane.appendChild(badge);
    }
    if (look.custom) {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Delete ${look.name}`);
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await db.deleteLut(look.id);
        preview.dropLut(look.id);
        thumbs.dropLut(look.id);
        bakeCache.delete(`${look.id}@${PREVIEW_LUT_SIZE}`);
        bakeCache.delete(`${look.id}@${THUMB_LUT_SIZE}`);
        if (state.lookId === look.id) await selectLook('neutral');
        await loadLooks();
        rebuildLookUI();
        sfx.play('delete');
        toast(`Removed “${look.name}”.`);
      });
      pane.appendChild(del);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="t"></span><span class="s"></span>`;
    meta.querySelector('.t').textContent = look.name;
    meta.querySelector('.s').textContent = look.custom
      ? `Imported · ${look.size}³`
      : { film: 'Film', cine: 'Cinema', mono: 'Mono' }[look.cat] || '';

    card.append(pane, meta);
    card.addEventListener('click', () => selectLook(look.id));
    dom.lutGrid.appendChild(card);
  }
  refreshThumbs();
}

function rebuildLookUI() {
  clearThumbRegistry();
  buildFilmstrip();
  if (sheets.openName === 'luts') buildLutGrid();
  dom.lutName.textContent = currentLook()?.name || 'Neutral';
}

/* ────────────────────────────────────────────────────────────
   Import
   ──────────────────────────────────────────────────────────── */

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /\.cube$/i.test(f.name) || f.type === 'text/plain');
  if (!files.length) { toast('Only .cube LUT files can be imported.', 'bad'); return; }

  const existing = looks.filter((l) => l.custom).length;
  let imported = 0;

  for (const file of files) {
    if (!billing.canImport(existing + imported)) {
      paywall.open('Unlimited LUT imports are part of LUMA Pro');
      break;
    }
    try {
      if (file.size > 48 * 1024 * 1024) throw new LutParseError('File is too large.');
      const text = await file.text();
      const lut = parseCube(text, file.name.replace(/\.cube$/i, ''));
      const id = 'user_' + uid();
      await db.saveLut({
        id,
        name: (lut.title || file.name.replace(/\.cube$/i, '')).slice(0, 40),
        size: lut.size,
        data: lut.data,
        domainMin: lut.domainMin,
        domainMax: lut.domainMax,
        createdAt: Date.now(),
      });
      imported++;
      await loadLooks();
      rebuildLookUI();
      await selectLook(id);
      sfx.play('success');
      toast(`Imported “${lut.title}” · ${lut.size}³`, 'gold');
    } catch (err) {
      sfx.play('error');
      toast(err instanceof LutParseError ? err.message : `Could not read ${file.name}.`, 'bad', 3200);
    }
  }
}

function wireImport() {
  el('btnImport').addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', async (e) => {
    await importFiles(e.target.files);
    e.target.value = '';
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault(); dragDepth++; dom.dropzone.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; dom.dropzone.hidden = true; }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0; dom.dropzone.hidden = true;
    if (e.dataTransfer?.files?.length) await importFiles(e.dataTransfer.files);
  });
}

/* ────────────────────────────────────────────────────────────
   Adjust sheet
   ──────────────────────────────────────────────────────────── */

const ADJUSTMENTS = [
  { group: 'Tone' },
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) },
  { key: 'contrast', label: 'Contrast', min: -0.5, max: 0.5, step: 0.01, fmt: pct },
  { key: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01, fmt: pct, pro: true },
  { group: 'Colour' },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01, fmt: pct },
  { key: 'temp', label: 'Temperature', min: -1, max: 1, step: 0.01, fmt: pct },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, fmt: pct, pro: true },
  { group: 'Texture' },
  { key: 'sharp', label: 'Clarity', min: 0, max: 1, step: 0.01, fmt: pct, pro: true },
  { key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01, fmt: pct, pro: true },
  { key: 'halation', label: 'Halation', min: 0, max: 1, step: 0.01, fmt: pct, pro: true },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: pct, pro: true },
];

function pct(v) { return Math.round(v * 100) + (v > 0 ? '' : ''); }

function buildAdjust() {
  dom.adjustBody.textContent = '';
  const rows = [];
  for (const item of ADJUSTMENTS) {
    if (item.group) {
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = item.group;
      dom.adjustBody.appendChild(h);
      continue;
    }
    const locked = item.pro && !billing.isPro;
    const row = sliderRow({
      label: item.label,
      min: item.min, max: item.max, step: item.step,
      value: state.adjust[item.key],
      format: item.fmt,
      locked,
      onInput: (v) => {
        state.adjust[item.key] = v;
        applyAdjust();
        prefs.set('adjust', state.adjust);
      },
    });
    if (locked) {
      row.addEventListener('click', () => paywall.open('Pro controls unlock with LUMA Pro'));
      const lock = document.createElement('span');
      lock.innerHTML = LOCK_SVG;
      lock.style.cssText = 'width:13px;height:13px;color:var(--gold);flex:none';
      row.querySelector('.adj-label').appendChild(lock);
      row.querySelector('.adj-label').style.display = 'flex';
      row.querySelector('.adj-label').style.gap = '6px';
      row.querySelector('.adj-label').style.alignItems = 'center';
    }
    row.dataset.key = item.key;
    rows.push(row);
    dom.adjustBody.appendChild(row);
  }
  dom.adjustBody._rows = rows;
}

function applyAdjust() {
  if (!preview) return;
  Object.assign(preview.params, state.adjust);
  if (thumbs) Object.assign(thumbs.params, { ...state.adjust, grain: 0, halation: 0, vignette: 0 });
}

function resetAdjust() {
  for (const k of Object.keys(state.adjust)) state.adjust[k] = 0;
  prefs.set('adjust', state.adjust);
  applyAdjust();
  buildAdjust();
  toast('Adjustments reset.');
}

/* ────────────────────────────────────────────────────────────
   Settings sheet
   ──────────────────────────────────────────────────────────── */

async function buildSettings() {
  const body = dom.settingsBody;
  body.textContent = '';

  const banner = document.createElement('button');
  banner.className = 'pro-banner';
  banner.style.width = '100%';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" class="ico"><path d="m12 2 2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.1 6.1 20.2l1.2-6.6L2.5 9l6.6-.9L12 2Z" fill="currentColor"/></svg>
    <span style="flex:1;text-align:left">
      <span class="t" style="display:block">${billing.isPro ? 'LUMA Pro' : 'Unlock LUMA Pro'}</span>
      <span class="s">${billing.isPro ? billing.statusLabel : `${PRESETS.length - 1} looks, unlimited imports, clean exports`}</span>
    </span>
    <span style="color:var(--gold);font-size:13px">${billing.isPro ? 'Manage' : 'View'}</span>`;
  banner.addEventListener('click', async () => {
    if (billing.isPro) {
      toast(await billing.adapter.manage() || 'Manage your subscription in the App Store.', '', 3200);
    } else paywall.open();
  });
  body.appendChild(banner);

  const mk = (node) => body.appendChild(node);

  mk(switchRow({
    title: 'Mirror front camera',
    sub: 'Save selfies exactly as you see them',
    checked: state.settings.mirrorSelfie,
    onChange: (v) => { state.settings.mirrorSelfie = v; saveSettings(); },
  }));

  mk(switchRow({
    title: 'Share sheet after capture',
    sub: 'Jump straight to Save to Photos',
    checked: state.settings.autoExport,
    onChange: (v) => { state.settings.autoExport = v; saveSettings(); },
  }));

  mk(switchRow({
    title: 'Sound effects',
    sub: 'Shutter, ticks and cues throughout the app',
    checked: state.settings.sound,
    onChange: (v) => {
      state.settings.sound = v;
      saveSettings();
      sfx.setEnabled(v);
    },
  }));

  mk(switchRow({
    title: 'Record sound with video',
    sub: 'Adds the microphone to Motion clips',
    checked: state.settings.recordAudio,
    badge: 'PRO',
    onChange: (v) => {
      state.settings.recordAudio = v;
      saveSettings();
      // turning it back on is an explicit ask — try the mic again
      if (v) recorder.retryMic(); else recorder.releaseMic();
    },
  }));

  mk(switchRow({
    title: 'Live look previews',
    sub: 'Render every look from the live frame',
    checked: state.settings.liveThumbs,
    onChange: (v) => { state.settings.liveThumbs = v; saveSettings(); if (v) refreshThumbs(); },
  }));

  const qualityRow = actionRow({
    title: 'Capture quality',
    sub: billing.isPro ? 'Full sensor resolution' : 'Free exports are capped at 1600px',
    value: state.settings.quality === 'max' ? 'Max' : '1080p',
    onClick: async (row) => {
      state.settings.quality = state.settings.quality === 'max' ? 'balanced' : 'max';
      saveSettings();
      row.setValue(state.settings.quality === 'max' ? 'Max' : '1080p');
      if (state.running) await restartCamera();
    },
  });
  mk(qualityRow);

  mk(actionRow({
    title: 'Export current look as .cube',
    sub: billing.isPro ? `${currentLook()?.name} · 33³` : 'Pro',
    value: '↓',
    onClick: async () => {
      if (!billing.isPro) { paywall.open('Exporting .cube files is part of LUMA Pro'); return; }
      const look = currentLook();
      const lut = await lutFor(look.id, PREVIEW_LUT_SIZE);
      const blob = new Blob([toCubeText(lut, look.name)], { type: 'text/plain' });
      downloadBlob(blob, `${look.name.replace(/[^\w-]+/g, '_')}.cube`);
      toast('LUT exported.');
    },
  }));

  mk(actionRow({
    title: 'Prices shown in',
    sub: pricing.auto
      ? 'Detected from your device region'
      : 'Set manually for this device',
    value: pricing.summary,
    onClick: () => {
      toast('On the App Store this follows your store account; here it follows your device region.', '', 3600);
    },
  }));

  const usage = await db.estimateUsage();
  mk(actionRow({
    title: 'On-device storage',
    sub: 'Photos and LUTs stay on this device',
    value: usage ? `${(usage.used / 1048576).toFixed(1)} MB` : '—',
    onClick: () => {},
  }));

  mk(actionRow({
    title: 'Clear photo library',
    sub: 'Deletes captures stored in the app',
    value: '',
    danger: true,
    onClick: async () => {
      const shots = await db.allShots();
      if (!shots.length) { toast('Library is already empty.'); return; }
      if (!confirm(`Delete all ${shots.length} photo(s) from the app library? Photos already exported to your album are not affected.`)) return;
      for (const s of shots) await db.deleteShot(s.id);
      await refreshGallery();
      toast('Library cleared.');
    },
  }));

  if (billing.isPro) {
    mk(actionRow({
      title: 'Demo: reset subscription',
      sub: 'Return to the free tier to inspect the paywall',
      value: '',
      danger: true,
      onClick: async () => { await billing.cancel(); toast('Back on the free tier.'); },
    }));
  }

  const about = document.createElement('p');
  about.className = 'hint';
  about.innerHTML = `LUMA · web preview build. Grading runs entirely on-device in WebGL2 —
    no frame ever leaves your phone. Add to Home Screen for the full-screen camera.`;
  body.appendChild(about);
}

function saveSettings() { prefs.set('settings', state.settings); }

/* ────────────────────────────────────────────────────────────
   Gallery
   ──────────────────────────────────────────────────────────── */

let galleryItems = [];

/** Photos and clips share one roll, newest first. */
async function refreshGallery() {
  const [shots, clips] = await Promise.all([
    db.allShots().catch(() => []),
    db.allClips().catch(() => []),
  ]);
  galleryItems = [
    ...shots.map((s) => ({ ...s, kind: 'photo' })),
    ...clips.map((c) => ({ ...c, kind: 'clip' })),
  ].sort((a, b) => b.createdAt - a.createdAt);

  dom.shotGrid.textContent = '';
  dom.galleryEmpty.hidden = galleryItems.length > 0;

  for (const item of galleryItems) {
    const cell = document.createElement('button');
    cell.className = 'shot';
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = `${item.kind === 'clip' ? 'Clip' : 'Photo'} with ${item.look || 'Neutral'}`;
    img.loading = 'lazy';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.look || 'Neutral';
    cell.append(img, tag);

    if (item.kind === 'clip') {
      const play = document.createElement('span');
      play.className = 'play';
      play.textContent = '▶';
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = formatDuration(item.duration || 0);
      cell.append(play, dur);
    }

    cell.addEventListener('click', () => openViewer(item.id, item.kind));
    dom.shotGrid.appendChild(cell);
  }

  const latest = galleryItems[0];
  dom.lastShot.textContent = '';
  if (latest) {
    const img = document.createElement('img');
    img.src = latest.thumb;
    img.alt = 'Last capture';
    dom.lastShot.appendChild(img);
  } else {
    const e = document.createElement('span');
    e.className = 'thumb-empty';
    dom.lastShot.appendChild(e);
  }
}

let viewerId = null;
let viewerKind = 'photo';
let viewerUrl = null;

const loadItem = (id, kind) => (kind === 'clip' ? db.getClip(id) : db.getShot(id));

async function openViewer(id, kind = 'photo') {
  const item = await loadItem(id, kind);
  if (!item) return;
  viewerId = id;
  viewerKind = kind;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(item.blob);

  const isClip = kind === 'clip';
  dom.viewerImg.hidden = isClip;
  dom.viewerVideo.hidden = !isClip;
  if (isClip) {
    dom.viewerVideo.src = viewerUrl;
    dom.viewerVideo.load();
  } else {
    dom.viewerImg.src = viewerUrl;
  }

  const when = new Date(item.createdAt);
  dom.viewerMeta.textContent = isClip
    ? `${item.look || 'Neutral'} · ${formatDuration(item.duration || 0)} · ${when.toLocaleDateString()}`
    : `${item.look || 'Neutral'} · ${item.width}×${item.height} · ${when.toLocaleDateString()}`;
  el('viewerSave').textContent = isClip ? 'Save to Photos' : 'Save to Photos';
  dom.viewer.hidden = false;
}

function closeViewer() {
  dom.viewer.hidden = true;
  dom.viewerVideo.pause?.();
  dom.viewerVideo.removeAttribute('src');
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  viewerId = null;
}

function nameFor(item) {
  const base = filenameFor(item.look, new Date(item.createdAt));
  return item.kind === 'clip' || item.duration != null
    ? base.replace(/\.jpg$/, '.' + VideoRecorder.extensionFor(item.mimeType || ''))
    : base;
}

function wireViewer() {
  el('viewerClose').addEventListener('click', closeViewer);
  el('viewerDelete').addEventListener('click', async () => {
    if (!viewerId) return;
    if (viewerKind === 'clip') await db.deleteClip(viewerId); else await db.deleteShot(viewerId);
    sfx.play('delete');
    closeViewer();
    await refreshGallery();
    toast(viewerKind === 'clip' ? 'Clip deleted.' : 'Photo deleted.');
  });
  el('viewerSave').addEventListener('click', async () => {
    const item = await loadItem(viewerId, viewerKind);
    if (!item) return;
    const res = await exportToPhotos(item.blob, nameFor({ ...item, kind: viewerKind }));
    if (res === 'shared') toast('Sent to the share sheet — choose Save Video or Save Image.', 'gold', 3200);
    else if (res === 'downloaded') toast('Downloaded. On iPhone, long-press to save it to Photos.', '', 3400);
  });
  el('viewerDownload').addEventListener('click', async () => {
    const item = await loadItem(viewerId, viewerKind);
    if (item) downloadBlob(item.blob, nameFor({ ...item, kind: viewerKind }));
  });
  el('btnSaveAll').addEventListener('click', async () => {
    if (!galleryItems.length) { toast('Nothing to export yet.'); return; }
    if (!billing.isPro && galleryItems.length > 3) {
      paywall.open('Batch export is part of LUMA Pro');
      return;
    }
    for (const entry of galleryItems) {
      const item = await loadItem(entry.id, entry.kind);
      if (item) downloadBlob(item.blob, nameFor({ ...item, kind: entry.kind }));
      await new Promise((r) => setTimeout(r, 220));
    }
    toast(`Exported ${galleryItems.length} item(s).`);
  });
}

/* ────────────────────────────────────────────────────────────
   Capture
   ──────────────────────────────────────────────────────────── */

async function shoot() {
  if (!state.running || state.busy) return;
  if (state.mode === 'video') {
    if (state.recording) await stopRecording();
    else await startRecording();
    return;
  }
  const seconds = TIMERS[state.timerIndex];
  if (seconds) await runCountdown(seconds);
  await doCapture();
}

function runCountdown(seconds) {
  return new Promise((resolve) => {
    let n = seconds;
    dom.countdown.hidden = false;
    const tick = () => {
      dom.countdown.textContent = n;
      dom.countdown.classList.remove('tick');
      void dom.countdown.offsetWidth;
      dom.countdown.classList.add('tick');
      haptic(10);
      sfx.play('timer');
      n--;
      if (n < 0) {
        clearInterval(timer);
        dom.countdown.hidden = true;
        resolve();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
  });
}

async function doCapture() {
  state.busy = true;
  dom.shutter.disabled = true;
  dom.flash.classList.remove('fire');
  void dom.flash.offsetWidth;
  dom.flash.classList.add('fire');
  haptic([12, 30, 8]);
  sfx.play('shutter');

  try {
    const look = currentLook();
    await ensureUploaded(preview, state.lookId, PREVIEW_LUT_SIZE);
    const shot = await captureStill(preview, camera.video, {
      aspect: ratio().value,
      zoom: state.zoom,
      mirror: camera.isFront && state.settings.mirrorSelfie,
      lutId: state.lookId,
      mix: state.mix,
      maxLongEdge: billing.maxLongEdge,
      watermark: billing.watermark,
      lookName: look?.name || '',
    });

    // the capture resized the shared canvas — restore the viewfinder surface now
    lastBox = '';
    syncFrameBox();
    drawPreview();

    const record = {
      id: uid(),
      blob: shot.blob,
      thumb: shot.thumb,
      width: shot.width,
      height: shot.height,
      look: look?.name || 'Neutral',
      createdAt: Date.now(),
    };
    await db.saveShot(record);
    await refreshGallery();
    sfx.play('success');

    if (state.settings.autoExport) {
      const res = await exportToPhotos(record.blob, filenameFor(record.look));
      if (res === 'shared') toast('Choose “Save Image” to add it to Photos.', 'gold', 3000);
      else if (res === 'downloaded') toast('Saved to your downloads.', '', 2600);
    } else {
      toast(billing.watermark
        ? `Captured · ${shot.width}×${shot.height} — Pro removes the watermark`
        : `Captured · ${shot.width}×${shot.height}`, 'gold');
    }
  } catch (err) {
    console.error(err);
    sfx.play('error');
    toast('Capture failed: ' + (err.message || err), 'bad');
  } finally {
    state.busy = false;
    dom.shutter.disabled = false;
  }
}

/* ────────────────────────────────────────────────────────────
   Motion — video recorded off the graded canvas
   ──────────────────────────────────────────────────────────── */

let recTimer = 0;

function setMode(mode) {
  if (state.recording) return;
  if (mode === 'video') {
    if (!VideoRecorder.supported) {
      toast('This browser cannot record video.', 'bad');
      return;
    }
    if (!billing.canRecordVideo) {
      haptic(14);
      sfx.play('lock');
      paywall.open('LUMA Motion — video is part of Pro');
      return;
    }
  }
  state.mode = mode;
  syncModeUI();
  haptic(6);

  // Ask for the mic on entering video mode, not on the record tap.
  if (mode === 'video' && state.settings.recordAudio) recorder.warmUpMic();
  if (mode === 'photo') recorder.releaseMic();
}

function syncModeUI() {
  for (const btn of dom.modeSwitch.children) {
    const on = btn.dataset.mode === state.mode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', String(on));
  }
  dom.modeLock.hidden = billing.isPro;
  dom.modeSwitch.hidden = !VideoRecorder.supported;
  dom.shutter.classList.toggle('video', state.mode === 'video');
  dom.shutter.setAttribute(
    'aria-label',
    state.mode === 'video' ? (state.recording ? 'Stop recording' : 'Record') : 'Capture'
  );
}

/** A still off the offscreen renderer — the live canvas can't be read back. */
async function grabClipThumb() {
  try {
    await ensureUploaded(thumbs, state.lookId, THUMB_LUT_SIZE);
    const aspect = ratio().value;
    const w = 320;
    const h = Math.round(w / aspect);
    thumbs.uploadFrame(camera.video, camera.video.videoWidth, camera.video.videoHeight);
    const gl = thumbs.renderTo(w, h, { aspect, zoom: state.zoom, mirror: camera.isFront,
                                       lutId: state.lookId, mix: state.mix, grain: 0 });
    const flat = document.createElement('canvas');
    flat.width = w; flat.height = h;
    flat.getContext('2d').drawImage(gl, 0, 0);
    return flat.toDataURL('image/jpeg', 0.7);
  } catch {
    return '';
  }
}

async function startRecording() {
  if (!billing.canRecordVideo) { paywall.open('LUMA Motion — video is part of Pro'); return; }
  try {
    const { audio } = await recorder.start(dom.preview, {
      audio: state.settings.recordAudio,
      maxSeconds: MAX_CLIP_SECONDS,
    });
    recorder.onAutoStop = () => {
      toast(`Clips are capped at ${Math.round(MAX_CLIP_SECONDS / 60)} minutes.`);
      stopRecording();
    };
    sfx.play('recordStart');
    sfx.muted = true;               // UI cues would bleed into the microphone
    state.recording = true;
    dom.shutter.classList.add('recording');
    dom.recHud.hidden = false;
    dom.recTime.textContent = '0:00';
    syncModeUI();
    haptic([16, 40, 16]);
    if (state.settings.recordAudio && !audio) {
      toast('Recording without sound — microphone unavailable.');
    }

    clearInterval(recTimer);
    recTimer = setInterval(() => {
      dom.recTime.textContent = formatDuration(recorder.elapsed);
    }, 250);
  } catch (err) {
    toast(err.message || 'Could not start recording.', 'bad');
  }
}

async function stopRecording() {
  if (!state.recording) return;
  clearInterval(recTimer);
  sfx.muted = false;
  sfx.play('recordStop');
  state.recording = false;
  dom.shutter.classList.remove('recording');
  dom.recHud.hidden = true;
  dom.shutter.disabled = true;

  try {
    const thumb = await grabClipThumb();
    const { blob, mimeType, duration } = await recorder.stop();
    if (!blob.size) { toast('Nothing was recorded.', 'bad'); return; }

    const record = {
      id: uid(),
      blob,
      thumb,
      mimeType,
      duration,
      look: currentLook()?.name || 'Neutral',
      width: dom.preview.width,
      height: dom.preview.height,
      createdAt: Date.now(),
    };
    await db.saveClip(record);
    await refreshGallery();
    haptic(10);
    sfx.play('success');
    toast(`Clip saved · ${formatDuration(duration)}`, 'gold');
  } catch (err) {
    sfx.play('error');
    toast(err.message || 'Recording failed.', 'bad');
  } finally {
    dom.shutter.disabled = false;
    syncModeUI();
  }
}

/* ────────────────────────────────────────────────────────────
   Camera lifecycle + gestures
   ──────────────────────────────────────────────────────────── */

async function startCamera() {
  try {
    dom.gateSub.textContent = 'Starting camera…';
    await camera.start(camera.facing, state.settings.quality);
    state.running = true;
    dom.gate.hidden = true;
    syncZoomRail();
    syncTorchChip();
    toast(`${camera.size[0]}×${camera.size[1]} · ${camera.isFront ? 'Front' : 'Rear'} camera`, '', 1800);
  } catch (err) {
    state.running = false;
    dom.gate.hidden = false;
    dom.gateSub.textContent = cameraErrorMessage(err);
    toast(cameraErrorMessage(err), 'bad', 4200);
  }
}

async function restartCamera() {
  if (!state.running) return;
  try { await camera.start(camera.facing, state.settings.quality); }
  catch (err) { toast(cameraErrorMessage(err), 'bad'); }
}

async function flipCamera() {
  if (!state.running) return;
  state.busy = true;
  try {
    await camera.flip(state.settings.quality);
    state.zoom = 1;
    syncZoomRail();
    syncTorchChip();
  } catch (err) {
    toast(cameraErrorMessage(err), 'bad');
  } finally { state.busy = false; }
}

function setRatio(index) {
  state.ratioIndex = index;
  prefs.set('ratio', ratio().id);
  el('ratioLabel').textContent = ratio().label;
  dom.frame.dataset.ratio = ratio().id;
  dom.frame.classList.remove('ratio-change');
  void dom.frame.offsetWidth;
  dom.frame.classList.add('ratio-change');
  syncFrameBox();
  drawPreview();
}

function syncZoomRail() {
  for (const b of dom.zoomRail.children) {
    b.classList.toggle('on', Math.abs(Number(b.dataset.zoom) - state.zoom) < 0.05);
  }
}

function syncTorchChip() {
  const chip = el('btnTorch');
  chip.style.display = camera.hasTorch ? '' : 'none';
  chip.classList.toggle('on', state.torch);
}

function wireViewfinderGestures() {
  const frame = dom.frame;
  let pinchStart = 0, zoomStart = 1, holdTimer = 0, moved = false, startPt = null;

  // the top bar, zoom rail and gate sit inside the frame — a tap on those is
  // not a tap on the image
  const isChrome = (target) =>
    !!target?.closest?.('.topbar, .zoomrail, .gate, .rec-hud, .countdown');

  frame.addEventListener('touchstart', (e) => {
    if (isChrome(e.target)) { startPt = null; return; }
    if (e.touches.length === 2) {
      pinchStart = distance(e.touches);
      zoomStart = state.zoom;
    } else if (e.touches.length === 1) {
      moved = false;
      startPt = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      holdTimer = setTimeout(() => { setCompare(true); }, 320);
    }
  }, { passive: true });

  frame.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStart) {
      const z = zoomStart * (distance(e.touches) / pinchStart);
      setZoom(z);
    } else if (startPt) {
      const dx = e.touches[0].clientX - startPt.x, dy = e.touches[0].clientY - startPt.y;
      if (Math.hypot(dx, dy) > 12) { moved = true; clearTimeout(holdTimer); }
    }
  }, { passive: true });

  frame.addEventListener('touchend', (e) => {
    if (isChrome(e.target)) return;
    clearTimeout(holdTimer);
    if (state.compare) { setCompare(false); return; }
    pinchStart = 0;
    if (!moved && startPt && e.changedTouches.length) {
      tapToFocus(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    startPt = null;
  });

  // Desktop: click to focus, press-and-hold to compare
  frame.addEventListener('mousedown', (e) => {
    if (isChrome(e.target)) return;
    holdTimer = setTimeout(() => setCompare(true), 320);
  });
  frame.addEventListener('mouseup', (e) => {
    clearTimeout(holdTimer);
    if (state.compare) { setCompare(false); return; }
    if (isChrome(e.target)) return;
    tapToFocus(e.clientX, e.clientY);
  });
  frame.addEventListener('mouseleave', () => { clearTimeout(holdTimer); setCompare(false); });

  frame.addEventListener('wheel', (e) => {
    if (!state.running) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.06 : 0.94));
  }, { passive: false });
}

function distance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function setZoom(z) {
  state.zoom = Math.min(6, Math.max(1, z));
  sfx.play('zoom', { throttle: 120 });
  syncZoomRail();
  camera.setZoom(state.zoom);   // native when the track supports it, digital otherwise
}

function setCompare(on) {
  if (state.compare === on) return;
  state.compare = on;
  dom.compare.hidden = !on;
  if (on) haptic(8);
}

function tapToFocus(clientX, clientY) {
  if (!state.running) return;
  const box = dom.preview.getBoundingClientRect();
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  dom.focus.hidden = false;
  dom.focus.style.left = (clientX - dom.frame.getBoundingClientRect().left) + 'px';
  dom.focus.style.top = (clientY - dom.frame.getBoundingClientRect().top) + 'px';
  dom.focus.style.animation = 'none';
  void dom.focus.offsetWidth;
  dom.focus.style.animation = '';
  sfx.play('focus');
  clearTimeout(tapToFocus._t);
  tapToFocus._t = setTimeout(() => { dom.focus.hidden = true; }, 1200);
  camera.focusAt(x, y);
  haptic(5);
}

/* ────────────────────────────────────────────────────────────
   Chrome wiring
   ──────────────────────────────────────────────────────────── */

/**
 * Sound is wired once, by delegation: every button, look, card, chip and tab
 * gets a cue without 40 individual listeners. `data-sfx` overrides the default,
 * and `data-sfx="none"` leaves it to the code that knows the outcome (a toggle
 * needs to know which way it went; the shutter fires with the shutter, not the
 * touch).
 */
function wireSound() {
  const onDown = (event) => {
    sfx.unlock();                       // iOS: the first gesture starts audio
    const target = event.target?.closest?.(
      'button, .look, .lut-card, .shot, .plan, .seg, .tab, .chip, .mode, .zoom, [data-sfx]'
    );
    if (!target || target.disabled) return;
    const cue = cueFor(target);
    if (cue && cue !== 'none') sfx.play(cue);
  };
  document.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  // pointer events don't fire for keyboard activation
  document.addEventListener('keydown', () => sfx.unlock(), { passive: true, once: true });

  document.addEventListener('input', (event) => {
    if (event.target?.type === 'range') sfx.play('slider', { throttle: 55 });
  }, { passive: true, capture: true });

  sheets.on('open', () => sfx.play('sheetOpen'));
  sheets.on('close', () => sfx.play('sheetClose'));
}

function wireChrome() {
  el('startCam').addEventListener('click', startCamera);
  el('gateGallery').addEventListener('click', () => sheets.open('gallery'));
  dom.shutter.addEventListener('click', shoot);
  el('btnFlip').addEventListener('click', flipCamera);
  el('btnLibrary').addEventListener('click', () => sheets.open('gallery'));
  dom.btnPro.addEventListener('click', () => (billing.isPro ? sheets.open('settings') : paywall.open()));

  el('btnGrid').addEventListener('click', (e) => {
    state.grid = !state.grid;
    prefs.set('grid', state.grid);
    dom.grid.hidden = !state.grid;
    e.currentTarget.classList.toggle('on', state.grid);
  });

  el('btnTorch').addEventListener('click', async (e) => {
    const ok = await camera.setTorch(!state.torch);
    if (!ok) { toast('Torch is not available on this camera.'); return; }
    state.torch = !state.torch;
    e.currentTarget.classList.toggle('on', state.torch);
  });

  el('btnTimer').addEventListener('click', (e) => {
    state.timerIndex = (state.timerIndex + 1) % TIMERS.length;
    const s = TIMERS[state.timerIndex];
    el('timerLabel').textContent = s ? s + 'S' : 'OFF';
    e.currentTarget.classList.toggle('on', s > 0);
  });

  for (const btn of dom.modeSwitch.children) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }

  el('btnRatio').addEventListener('click', () => {
    // the recorder is bound to the canvas size — don't resize mid-take
    if (state.recording) { toast('Framing is locked while recording.'); return; }
    setRatio((state.ratioIndex + 1) % RATIOS.length);
  });

  for (const b of dom.zoomRail.children) {
    b.addEventListener('click', () => setZoom(Number(b.dataset.zoom)));
  }

  dom.strength.addEventListener('input', () => {
    state.mix = Number(dom.strength.value) / 100;
    dom.strengthVal.textContent = dom.strength.value;
    dom.strength.style.setProperty('--fill', dom.strength.value + '%');
    prefs.set('mix', state.mix);
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const name = tab.dataset.sheet;
      if (name === 'gallery') refreshGallery();
      if (name === 'settings') buildSettings();
      if (name === 'adjust') buildAdjust();
      if (name === 'luts') buildLutGrid();
      sheets.toggle(name);
    });
  }

  for (const seg of el('lutFilter').children) {
    seg.addEventListener('click', () => {
      lutFilter = seg.dataset.filter;
      for (const s of el('lutFilter').children) s.classList.toggle('on', s === seg);
      buildLutGrid();
    });
  }

  el('btnResetAdjust').addEventListener('click', resetAdjust);

  // a horizontally scrolled filmstrip reveals looks that were never drawn
  dom.filmstrip.addEventListener('scroll', () => {
    clearTimeout(dom.filmstrip._t);
    dom.filmstrip._t = setTimeout(refreshThumbs, 140);
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); shoot(); }
    if (e.key === 'f') flipCamera();
    if (e.key === 'g') el('btnGrid').click();
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const i = looks.findIndex((l) => l.id === state.lookId);
      const next = looks[(i + (e.key === 'ArrowRight' ? 1 : looks.length - 1)) % looks.length];
      selectLook(next.id);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.recording) stopRecording();
      camera.stop();
      recorder.releaseMic();
      state.running = false;
    }
    else if (!state.running && prefs.get('cameraStarted', false)) startCamera();
  });

  window.addEventListener('resize', syncFrameBox);
  window.addEventListener('orientationchange', () => setTimeout(syncFrameBox, 250));
}

function syncProChip() {
  const pro = billing.isPro;
  dom.btnPro.classList.toggle('active', pro);
  dom.proLabel.textContent = pro ? (billing.entitlement?.trial ? 'TRIAL' : 'PRO') : 'PRO';
  if (!pro && state.mode === 'video') state.mode = 'photo';
  syncModeUI();
}

/* ────────────────────────────────────────────────────────────
   Boot
   ──────────────────────────────────────────────────────────── */

async function boot() {
  try {
    preview = new Renderer(dom.preview);
    thumbs = new Renderer(document.createElement('canvas'));
  } catch (err) {
    dom.gateSub.textContent = 'This browser cannot run the LUMA colour engine (WebGL2 required). Try Safari 15+ or Chrome.';
    el('startCam').disabled = true;
    console.error(err);
    return;
  }

  await billing.init();
  billing.addEventListener('change', () => {
    syncProChip();
    rebuildLookUI();
    buildAdjust();
    if (sheets.openName === 'settings') buildSettings();
  });
  syncProChip();

  await loadLooks();
  applyAdjust();

  dom.grid.hidden = !state.grid;
  el('btnGrid').classList.toggle('on', state.grid);
  el('ratioLabel').textContent = ratio().label;
  dom.frame.dataset.ratio = ratio().id;
  dom.strength.value = Math.round(state.mix * 100);
  dom.strengthVal.textContent = dom.strength.value;
  dom.strength.style.setProperty('--fill', dom.strength.value + '%');
  dom.lutName.textContent = currentLook()?.name || 'Neutral';

  buildFilmstrip();
  buildAdjust();
  syncModeUI();
  sfx.enabled = state.settings.sound;
  wireSound();
  wireChrome();
  wireImport();
  wireViewer();
  wireViewfinderGestures();
  await refreshGallery();

  paywall.onUnlock = ({ restored = false } = {}) => {
    syncProChip();
    rebuildLookUI();
    buildAdjust();
    sfx.play('purchase');
    haptic([12, 40, 12, 40, 24]);
    celebrate({ title: restored ? 'PRO RESTORED' : 'LUMA PRO' });
  };

  await ensureUploaded(preview, state.lookId, PREVIEW_LUT_SIZE).catch(() => {});
  syncFrameBox();
  rafId = requestAnimationFrame(loop);

  // Auto-start when permission was already granted in a previous session.
  try {
    const st = await navigator.permissions?.query?.({ name: 'camera' });
    if (st?.state === 'granted') startCamera();
  } catch { /* Safari has no camera permission query */ }

  el('startCam').addEventListener('click', () => prefs.set('cameraStarted', true), { once: true });

  // Test/debug hook — opt-in via ?debug so it never ships enabled by default.
  if (new URLSearchParams(location.search).has('debug')) {
    window.__luma = { state, camera, preview, thumbs, looks, billing, sheets, paywall,
                      pricing, recorder, refreshThumbs, sfx, celebrate,
                      shoot, startRecording, stopRecording, setMode, setRatio };
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
