/** Small UI primitives: toasts, sheets, haptics. */
import { sfx } from '../sfx.js';

const host = () => document.getElementById('toastHost');

export function toast(message, kind = '', ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  host().appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}

/** Best-effort haptics — real on Android, a no-op on iOS Safari. */
export function haptic(pattern = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}

export class Sheets {
  constructor(scrim) {
    this.scrim = scrim;
    this.current = null;
    scrim.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => this.close());
    }
    for (const sheet of document.querySelectorAll('.sheet')) this.#enableDragToClose(sheet);
  }

  open(name) {
    const el = document.getElementById('sheet-' + name);
    if (!el) return;
    if (this.current && this.current !== el) this.#hide(this.current);
    this.current = el;
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    this.scrim.hidden = false;
    requestAnimationFrame(() => el.classList.add('open'));
    this.#syncTabs(name);
    this.dispatch('open', name);
  }

  close() {
    if (!this.current) return;
    const name = this.current.id.replace('sheet-', '');
    this.#hide(this.current);
    this.current = null;
    this.scrim.hidden = true;
    this.#syncTabs(null);
    this.dispatch('close', name);
  }

  toggle(name) {
    const el = document.getElementById('sheet-' + name);
    if (this.current === el) this.close(); else this.open(name);
  }

  get openName() { return this.current ? this.current.id.replace('sheet-', '') : null; }

  #hide(el) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 340);
  }

  #syncTabs(name) {
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('on', t.dataset.sheet === name);
    }
  }

  #enableDragToClose(sheet) {
    const grabber = sheet.querySelector('.grabber');
    const head = sheet.querySelector('.sheet-head');
    let startY = 0, dy = 0, dragging = false;

    const down = (e) => {
      dragging = true; startY = e.touches ? e.touches[0].clientY : e.clientY; dy = 0;
      sheet.style.transition = 'none';
    };
    const move = (e) => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      dy = Math.max(0, y - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 90) this.close();
    };

    for (const handle of [grabber, head]) {
      if (!handle) continue;
      handle.addEventListener('touchstart', down, { passive: true });
      handle.addEventListener('touchmove', move, { passive: true });
      handle.addEventListener('touchend', up);
      handle.addEventListener('mousedown', down);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  #listeners = {};
  on(evt, fn) { (this.#listeners[evt] ||= []).push(fn); return this; }
  dispatch(evt, arg) { (this.#listeners[evt] || []).forEach((f) => f(arg)); }
}

/** Build one labelled slider row for the Adjust sheet. */
export function sliderRow({ label, min, max, step, value, format, locked, onInput }) {
  const row = document.createElement('div');
  row.className = 'adj' + (locked ? ' locked' : '');

  const name = document.createElement('span');
  name.className = 'adj-label';
  name.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'range';
  input.min = min; input.max = max; input.step = step; input.value = value;
  input.setAttribute('aria-label', label);

  const val = document.createElement('span');
  val.className = 'adj-val';

  const paint = () => {
    const pct = ((input.value - min) / (max - min)) * 100;
    input.style.setProperty('--fill', pct + '%');
    val.textContent = format ? format(Number(input.value)) : input.value;
  };
  input.addEventListener('input', () => { paint(); onInput?.(Number(input.value)); });
  paint();

  row.append(name, input, val);
  row.setValue = (v) => { input.value = v; paint(); };
  return row;
}

export function switchRow({ title, sub, checked, onChange, badge }) {
  const row = document.createElement('div');
  row.className = 'row';
  const main = document.createElement('div');
  main.className = 'row-main';
  const t = document.createElement('span');
  t.className = 'row-t';
  t.textContent = title;
  if (badge) {
    const b = document.createElement('span');
    b.textContent = ' ' + badge;
    b.style.cssText = 'color:var(--gold);font-size:10px;font-weight:750;letter-spacing:.1em';
    t.appendChild(b);
  }
  main.appendChild(t);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'row-s';
    s.textContent = sub;
    main.appendChild(s);
  }
  const sw = document.createElement('button');
  sw.className = 'switch';
  sw.dataset.sfx = 'none';        // the handler knows which way it flipped
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(!!checked));
  sw.setAttribute('aria-label', title);
  sw.addEventListener('click', () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    haptic(6);
    sfx.play(next ? 'toggleOn' : 'toggleOff');
    onChange?.(next);
  });
  row.append(main, sw);
  row.setChecked = (v) => sw.setAttribute('aria-checked', String(!!v));
  return row;
}

export function actionRow({ title, sub, value, onClick, danger }) {
  const row = document.createElement('button');
  row.className = 'row';
  row.style.width = '100%';
  row.style.textAlign = 'left';
  const main = document.createElement('div');
  main.className = 'row-main';
  const t = document.createElement('span');
  t.className = 'row-t';
  t.textContent = title;
  if (danger) t.style.color = 'var(--danger)';
  main.appendChild(t);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'row-s';
    s.textContent = sub;
    main.appendChild(s);
  }
  const v = document.createElement('span');
  v.className = 'row-value';
  v.textContent = value || '›';
  row.append(main, v);
  row.addEventListener('click', () => onClick?.(row));
  row.setValue = (x) => { v.textContent = x; };
  return row;
}
