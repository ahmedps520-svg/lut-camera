/**
 * Regional pricing.
 *
 * In production the *store* is the source of truth: StoreKit hands back
 * `product.displayPrice` already formatted for the customer's storefront, and
 * Stripe returns the price for the customer's currency. Neither is available in
 * this web build, so the paywall shows the price point we would publish for the
 * detected region, formatted with `Intl.NumberFormat`.
 *
 * These are per-currency price *points* (what you would actually enter in App
 * Store Connect), not a live FX conversion of the USD price — exchange rates
 * move, published prices don't.
 */

/** Region → currency. Anything not listed falls back to USD. */
const REGION_CURRENCY = {
  US: 'USD', UM: 'USD', PR: 'USD', VI: 'USD', GU: 'USD', EC: 'USD', SV: 'USD', PA: 'USD',
  GB: 'GBP', GG: 'GBP', JE: 'GBP', IM: 'GBP',
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR', FR: 'EUR',
  GR: 'EUR', HR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR', MT: 'EUR',
  NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR', MC: 'EUR', AD: 'EUR', SM: 'EUR', VA: 'EUR',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', LI: 'CHF',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', UA: 'UAH',
  JP: 'JPY', CN: 'CNY', HK: 'HKD', TW: 'TWD', KR: 'KRW', SG: 'SGD', MY: 'MYR',
  IN: 'INR', ID: 'IDR', PH: 'PHP', TH: 'THB', VN: 'VND', PK: 'PKR', BD: 'BDT', LK: 'LKR',
  BR: 'BRL', MX: 'MXN', CL: 'CLP', CO: 'COP',
  ZA: 'ZAR', NG: 'NGN', KE: 'KES', EG: 'EGP', GH: 'GHS', TZ: 'TZS',
  AE: 'AED', SA: 'SAR', QA: 'QAR', BH: 'BHD', OM: 'OMR', JO: 'JOD',
  IL: 'ILS', TR: 'TRY', MA: 'MAD', DZ: 'DZD', TN: 'TND',
};

/**
 * Published price points: [monthly, annual, lifetime].
 * Chosen the way App Store tiers are — round in the local currency, not
 * converted — so nothing ever shows as "€4.63".
 */
const PRICE_POINTS = {
  USD: [4.99, 29.99, 79.99],
  EUR: [5.99, 34.99, 89.99],
  GBP: [4.99, 29.99, 79.99],
  CAD: [6.99, 39.99, 109.99],
  AUD: [7.99, 44.99, 119.99],
  NZD: [8.99, 49.99, 129.99],
  CHF: [5.00, 29.00, 79.00],
  SEK: [59, 349, 899],
  NOK: [59, 349, 899],
  DKK: [39, 229, 599],
  PLN: [24.99, 139.99, 379.99],
  CZK: [129, 749, 1990],
  HUF: [1990, 11900, 31900],
  RON: [26.99, 154.99, 419.99],
  UAH: [229, 1299, 3499],
  JPY: [800, 4800, 12800],
  CNY: [38, 218, 588],
  HKD: [38, 228, 588],
  TWD: [150, 900, 2400],
  KRW: [6900, 39000, 99000],
  SGD: [6.98, 39.98, 108.98],
  MYR: [22.90, 129.90, 349.90],
  INR: [399, 2499, 6900],
  IDR: [79000, 449000, 1199000],
  PHP: [299, 1690, 4490],
  THB: [179, 999, 2690],
  VND: [129000, 749000, 1990000],
  PKR: [1400, 7900, 21000],
  BDT: [599, 3399, 8999],
  LKR: [1590, 8990, 23900],
  BRL: [27.90, 159.90, 429.90],
  MXN: [99, 559, 1499],
  CLP: [4900, 27900, 74900],
  COP: [21900, 124900, 334900],
  ZAR: [89.99, 499.99, 1349.99],
  NGN: [4900, 27900, 74900],
  KES: [650, 3700, 9900],
  EGP: [249, 1399, 3799],
  GHS: [79, 449, 1199],
  TZS: [12900, 74900, 199000],
  AED: [18.99, 109.99, 289.99],
  SAR: [18.99, 109.99, 289.99],
  QAR: [18.99, 109.99, 289.99],
  BHD: [1.99, 11.99, 29.99],
  OMR: [1.99, 11.99, 29.99],
  JOD: [3.49, 19.99, 54.99],
  ILS: [19.90, 114.90, 309.90],
  TRY: [199.99, 1149.99, 2999.99],
  MAD: [49.99, 289.99, 799.99],
  DZD: [699, 3999, 10900],
  TND: [16.99, 94.99, 259.99],
};

const PLAN_INDEX = { monthly: 0, annual: 1, lifetime: 2 };
const FALLBACK = 'USD';

/** The BCP-47 locale the browser will format with. */
export function detectLocale() {
  try {
    return navigator.languages?.[0] || navigator.language
      || new Intl.NumberFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

/**
 * Region from the locale's country subtag. That is all a browser reliably
 * exposes — the App Store build reads the real storefront instead.
 */
export function detectRegion(locale = detectLocale()) {
  try {
    if (typeof Intl.Locale === 'function') {
      const region = new Intl.Locale(locale).region;
      if (region) return region.toUpperCase();
    }
  } catch { /* fall through to the string form */ }
  const parts = String(locale).split(/[-_]/);
  const tail = parts.find((p) => /^[A-Za-z]{2}$/.test(p) && p !== parts[0]);
  return tail ? tail.toUpperCase() : null;
}

export function currencyForRegion(region) {
  if (!region) return FALLBACK;
  const code = REGION_CURRENCY[region.toUpperCase()];
  return code && PRICE_POINTS[code] ? code : FALLBACK;
}

class Pricing {
  constructor() {
    this.locale = detectLocale();
    this.region = detectRegion(this.locale);
    this.currency = currencyForRegion(this.region);
    this.auto = true;
  }

  /** Force a currency — used by the tests and by a manual override. */
  setCurrency(code) {
    if (code && PRICE_POINTS[code]) {
      this.currency = code;
      this.auto = false;
    } else {
      this.currency = currencyForRegion(this.region);
      this.auto = true;
    }
    return this.currency;
  }

  amount(planId) {
    const points = PRICE_POINTS[this.currency] || PRICE_POINTS[FALLBACK];
    return points[PLAN_INDEX[planId] ?? 0];
  }

  format(amount) {
    try {
      return new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency: this.currency,
        currencyDisplay: 'narrowSymbol',
      }).format(amount);
    } catch {
      try {
        return new Intl.NumberFormat(this.locale, {
          style: 'currency', currency: this.currency,
        }).format(amount);
      } catch {
        return `${this.currency} ${amount}`;
      }
    }
  }

  price(planId) { return this.format(this.amount(planId)); }

  /** "€2.92/mo" — the annual plan broken down. */
  perMonth(planId) {
    const amount = this.amount(planId) / 12;
    // keep sub-unit currencies readable, leave whole-unit ones alone
    const rounded = amount >= 100 ? Math.round(amount) : Math.round(amount * 100) / 100;
    return this.format(rounded);
  }

  /** How much the annual plan saves against twelve monthly payments. */
  savingsPercent() {
    const monthly = this.amount('monthly') * 12;
    const annual = this.amount('annual');
    if (!monthly || !annual) return 0;
    return Math.round((1 - annual / monthly) * 100);
  }

  /** e.g. "GBP · detected from your region" — shown in Settings. */
  get summary() {
    return `${this.currency}${this.region ? ` · ${this.region}` : ''}${this.auto ? '' : ' · manual'}`;
  }
}

export const pricing = new Pricing();
export const CURRENCIES = Object.keys(PRICE_POINTS);
