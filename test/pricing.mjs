/**
 * Unit tests for regional pricing. Run: node test/pricing.mjs
 * Node 22 ships full ICU, so Intl formats every currency the app maps.
 */
import { pricing, detectRegion, currencyForRegion } from '../src/pricing.js';
import { PLANS, priceOf, subtitleOf } from '../src/billing.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
};

/* ── region parsing ─────────────────────────────────────── */
check('region from locale', detectRegion('de-DE') === 'DE' && detectRegion('pt-BR') === 'BR');
check('region from script-tagged locale', detectRegion('zh-Hant-TW') === 'TW');
check('no region subtag is null', detectRegion('en') === null);

/* ── currency mapping ───────────────────────────────────── */
const expected = {
  US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', IE: 'EUR',
  JP: 'JPY', IN: 'INR', BR: 'BRL', ZA: 'ZAR', AE: 'AED',
  CA: 'CAD', AU: 'AUD', SE: 'SEK', CH: 'CHF', NG: 'NGN', PK: 'PKR',
};
for (const [region, currency] of Object.entries(expected)) {
  check(`${region} → ${currency}`, currencyForRegion(region) === currency, currencyForRegion(region));
}
check('unknown region falls back to USD', currencyForRegion('ZZ') === 'USD');
check('missing region falls back to USD', currencyForRegion(null) === 'USD');

/* ── formatting ─────────────────────────────────────────── */
const symbolCases = [
  ['USD', 'en-US', '$'],
  ['EUR', 'de-DE', '€'],
  ['GBP', 'en-GB', '£'],
  ['JPY', 'ja-JP', '￥'],
  ['INR', 'en-IN', '₹'],
];
for (const [currency, locale, symbol] of symbolCases) {
  pricing.locale = locale;
  pricing.setCurrency(currency);
  const price = pricing.price('monthly');
  const hasSymbol = price.includes(symbol) || price.includes(currency);
  check(`${currency} formats with its own symbol`, hasSymbol, price);
}

/* ── price points ───────────────────────────────────────── */
pricing.locale = 'en-US';
for (const currency of ['USD', 'EUR', 'JPY', 'INR', 'BRL', 'NGN', 'TRY', 'VND']) {
  pricing.setCurrency(currency);
  const monthly = pricing.amount('monthly');
  const annual = pricing.amount('annual');
  const lifetime = pricing.amount('lifetime');
  check(`${currency} price points ascend`,
    Number.isFinite(monthly) && monthly > 0 && annual > monthly && lifetime > annual,
    `${monthly} / ${annual} / ${lifetime}`);
  const savings = pricing.savingsPercent();
  check(`${currency} annual saves 40–60%`, savings >= 40 && savings <= 60, `${savings}%`);
}

/* ── zero-decimal currencies stay whole ─────────────────── */
pricing.locale = 'ja-JP';
pricing.setCurrency('JPY');
check('JPY renders without decimals', !/\.\d/.test(pricing.price('annual')), pricing.price('annual'));

/* ── plans read through the pricing module ──────────────── */
pricing.locale = 'de-DE';
pricing.setCurrency('EUR');
const labels = PLANS.map((p) => `${p.id}=${priceOf(p)}`).join(' ');
check('every plan prices in the active currency',
  PLANS.every((p) => priceOf(p).includes('€')), labels);
check('annual subtitle shows the per-month equivalent',
  /€/.test(subtitleOf(PLANS.find((p) => p.id === 'annual'))),
  subtitleOf(PLANS.find((p) => p.id === 'annual')));
check('no hardcoded dollar prices leak through',
  PLANS.every((p) => !priceOf(p).includes('$')));

console.log(`\n${failed === 0 ? 'all checks passed' : failed + ' failed'}`);
process.exit(failed ? 1 : 0);
