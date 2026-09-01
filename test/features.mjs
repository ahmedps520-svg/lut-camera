/**
 * Regional pricing in the rendered paywall + LUMA Motion (video).
 * Run: node test/features.mjs
 *
 * Uses evaluate-driven clicks for the same reason as smoke.mjs: the software
 * rasterizer here blocks the main thread inside GL calls, which starves
 * Playwright's actionability polling.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

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
         '--enable-unsafe-swiftshader'],
});

const PRO = JSON.stringify({
  plan: 'annual', productId: 'app.luma.pro.annual',
  since: Date.now(), expires: Date.now() + 30 * 864e5, trial: false, source: 'test',
});

async function openPage({ locale, pro = false }) {
  const ctx = await browser.newContext({
    locale,
    permissions: ['camera', 'microphone'],
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 1,
    isMobile: true, hasTouch: true,
  });
  if (pro) {
    await ctx.addInitScript((value) => {
      try { localStorage.setItem('luma:entitlement', value); } catch { /* private mode */ }
    }, PRO);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__luma, { timeout: 20000 });
  return { ctx, page, errors };
}

const clickJs = async (page, selector, ms = 500) => {
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
  await page.waitForTimeout(ms);
};

/* ── 1. the paywall prices in the visitor's currency ─────── */
for (const [locale, currency, symbol] of [
  ['de-DE', 'EUR', '€'],
  ['ja-JP', 'JPY', '¥￥'],
  ['en-IN', 'INR', '₹'],
  ['en-US', 'USD', '$'],
]) {
  const { ctx, page } = await openPage({ locale });
  await page.evaluate(() => window.__luma.paywall.open());
  await page.waitForTimeout(400);

  const shown = await page.evaluate(() => ({
    currency: window.__luma.pricing.currency,
    region: window.__luma.pricing.region,
    prices: [...document.querySelectorAll('.plan-price .p')].map((e) => e.textContent.trim()),
    annualSub: document.querySelector('.plan:nth-child(2) .plan-s')?.textContent.trim(),
    cta: document.getElementById('btnSubscribe').textContent.trim(),
  }));

  // some locales use the fullwidth glyph (￥) — accept any of the listed forms
  const hasSymbol = (text) => !!text
    && ([...symbol].some((ch) => text.includes(ch)) || text.includes(currency));
  const symbolOk = shown.prices.length === 3 && shown.prices.every(hasSymbol);
  check(`${locale} → ${currency}`, shown.currency === currency, `${shown.region} → ${shown.currency}`);
  check(`${locale} plan prices use the local symbol`, symbolOk, shown.prices.join('  '));
  check(`${locale} annual subtitle is localised`, hasSymbol(shown.annualSub), shown.annualSub);
  if (locale !== 'en-US') {
    check(`${locale} shows no US dollar prices`, !shown.prices.some((p) => p.startsWith('$')));
  }
  await ctx.close();
}

/* ── 2. video is gated on the free tier ──────────────────── */
{
  const { ctx, page } = await openPage({ locale: 'en-US' });
  check('mode switch is present', await page.locator('#modeSwitch').count() === 1);
  check('photo is the default mode',
    await page.evaluate(() => window.__luma.state.mode === 'photo'));
  check('video shows a lock for free users',
    await page.evaluate(() => !document.getElementById('modeLock').hidden));

  await clickJs(page, '.mode[data-mode="video"]', 700);
  check('tapping VIDEO opens the paywall',
    !(await page.locator('#paywall').isHidden()));
  check('mode stays on photo when locked',
    await page.evaluate(() => window.__luma.state.mode === 'photo'));
  check('paywall lists Motion as a Pro perk',
    (await page.locator('.perks li').allTextContents()).some((t) => /Motion/i.test(t)));
  await ctx.close();
}

/* ── 3. Pro records a real clip off the graded canvas ─────── */
{
  const { ctx, page, errors } = await openPage({ locale: 'en-US', pro: true });
  check('Pro unlocks the video mode lock',
    await page.evaluate(() => document.getElementById('modeLock').hidden));

  if (!(await page.locator('#gate').isHidden())) await clickJs(page, '#startCam', 1500);
  await page.waitForFunction(() => document.getElementById('gate').hidden, { timeout: 20000 });
  await page.waitForTimeout(1200);

  await clickJs(page, '.mode[data-mode="video"]', 500);
  check('switches into video mode',
    await page.evaluate(() => window.__luma.state.mode === 'video'));
  // let the microphone request settle so record starts without waiting on it
  await page.waitForTimeout(3000);

  await clickJs(page, '#shutter', 1200);
  check('recording starts', await page.evaluate(() => window.__luma.state.recording === true));
  check('recording HUD is visible', await page.evaluate(() =>
    !document.getElementById('recHud').hidden));

  await page.waitForTimeout(2600);
  const hudText = await page.evaluate(() => document.getElementById('recTime').textContent);
  check('elapsed timer counts up', /0:0[1-9]/.test(hudText), hudText);

  await clickJs(page, '#shutter', 3000);
  check('recording stops', await page.evaluate(() => window.__luma.state.recording === false));

  const clips = await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('luma');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const all = r.result.transaction('clips').objectStore('clips').getAll();
      all.onsuccess = () => res(all.result.map((c) => ({
        bytes: c.blob.size, type: c.blob.type, duration: c.duration,
        look: c.look, hasThumb: (c.thumb || '').startsWith('data:image'),
      })));
    };
  }));
  check('a clip is stored', clips.length === 1, JSON.stringify(clips[0]));
  // the software rasterizer feeds the canvas at a few fps, so the file is small;
  // what matters is that it is a real, non-empty video container
  check('clip has real video bytes',
    clips[0]?.bytes > 1000 && /^video\//.test(clips[0]?.type || ''),
    `${clips[0]?.bytes} bytes ${clips[0]?.type}`);
  // The nominal gap between the start and stop clicks above is ~7s, but this
  // sandbox's software-rendered Chromium under real scheduling load has shown
  // 2x+ variance on wall-clock waits (observed 6.9s–16.6s for the same nominal
  // window) — so this only guards against a duration that's wrong in kind
  // (near-zero, or absurdly long from a broken clock), not a tight window.
  check('clip duration matches the take', clips[0]?.duration > 1.5 && clips[0]?.duration < 45,
    `${clips[0]?.duration?.toFixed(2)}s`);
  check('clip carries a poster frame', clips[0]?.hasThumb === true);
  check('clip records the look', clips[0]?.look === 'Neutral', clips[0]?.look);

  await page.evaluate(() => { window.__luma.camera.stop(); window.__luma.state.running = false; });
  await clickJs(page, '.tab[data-sheet="gallery"]', 900);
  check('library lists the clip', await page.locator('.shot .play').count() === 1);
  const durBadge = await page.evaluate(() =>
    document.querySelector('.shot .dur')?.textContent || '');
  check('library shows a duration badge', /\d:\d\d/.test(durBadge), durBadge);

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
