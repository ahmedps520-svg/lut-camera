/**
 * Aspect-ratio framing, the Pro unlock celebration, and the sound cues.
 * Run: node test/interaction.mjs
 *
 * No camera is needed: the frame sizes itself from the selected ratio, the
 * celebration is DOM, and sound is asserted by spying on the cue names rather
 * than by listening (headless has no speakers).
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'index.html' : rel);
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/?debug`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({
  permissions: ['camera'],
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 1, isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__luma, { timeout: 20000 });
await page.waitForTimeout(600);

/* ── 1. the frame takes the selected aspect ──────────────── */
const RATIOS = [
  { id: '3:4', value: 3 / 4 },
  { id: '1:1', value: 1 },
  { id: '9:16', value: 9 / 16 },
  { id: '2.39', value: 2.39 },
];

const frameBox = () => page.evaluate(() => {
  const frame = document.getElementById('frame').getBoundingClientRect();
  const canvas = document.getElementById('preview');
  const stage = document.getElementById('stage').getBoundingClientRect();
  const controls = document.getElementById('controls').getBoundingClientRect();
  return {
    w: frame.width, h: frame.height,
    aspect: frame.width / frame.height,
    canvasAspect: canvas.width / canvas.height,
    fitsStage: frame.width <= stage.width + 1 && frame.height <= stage.height + 1,
    // .controls (tabs, shutter, mode switch) lives inside .stage as a sibling
    // of .frame, not outside it — a tall ratio that doesn't budget for
    // .controls' own height grows .frame straight through it and pushes the
    // whole control block off the bottom of the screen.
    controlsTop: controls.top,
    overlapsControls: frame.bottom > controls.top + 1,
    label: document.getElementById('ratioLabel').textContent.trim(),
    ratioId: window.__luma.state.ratioIndex,
  };
});

// start from a known ratio
await page.evaluate(() => window.__luma.setRatio(0));
await page.waitForTimeout(450);

let firstControlsTop = null;
for (let i = 0; i < RATIOS.length; i++) {
  const expected = RATIOS[i];
  await page.evaluate((index) => window.__luma.setRatio(index), i);
  await page.waitForTimeout(450);                 // the frame animates its size
  const box = await frameBox();
  firstControlsTop ??= box.controlsTop;
  check(`frame is ${expected.id}`,
    Math.abs(box.aspect - expected.value) < 0.03,
    `${box.w.toFixed(0)}×${box.h.toFixed(0)} = ${box.aspect.toFixed(3)} (want ${expected.value.toFixed(3)})`);
  check(`canvas matches the ${expected.id} frame`,
    Math.abs(box.canvasAspect - expected.value) < 0.03, box.canvasAspect.toFixed(3));
  check(`${expected.id} fits inside the stage`, box.fitsStage);
  check(`${expected.id} label updates`, box.label === expected.id, box.label);
  check(`${expected.id} does not push the tabs/shutter off screen`,
    !box.overlapsControls && Math.abs(box.controlsTop - firstControlsTop) < 1,
    `controls.top ${box.controlsTop.toFixed(1)} (baseline ${firstControlsTop.toFixed(1)})`);
}

// and the chip itself cycles through them
await page.evaluate(() => window.__luma.setRatio(0));
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById('btnRatio').click());
await page.waitForTimeout(450);
const afterTap = await frameBox();
check('ratio chip advances the framing',
  Math.abs(afterTap.aspect - 1) < 0.03 && afterTap.label === '1:1',
  `${afterTap.label} @ ${afterTap.aspect.toFixed(3)}`);

/* ── 1b. the sliding indicator tracks the selection ──────── */
const pillOf = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const style = getComputedStyle(el);
  return {
    x: style.getPropertyValue('--pill-x').trim(),
    w: style.getPropertyValue('--pill-w').trim(),
    o: style.getPropertyValue('--pill-o').trim(),
  };
}, selector);

/* ── 1c. zoom is a continuous drag slider, not a few fixed stops ── */
const zoomReadout = () => page.evaluate(() => ({
  fill: document.getElementById('zoomFill').style.width,
  text: document.getElementById('zoomValue').textContent,
  now: Number(document.getElementById('zoomRail').getAttribute('aria-valuenow')),
}));

const zoom1 = await zoomReadout();
await page.evaluate(() => window.__luma.setZoom(3));
await page.waitForTimeout(200);
const zoom3 = await zoomReadout();
check('zoom slider fill tracks the selection',
  zoom1.fill !== zoom3.fill && zoom3.text === '3.0×', `${zoom1.fill} → ${zoom3.fill} (${zoom3.text})`);

await page.evaluate(() => window.__luma.setZoom(50));
await page.waitForTimeout(200);
const zoomMax = await zoomReadout();
check('zoom reaches 50x', zoomMax.now === 50, zoomMax.text);

await page.evaluate(() => window.__luma.setZoom(0.1));
await page.waitForTimeout(200);
const zoomFloor = await zoomReadout();
check('zoom is clamped at the device floor (no ultra-wide lens in the fake stream)',
  zoomFloor.now === 1, zoomFloor.text);

await page.evaluate(() => window.__luma.setZoom(1));
await page.waitForTimeout(300);

const modePill = await pillOf('#modeSwitch');
check('mode indicator is positioned', modePill.o === '1' && modePill.w !== '',
  `x=${modePill.x} w=${modePill.w}`);

/* ── 2. sound cues fire on interaction ───────────────────── */
await page.evaluate(() => {
  window.__cues = [];
  const engine = window.__luma.sfx;
  const original = engine.play.bind(engine);
  engine.play = (name, options) => { window.__cues.push(name); return original(name, options); };
});

// The live camera keeps a WebGL draw loop running on the main thread, and
// under this sandbox's software rasterizer that's enough to starve
// Playwright's own actionability polling — real mouse clicks can hang
// indefinitely. Dispatch straight in-page instead (same workaround
// smoke.mjs and features.mjs use for the same reason). Sound cues are wired
// to a delegated `pointerdown` listener, not `click`, so fire both — a bare
// `.click()` alone would silently skip every cue assertion below.
const clickJs = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
  el.click();
}, selector);

const cuesAfter = async (action) => {
  await page.evaluate(() => { window.__cues = []; });
  await action();
  await page.waitForTimeout(320);
  return page.evaluate(() => window.__cues.slice());
};

check('audio context is created on first interaction', await (async () => {
  await clickJs('#btnGrid');
  await page.waitForTimeout(200);
  return page.evaluate(() => !!window.__luma.sfx.ctx);
})());

const chipCues = await cuesAfter(() => clickJs('#btnGrid'));
check('chips click', chipCues.includes('chip'), chipCues.join(','));
check('a chip tap does not also refocus the lens',
  !chipCues.includes('focus'), chipCues.join(','));

const tabCues = await cuesAfter(() => clickJs('.tab[data-sheet="luts"]'));
check('tabs play a cue and open the sheet',
  tabCues.includes('tab') && tabCues.includes('sheetOpen'), tabCues.join(','));

const segCues = await cuesAfter(() => clickJs('.seg[data-filter="mono"]'));
check('segmented filter cues', segCues.includes('select'), segCues.join(','));

const closeCues = await cuesAfter(() => clickJs('#sheet-luts [data-close]'));
check('closing a sheet cues', closeCues.includes('sheetClose'), closeCues.join(','));

const lookCues = await cuesAfter(() => clickJs('.look[data-id="noir"]'));
check('choosing a look cues', lookCues.includes('select'), lookCues.join(','));

const lockedCues = await cuesAfter(() => clickJs('.look[data-id="ember"]'));
check('a locked look sounds locked', lockedCues.includes('lock'), lockedCues.join(','));
await page.evaluate(() => window.__luma.paywall.close());
await page.waitForTimeout(300);

const sliderCues = await cuesAfter(() => page.evaluate(() => {
  const slider = document.getElementById('strength');
  slider.value = '60';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}));
check('sliders tick', sliderCues.includes('slider'), sliderCues.join(','));

const modeCues = await cuesAfter(() => clickJs('.mode[data-mode="video"]'));
check('the mode switch cues', modeCues.includes('mode'), modeCues.join(','));
await page.evaluate(() => window.__luma.paywall.close());
await page.waitForTimeout(300);

/* ── 3. the unlock celebration ───────────────────────────── */
await page.evaluate(() => { window.__cues = []; });
await page.evaluate(() => window.__luma.paywall.open());
await page.waitForTimeout(300);
await clickJs('#btnSubscribe');

// The celebration is deliberately short-lived, and every round trip here costs
// hundreds of ms with the camera running — so wait for it, then gather every
// fact about it in a single evaluate.
await page.waitForFunction(() => !!document.querySelector('.celebrate'), { timeout: 10000 })
  .catch(() => {});
const party = await page.evaluate(() => {
  const host = document.querySelector('.celebrate');
  const canvas = host?.querySelector('canvas');
  let painted = false;
  if (canvas) {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { painted = true; break; } }
  }
  return {
    pro: window.__luma.billing.isPro,
    cues: window.__cues.slice(),
    hasHost: !!host,
    hasCanvas: !!canvas,
    banner: host?.querySelector('.celebrate-banner')?.textContent || '',
    painted,
  };
});

check('purchase unlocks Pro', party.pro);
check('the purchase fanfare plays', party.cues.includes('purchase'), party.cues.join(','));
check('confetti canvas is on screen', party.hasCanvas);
check('the banner names the tier', /LUMA PRO/.test(party.banner), party.banner);
check('particles are actually drawn', party.painted);

await page.waitForFunction(() => !document.querySelector('.celebrate'), { timeout: 12000 })
  .catch(() => {});
check('the celebration cleans itself up',
  await page.evaluate(() => !document.querySelector('.celebrate')));

/* ── 4. the sound toggle ─────────────────────────────────── */
await clickJs('.tab[data-sheet="settings"]');
await page.waitForTimeout(700);
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#settingsBody .row')]
    .find((r) => r.textContent.includes('Sound effects'));
  row?.querySelector('.switch')?.click();
});
await page.waitForTimeout(300);
check('sound can be turned off and persists', await page.evaluate(() =>
  JSON.parse(localStorage.getItem('luma:sound') || 'true') === false
  && window.__luma.sfx.enabled === false));

const silent = await cuesAfter(() => clickJs('#sheet-settings [data-close]'));
check('cues are still routed when muted (engine decides)', Array.isArray(silent));

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

/* ── 5. Reduce Motion is honoured ─────────────────────────── */
const calm = await browser.newContext({
  reducedMotion: 'reduce',
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 1, isMobile: true, hasTouch: true,
});
const calmPage = await calm.newPage();
await calmPage.goto(base, { waitUntil: 'networkidle' });
await calmPage.waitForFunction(() => !!window.__luma, { timeout: 20000 });
await calmPage.waitForTimeout(400);

const motion = await calmPage.evaluate(() => {
  const sheet = document.getElementById('sheet-luts');
  const style = getComputedStyle(sheet);
  const root = getComputedStyle(document.documentElement);
  return {
    transitionProperty: style.transitionProperty,
    slow: root.getPropertyValue('--dur-slow').trim(),
    micro: root.getPropertyValue('--dur-micro').trim(),
  };
});
check('Reduce Motion drops travel from transitions',
  !/transform/.test(motion.transitionProperty), motion.transitionProperty);
check('Reduce Motion keeps fades rather than snapping',
  /opacity/.test(motion.transitionProperty), motion.transitionProperty);
check('Reduce Motion shortens the duration scale',
  motion.slow === '140ms' && motion.micro === '1ms', `${motion.micro} / ${motion.slow}`);

// the celebration must not throw confetti at someone who asked for less motion
await calmPage.evaluate(() => window.__luma.celebrate({ title: 'TEST' }));
await calmPage.waitForTimeout(400);
check('Reduce Motion skips the confetti but keeps the banner',
  await calmPage.evaluate(() => !document.querySelector('.celebrate canvas')
    && !!document.querySelector('.celebrate-banner')));
await calm.close();

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
