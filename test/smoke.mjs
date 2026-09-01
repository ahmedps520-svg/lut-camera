/**
 * End-to-end smoke test — drives the real app in Chromium against a synthetic
 * camera feed.  Run:  node test/smoke.mjs
 *
 * Note on interaction: this environment renders WebGL through a software
 * rasterizer at a few frames per second, and Playwright's actionability checks
 * (which wait on compositor frames for fixed, transform-animated overlays) time
 * out unpredictably there. `tap()` therefore tries a real mouse click first and
 * falls back to dispatching the click on the element — every handler in the app
 * is a plain `click` listener, so the fallback drives the same code path.
 * Hit-testing and obstruction are asserted explicitly instead (§11).
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.cube': 'text/plain',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'index.html' : rel);
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--enable-unsafe-swiftshader',
  ],
});
const ctx = await browser.newContext({
  permissions: ['camera'],
  viewport: { width: 402, height: 874 },   // iPhone 16 Pro logical size
  deviceScaleFactor: 1,                    // software rasterizer: keep it cheap
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('crash', () => errors.push('RENDERER CRASHED'));

ctx.setDefaultTimeout(15000);

/**
 * Under the software rasterizer every frame blocks the main thread inside
 * synchronous GL calls, which starves Playwright's injected queries. The
 * streaming pipeline is asserted on its own (§2, §3, §5, §7); the pure-UI
 * phases run with the stream paused so the harness can actually drive them.
 */
const pauseCamera = () => page.evaluate(() => {
  window.__luma.camera.stop();
  window.__luma.state.running = false;
});
const resumeCamera = async () => {
  await page.evaluate(async () => {
    await window.__luma.camera.start(window.__luma.camera.facing, 'max');
    window.__luma.state.running = true;
  });
  await page.waitForTimeout(1200);
};

/** Click without locator polling — for the phases where the stream is live. */
const clickJs = async (selector) => {
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
  await page.waitForTimeout(600);
};

const tap = async (selector) => {
  const loc = page.locator(selector).first();
  try {
    await loc.click({ force: true, timeout: 4000 });
  } catch {
    await loc.evaluate((el) => el.click());
  }
  await page.waitForTimeout(450);
};

const idb = (store, map) => page.evaluate(({ store, map }) => new Promise((res, rej) => {
  const r = indexedDB.open('luma');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const all = r.result.transaction(store).objectStore(store).getAll();
    all.onsuccess = () => res(all.result.map(new Function('s', `return (${map})(s)`)));
  };
}), { store, map: map.toString() });

const sampleCentre = () => page.evaluate(() => {
  const c = document.getElementById('preview');
  const gl = c.getContext('webgl2');
  const px = new Uint8Array(4);
  gl.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [...px];
});

await page.goto(base + '?debug', { waitUntil: 'networkidle' });

/* ── 1. boot ─────────────────────────────────────────────── */
await page.waitForFunction(() => document.querySelectorAll('.look').length > 0, { timeout: 20000 });
const lookCount = await page.locator('.look').count();
check('filmstrip renders every look', lookCount === 33, `${lookCount} looks`);
check('WebGL2 colour engine started', !(await page.locator('#startCam').isDisabled()));

/* ── 2. camera ───────────────────────────────────────────── */
if (!(await page.locator('#gate').isHidden())) await tap('#startCam');
await page.waitForFunction(() => document.getElementById('gate').hidden, { timeout: 20000 });
check('camera starts and the gate dismisses', true);
await page.waitForTimeout(1500);

check('viewfinder renders live frames', await page.evaluate(() => {
  const c = document.getElementById('preview');
  const gl = c.getContext('webgl2');
  const px = new Uint8Array(4 * 64);
  gl.readPixels(Math.floor(c.width / 2) - 8, Math.floor(c.height / 2) - 8, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [...px].some((v) => v > 12);
}));

/* ── 3. looks apply live ─────────────────────────────────── */
const colour = await sampleCentre();
await tap('.look[data-id="noir"]');
await page.waitForTimeout(500);
const mono = await sampleCentre();
check('free look applies live (Noir → monochrome)',
  Math.abs(mono[0] - mono[1]) < 14 && Math.abs(mono[1] - mono[2]) < 14, `${colour} → ${mono}`);

check('filmstrip thumbnails render from the live frame', await page.evaluate(() => {
  const c = document.querySelector('.look canvas');
  return !!c && c.width > 0 && c.getContext('2d').getImageData(60, 60, 1, 1).data.some((v) => v > 8);
}));

/* Live previews re-render every on-screen thumbnail on a timer. Negligible on a
   phone GPU; under this software rasterizer it dominates the frame budget, so
   switch it off through the real settings toggle before the longer flows. */
await pauseCamera();
await tap('.tab[data-sheet="settings"]');
await page.locator('#settingsBody .row', { hasText: 'Live look previews' })
  .locator('.switch').evaluate((el) => el.click());
await page.waitForTimeout(400);
check('live-preview setting toggles and persists', await page.evaluate(() =>
  JSON.parse(localStorage.getItem('luma:settings') || '{}').liveThumbs === false));
check('settings sheet builds its rows', (await page.locator('#settingsBody .row').count()) >= 5);
await tap('#sheet-settings [data-close]');

/* ── 4. paywall gates a Pro look ─────────────────────────── */
await tap('.look[data-id="cinestill"]');
check('locked look opens the paywall', !(await page.locator('#paywall').isHidden()));
check('locked look is not applied', await page.evaluate(() => window.__luma.state.lookId !== 'cinestill'));
await tap('#paywallClose');

/* ── 5. capture ──────────────────────────────────────────── */
await tap('.look[data-id="portra"]');
await resumeCamera();
await clickJs('#shutter');
await page.waitForTimeout(2500);
await pauseCamera();
const shots = await idb('shots', (s) => ({ w: s.width, h: s.height, look: s.look, bytes: s.blob.size }));
check('capture writes a photo to the library', shots.length === 1, JSON.stringify(shots[0]));
check('capture records the look', shots[0]?.look === 'Portra');
check('free capture is capped at 1600px', Math.max(shots[0].w, shots[0].h) <= 1600, `${shots[0].w}×${shots[0].h}`);
check('capture honours the 3:4 frame', Math.abs(shots[0].w / shots[0].h - 3 / 4) < 0.02);

await tap('.tab[data-sheet="gallery"]');
check('library shows the capture', (await page.locator('.shot').count()) === 1);
await tap('#sheet-gallery [data-close]');

/* ── 6. LUT import ───────────────────────────────────────── */
const cube = ['TITLE "Test Invert"', 'LUT_3D_SIZE 2', ''];
for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
  cube.push(`${1 - r} ${1 - g} ${1 - b}`);
}
await tap('.tab[data-sheet="luts"]');
await page.setInputFiles('#fileInput', {
  name: 'Test Invert.cube', mimeType: 'text/plain', buffer: Buffer.from(cube.join('\n')),
});
await page.waitForTimeout(1500);
const customs = await idb('luts', (l) => ({ name: l.name, size: l.size }));
check('imported .cube is stored', customs.length === 1, JSON.stringify(customs[0]));
check('imported LUT is selected', await page.evaluate(() => window.__luma.state.lookId.startsWith('user_')));
await tap('#sheet-luts [data-close]');
const inverted = await sampleCentre();
check('imported LUT grades the viewfinder',
  inverted.slice(0, 3).join() !== mono.slice(0, 3).join(), `${inverted}`);

await tap('.tab[data-sheet="luts"]');
await page.setInputFiles('#fileInput', {
  name: 'Second.cube', mimeType: 'text/plain', buffer: Buffer.from(cube.join('\n')),
});
await page.waitForTimeout(1200);
check('free tier caps imports at one', !(await page.locator('#paywall').isHidden()));

/* ── 7. purchase unlocks everything ──────────────────────── */
await tap('.plan:nth-child(2)');
await tap('#btnSubscribe');
await page.waitForTimeout(2200);
const ent = await page.evaluate(() => JSON.parse(localStorage.getItem('luma:entitlement') || 'null'));
check('purchase writes an entitlement', ent && ent.plan === 'annual' && ent.trial === true, JSON.stringify(ent));
check('paywall closes after purchase', await page.locator('#paywall').isHidden());
check('Pro chip shows the trial', (await page.locator('#proLabel').textContent()).trim() === 'TRIAL');
check('locks disappear from the filmstrip', (await page.locator('.look .lock').count()) === 0);

await tap('#sheet-luts [data-close]');
await tap('.look[data-id="cinestill"]');
check('Pro look is now selectable', await page.evaluate(() => window.__luma.state.lookId === 'cinestill'));

await resumeCamera();
await clickJs('#shutter');
await page.waitForTimeout(2500);
await pauseCamera();
const longEdges = (await idb('shots', (s) => Math.max(s.width, s.height))).sort((a, b) => b - a);
check('Pro capture uses full resolution', longEdges[0] > 1600, `long edge ${longEdges[0]}px`);

/* ── 8. adjustments ──────────────────────────────────────── */
await tap('.tab[data-sheet="adjust"]');
check('adjust panel builds every control', (await page.locator('#adjustBody .adj').count()) === 10);
await page.locator('#adjustBody .adj[data-key="grain"] input').evaluate((el) => {
  el.value = '0.6';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
check('adjustments reach the renderer and persist', await page.evaluate(() =>
  JSON.parse(localStorage.getItem('luma:adjust')).grain === 0.6 && window.__luma.preview.params.grain === 0.6));
await tap('#btnResetAdjust');
check('reset clears adjustments', await page.evaluate(() => window.__luma.preview.params.grain === 0));
await tap('#sheet-adjust [data-close]');

/* ── 9. framing + zoom ───────────────────────────────────── */
await tap('#btnRatio');
check('aspect ratio cycles', (await page.locator('#ratioLabel').textContent()).trim() === '1:1');
await page.evaluate(() => window.__luma.setZoom(2));
check('zoom rail sets digital zoom', await page.evaluate(() => window.__luma.state.zoom === 2));
check('zoom rail reaches the professional range (50x)', await page.evaluate(() => {
  window.__luma.setZoom(50);
  return window.__luma.state.zoom === 50;
}));
await tap('#btnRatio'); await tap('#btnRatio'); await tap('#btnRatio');
await page.evaluate(() => window.__luma.setZoom(1));

/* ── 10. the render loop pauses behind full-screen surfaces ─ */
await resumeCamera();
const framesOver = async (ms) => {
  const a = await page.evaluate(() => window.__luma.state.frames);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => window.__luma.state.frames)) - a;
};
const liveFrames = await framesOver(1200);
check('viewfinder advances while visible', liveFrames > 0, `${liveFrames} frames`);

await page.evaluate(() => window.__luma.paywall.open());
await page.waitForTimeout(500);
const paywallFrames = await framesOver(1200);
check('paywall pauses the viewfinder', paywallFrames === 0, `${paywallFrames} frames`);
await page.evaluate(() => window.__luma.paywall.close());
await page.waitForTimeout(400);

// once subscribed, the Pro chip is a shortcut into Settings rather than the paywall
await clickJs('#btnPro');
check('Pro chip opens settings when subscribed',
  await page.evaluate(() => window.__luma.sheets.openName === 'settings'
    && document.getElementById('paywall').hidden));
await page.evaluate(() => window.__luma.sheets.close());
await page.waitForTimeout(400);
await pauseCamera();

/* ── 11. overlay chrome is genuinely hit-testable ─────────── */
await tap('.tab[data-sheet="luts"]');
const hit = await page.evaluate(() => {
  const b = document.querySelector('#sheet-luts [data-close]');
  const r = b.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { clear: top === b || b.contains(top), inView: r.top > 0 && r.bottom < innerHeight };
});
check('sheet close button is unobstructed and on screen', hit.clear && hit.inView, JSON.stringify(hit));
// Sheets are modal over the bottom controls: the scrim takes the tap, and
// tapping it dismisses the sheet rather than firing the shutter underneath.
check('sheet is modal over the controls', await page.evaluate(() => {
  const b = document.getElementById('shutter');
  const r = b.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !!top && !b.contains(top);
}));
// tap the exposed part of the scrim, above the sheet
await page.mouse.click(201, 90);
await page.waitForTimeout(600);
check('tapping the scrim closes the sheet',
  await page.evaluate(() => !document.getElementById('sheet-luts').classList.contains('open')));

/* ── 12. no runtime errors ───────────────────────────────── */
check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

/* screenshots for the record — the canvas keeps its last frame once paused,
   and screenshotting while the stream runs starves the harness */
await resumeCamera();
await page.waitForTimeout(1200);
await pauseCamera();
await page.screenshot({ path: 'test/shot-camera.png' });
await tap('.tab[data-sheet="luts"]');
await page.waitForTimeout(600);
await page.screenshot({ path: 'test/shot-looks.png' });
await tap('#sheet-luts [data-close]');
await page.evaluate(() => { localStorage.removeItem('luma:entitlement'); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await pauseCamera().catch(() => {});
await tap('#btnPro');
await page.waitForTimeout(700);
await page.screenshot({ path: 'test/shot-paywall.png' });

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
