/**
 * Subscriptions.
 *
 * The web build ships a *local* adapter: it simulates a purchase so the whole
 * paywall → entitlement → unlock flow is real and testable, but no money moves.
 * Swapping in a real processor means implementing BillingAdapter and setting
 * `billing.adapter = new MyAdapter()` — nothing else in the app touches payment.
 *
 *   iOS (later, in Xcode):  StoreKit 2 — Product.products(for:), product.purchase(),
 *                           Transaction.currentEntitlements → setEntitlement()
 *   Web:                    Stripe Checkout + a webhook that writes the entitlement
 *                           for the signed-in account.
 */
import { prefs } from './store.js';

export const PLANS = [
  {
    id: 'monthly',
    productId: 'app.luma.pro.monthly',
    title: 'Monthly',
    sub: 'Cancel anytime',
    price: '$4.99',
    unit: '/mo',
    trialDays: 7,
    periodDays: 30,
  },
  {
    id: 'annual',
    productId: 'app.luma.pro.annual',
    title: 'Annual',
    sub: '$2.50/mo — save 50%',
    price: '$29.99',
    unit: '/yr',
    tag: 'BEST VALUE',
    trialDays: 7,
    periodDays: 365,
    recommended: true,
  },
  {
    id: 'lifetime',
    productId: 'app.luma.pro.lifetime',
    title: 'Lifetime',
    sub: 'One payment, yours forever',
    price: '$79.99',
    unit: 'once',
    periodDays: null,
  },
];

export const FREE_LIMITS = {
  imports: 1,              // custom .cube slots
  maxLongEdge: 1600,       // export resolution cap
  watermark: true,
};

/** @typedef {{plan:string, since:number, expires:number|null, trial:boolean, source:string}} Entitlement */

/** Interface a real payment backend implements. */
export class BillingAdapter {
  /** @returns {Promise<Entitlement|null>} */
  async status() { return null; }
  /** @returns {Promise<Entitlement>} */
  async purchase(_plan) { throw new Error('not implemented'); }
  /** @returns {Promise<Entitlement|null>} */
  async restore() { return null; }
  async manage() { /* open the store's subscription management UI */ }
}

/** Local/demo adapter — entitlement lives in this browser only. */
export class LocalBillingAdapter extends BillingAdapter {
  async status() { return prefs.get('entitlement', null); }

  async purchase(plan) {
    await new Promise((r) => setTimeout(r, 900));  // pretend network
    const now = Date.now();
    const trial = !!plan.trialDays && !prefs.get('trialUsed', false);
    const days = trial ? plan.trialDays : plan.periodDays;
    const ent = {
      plan: plan.id,
      productId: plan.productId,
      since: now,
      expires: days ? now + days * 864e5 : null,
      trial,
      source: 'local-demo',
    };
    if (trial) prefs.set('trialUsed', true);
    prefs.set('entitlement', ent);
    return ent;
  }

  async restore() {
    return prefs.get('entitlement', null);
  }

  async manage() {
    return 'This demo build has no store to manage. On iOS this opens Settings → Subscriptions.';
  }
}

class Billing extends EventTarget {
  constructor(adapter = new LocalBillingAdapter()) {
    super();
    this.adapter = adapter;
    this.entitlement = null;
  }

  async init() {
    this.entitlement = await this.adapter.status();
    this.#emit();
    return this.entitlement;
  }

  get isPro() {
    const e = this.entitlement;
    if (!e) return false;
    if (e.expires == null) return true;
    return e.expires > Date.now();
  }

  get statusLabel() {
    const e = this.entitlement;
    if (!this.isPro) return 'Free';
    if (e.expires == null) return 'Lifetime';
    const days = Math.max(0, Math.ceil((e.expires - Date.now()) / 864e5));
    return e.trial ? `Trial · ${days}d left` : `Pro · renews in ${days}d`;
  }

  planById(id) { return PLANS.find((p) => p.id === id); }

  async purchase(planId) {
    const plan = this.planById(planId);
    if (!plan) throw new Error('Unknown plan');
    this.entitlement = await this.adapter.purchase(plan);
    this.#emit();
    return this.entitlement;
  }

  async restore() {
    this.entitlement = await this.adapter.restore();
    this.#emit();
    return this.entitlement;
  }

  /** Demo affordance so the locked state can be inspected without clearing storage. */
  async cancel() {
    prefs.remove('entitlement');
    this.entitlement = null;
    this.#emit();
  }

  /* ── gating helpers ─────────────────────────────────────── */

  canUseLook(preset) { return !!preset?.free || this.isPro; }
  canImport(currentCount) { return this.isPro || currentCount < FREE_LIMITS.imports; }
  get watermark() { return !this.isPro && FREE_LIMITS.watermark; }
  get maxLongEdge() { return this.isPro ? Infinity : FREE_LIMITS.maxLongEdge; }

  #emit() { this.dispatchEvent(new CustomEvent('change', { detail: this.entitlement })); }
}

export const billing = new Billing();
