import { billing, PLANS, priceOf, subtitleOf } from '../billing.js';
import { pricing } from '../pricing.js';
import { toast, haptic } from './ui.js';

/** The subscription screen: plan picker, purchase, restore. */
export class Paywall {
  constructor() {
    this.el = document.getElementById('paywall');
    this.plansEl = document.getElementById('plans');
    this.cta = document.getElementById('btnSubscribe');
    this.fine = document.getElementById('planFine');
    this.selected = PLANS.find((p) => p.recommended)?.id || PLANS[0].id;
    this.onUnlock = null;

    document.getElementById('paywallClose').addEventListener('click', () => this.close());
    this.cta.addEventListener('click', () => this.#buy());
    document.getElementById('btnRestore').addEventListener('click', () => this.#restore());
    document.getElementById('btnTerms').addEventListener('click', () =>
      toast('Subscriptions renew automatically until cancelled.', '', 3000));
    document.getElementById('btnPrivacy').addEventListener('click', () =>
      toast('Photos and LUTs never leave your device.', '', 3000));

    this.#renderPlans();
  }

  open(reason) {
    if (reason) toast(reason, 'gold', 2600);
    this.el.hidden = false;
    this.el.querySelector('.paywall-scroll').scrollTop = 0;
    this.#renderPlans();
  }

  close() { this.el.hidden = true; }

  get isOpen() { return !this.el.hidden; }

  #renderPlans() {
    this.plansEl.textContent = '';
    for (const plan of PLANS) {
      const btn = document.createElement('button');
      btn.className = 'plan' + (plan.id === this.selected ? ' on' : '');
      btn.innerHTML = `
        <span class="radio"></span>
        <span class="plan-main">
          <span class="plan-t">${plan.title}</span>
          <span class="plan-s">${subtitleOf(plan)}</span>
        </span>
        <span class="plan-price"><span class="p">${priceOf(plan)}</span><span class="u">${plan.unit}</span></span>
        ${plan.tag ? `<span class="tagline">${plan.tag}</span>` : ''}`;
      btn.addEventListener('click', () => {
        this.selected = plan.id;
        haptic(6);
        this.#renderPlans();
      });
      this.plansEl.appendChild(btn);
    }
    this.#syncCta();
  }

  #syncCta() {
    const plan = billing.planById(this.selected);
    const price = priceOf(plan);
    const trialAvailable = !!plan.trialDays && !localStorage.getItem('luma:trialUsed');
    this.cta.textContent = trialAvailable
      ? `Start ${plan.trialDays}-day free trial`
      : plan.periodDays == null ? `Buy Lifetime — ${price}` : `Subscribe — ${price}${plan.unit}`;
    this.fine.textContent = trialAvailable && plan.periodDays
      ? `Free for ${plan.trialDays} days, then ${price}${plan.unit}. Cancel any time.`
      : plan.periodDays == null
        ? 'One payment. No subscription.'
        : `${price}${plan.unit}, renews automatically. Cancel any time.`;
    this.fine.textContent += ` Prices shown in ${pricing.currency}.`;
  }

  async #buy() {
    const plan = billing.planById(this.selected);
    this.cta.disabled = true;
    const prev = this.cta.textContent;
    this.cta.textContent = 'Processing…';
    try {
      await billing.purchase(plan.id);
      haptic([10, 40, 10]);
      toast(billing.entitlement.trial ? 'Trial started — everything is unlocked.' : 'Welcome to LUMA Pro.', 'gold');
      this.close();
      this.onUnlock?.({ restored: false });
    } catch (err) {
      toast(err.message || 'Purchase failed.', 'bad');
    } finally {
      this.cta.disabled = false;
      this.cta.textContent = prev;
      this.#syncCta();
    }
  }

  async #restore() {
    const ent = await billing.restore();
    if (ent && billing.isPro) {
      toast('Purchases restored.', 'gold');
      this.close();
      this.onUnlock?.({ restored: true });
    } else {
      toast('No previous purchase found on this device.');
    }
  }
}
