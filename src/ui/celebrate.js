/**
 * The unlock moment.
 *
 * A confetti burst and a wordmark flourish when Pro is unlocked — the one
 * place in the app where a bit of theatre is the point. Pure canvas, no
 * dependencies, and it removes itself when it's done.
 */

const COLORS = ['#e3b874', '#f5d9a8', '#fff4de', '#c9963f', '#ffffff', '#6fe0a8'];

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function celebrate({ duration = 2600, count = 160, title = 'LUMA PRO' } = {}) {
  const host = document.createElement('div');
  host.className = 'celebrate';
  host.setAttribute('aria-hidden', 'true');

  const banner = document.createElement('div');
  banner.className = 'celebrate-banner';
  banner.innerHTML = `<span class="celebrate-mark">✦</span><span>${title}</span>`;
  host.appendChild(banner);

  document.body.appendChild(host);

  if (reducedMotion()) {
    // Still mark the moment, without the motion.
    setTimeout(() => host.remove(), 1600);
    return;
  }

  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  host.insertBefore(canvas, banner);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // three cannons: bottom-centre plus the two lower corners
  const sources = [
    { x: width / 2, y: height * 0.72, spread: 1.5, aim: -Math.PI / 2, power: 15 },
    { x: width * 0.06, y: height * 0.9, spread: 0.7, aim: -Math.PI / 3, power: 17 },
    { x: width * 0.94, y: height * 0.9, spread: 0.7, aim: (-Math.PI * 2) / 3, power: 17 },
  ];

  const pieces = [];
  for (let i = 0; i < count; i++) {
    const source = sources[i % sources.length];
    const angle = source.aim + (Math.random() - 0.5) * source.spread;
    const speed = source.power * (0.55 + Math.random() * 0.75);
    pieces.push({
      x: source.x,
      y: source.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 7,
      ratio: 0.4 + Math.random() * 0.8,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      spin: (Math.random() - 0.5) * 0.4,
      angle: Math.random() * Math.PI,
      drag: 0.982 + Math.random() * 0.012,
      life: 0,
    });
  }

  const gravity = 0.42;
  const started = performance.now();
  let raf = 0;

  const frame = (now) => {
    const elapsed = now - started;
    ctx.clearRect(0, 0, width, height);

    let alive = 0;
    for (const p of pieces) {
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      p.life = elapsed / duration;

      if (p.y > height + 40) continue;
      alive++;

      const fade = Math.max(0, 1 - Math.max(0, p.life - 0.55) / 0.45);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      // the flutter: width oscillates as it tumbles
      ctx.fillRect(-p.size / 2, -p.size * p.ratio / 2,
                   p.size * Math.abs(Math.cos(p.angle * 0.7)), p.size * p.ratio);
      ctx.restore();
    }

    if (elapsed < duration && alive > 0) {
      raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(raf);
      host.classList.add('out');
      setTimeout(() => host.remove(), 400);
    }
  };
  raf = requestAnimationFrame(frame);
}
