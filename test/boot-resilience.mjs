/**
 * The exact bug reported: "camera isn't working, isn't asking for permission,
 * it just says LUMA" — meaning the gate showed but tapping "Enable Camera"
 * did nothing. Root cause was `#private` class fields/methods, which throw a
 * SyntaxError at *parse* time on any engine that doesn't support them (Safari
 * < 15, or an older WebKit embedded in an in-app browser) — the whole module
 * graph fails silently, so zero JS runs and the button is never wired.
 *
 * This suite guards two things: (1) the private-syntax dependency is gone for
 * good, and (2) even if something else throws during boot, the camera button
 * still works — boot() no longer lets a secondary failure take down the one
 * button that matters most.
 *
 * Run: node test/boot-resilience.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
};

/* ── 1. static sweep: no private class fields/methods anywhere in src/ ──── */
function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out = out.concat(walk(path));
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}
const PRIVATE_SYNTAX = /(^|[^'"`_.\w])#[a-zA-Z_][a-zA-Z0-9_]*\s*[(=]/m;
let offenders = [];
for (const file of walk(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  if (PRIVATE_SYNTAX.test(text)) offenders.push(file.replace(ROOT, ''));
}
check('no ES private class fields/methods in src/ (Safari < 15 cannot parse them)',
  offenders.length === 0, offenders.join(', '));

/* ── serve the app ────────────────────────────────────────────────────── */
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
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--enable-unsafe-swiftshader'],
});

/* ── 2. the exact reported symptom: does tapping the button do anything? ── */
{
  const ctx = await browser.newContext({
    permissions: [],   // camera permission NOT pre-granted — matches a fresh visit
    viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.look').length > 0, { timeout: 15000 });

  const before = await page.evaluate(() => document.getElementById('gateSub').textContent);
  await page.evaluate(() => document.getElementById('startCam').click());
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => document.getElementById('gateSub').textContent);

  check('tapping "Enable Camera" changes gate state (not a dead button)', before !== after,
    `"${before}" → "${after}"`);
  check('the click actually reached getUserMedia (fake stream granted, gate dismissed)',
    await page.evaluate(() => document.getElementById('gate').hidden));
  check('no uncaught page errors on a fresh visit', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ── 3. the button still works even if a secondary feature is broken ────── */
{
  const ctx = await browser.newContext({
    permissions: [],   // no pre-granted permission, so the gate stays up until tapped
    viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();

  // Sabotage something unrelated to the camera *before* the app boots, the
  // way a real-world failure would (storage denied, a corrupt local look).
  await page.addInitScript(() => {
    const realOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw new Error('simulated storage failure'); };
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const gateVisible = await page.evaluate(() => !document.getElementById('gate').hidden);
  check('gate still renders when storage is broken', gateVisible);

  await page.evaluate(() => document.getElementById('startCam').click());
  await page.waitForTimeout(1500);
  check('camera button still works when an unrelated feature (storage) throws',
    await page.evaluate(() => document.getElementById('gate').hidden));
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
