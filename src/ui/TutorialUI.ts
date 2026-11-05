import { gsap } from 'gsap';

export type TutDevice = 'keyboard' | 'gamepad' | 'touch';

/** Turns `[[KEY]]` markup into device-styled input chips. */
export function chips(html: string, device: TutDevice): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_m, k: string) => `<kbd class="k-${device}${/^(A|B|X|Y)$/.test(k) && device === 'gamepad' ? ' p-' + k : ''}">${k}</kbd>`);
}

/** DOM presentation for the tutorial: step card, progress, completion flourish, highlights, off-screen beacon arrow. */
export class TutorialUI {
  private el: HTMLElement;
  private arrow: HTMLElement;
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
  private lit: Element[] = [];
  private tipTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(slot: HTMLElement, root: HTMLElement, private cb: { onSkip(): void; onDismiss(): void }) {
    this.el = document.createElement('div');
    this.el.id = 'tut';
    this.el.className = 'glass';
    this.el.style.display = 'none';
    this.el.innerHTML = `
      <div class="tut-head"><span class="tut-step"></span><button class="tut-skip" type="button"></button></div>
      <div class="tut-title"></div><div class="tut-flavor"></div><div class="tut-body"></div>
      <div class="tut-prog"><div class="tut-bar"><i></i></div><span></span></div>
      <div class="tut-dots"></div><div class="tut-check">✓</div>`;
    slot.appendChild(this.el);
    this.arrow = document.createElement('div');
    this.arrow.id = 'tut-arrow';
    this.arrow.innerHTML = '<i></i><span></span>';
    root.appendChild(this.arrow);
    this.q('.tut-skip').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.el.classList.contains('tip') ? this.cb.onDismiss() : this.cb.onSkip(); });
  }

  private fill(title: string, flavor: string, body: string, label: string, skip: string, total: number, index: number, tip: boolean): void {
    this.el.classList.toggle('tip', tip);
    this.q('.tut-step').textContent = label;
    this.q('.tut-skip').textContent = skip;
    this.q('.tut-title').textContent = title;
    this.q('.tut-flavor').textContent = flavor;
    this.q('.tut-body').innerHTML = body;
    const dots = this.q('.tut-dots');
    dots.style.display = total ? 'flex' : 'none';
    dots.innerHTML = Array.from({ length: total }, (_, i) => `<b class="${i < index ? 'on' : i === index ? 'cur' : ''}"></b>`).join('');
  }

  showStep(i: number, total: number, title: string, flavor: string, body: string, needs: boolean): void {
    // gsap leaves inline styles on the check badge; clear them so the next step starts clean
    this.cancelTip();
    const swap = this.el.style.display !== 'none';
    const apply = () => {
      this.el.classList.remove('done');
      gsap.set(this.q('.tut-check'), { clearProps: 'all' });
      this.fill(title, flavor, body, `STEP ${i + 1} / ${total}`, 'SKIP ✕', total, i, false);
      this.q('.tut-prog').style.display = needs ? 'flex' : 'none';
      this.setProgress(0, '');
      this.el.style.display = 'block';
      gsap.fromTo(this.el, { x: swap ? -26 : 0, y: swap ? 0 : -16, opacity: 0 }, { x: 0, y: 0, opacity: 1, duration: 0.38, ease: 'power3.out', onComplete: () => { this.busy = false; } });
    };
    this.busy = true;
    if (swap) gsap.to(this.el, { x: 26, opacity: 0, duration: 0.2, ease: 'power2.in', onComplete: apply }); else apply();
  }

  /** Re-render body copy (device changed / state changed) without replaying the animation. */
  setBody(html: string): void { this.q('.tut-body').innerHTML = html; }

  setProgress(v: number, label: string): void {
    (this.q('.tut-bar i')).style.transform = `scaleX(${Math.max(0, Math.min(1, v))})`;
    this.q('.tut-prog span').textContent = label;
  }

  /** Green check flourish; resolves after the beat so the next step can slide in. */
  complete(): Promise<void> {
    return new Promise((res) => {
      this.el.classList.add('done');
      const c = this.q('.tut-check');
      gsap.fromTo(c, { scale: 0.2, opacity: 0, rotate: -25 }, { scale: 1, opacity: 1, rotate: 0, duration: 0.45, ease: 'back.out(2.4)' });
      gsap.fromTo(this.el, { scale: 1 }, { scale: 1.035, duration: 0.14, yoyo: true, repeat: 1, ease: 'power2.out' });
      setTimeout(res, 950);
    });
  }

  showTip(title: string, body: string, ttl: number): void {
    this.cancelTip();
    this.fill(title, '', body, 'FIELD NOTE', 'GOT IT ✕', 0, 0, true);
    this.q('.tut-prog').style.display = 'none';
    this.el.classList.remove('done');
    this.el.style.display = 'block';
    gsap.fromTo(this.el, { y: -16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.38, ease: 'power3.out' });
    this.tipTimer = setTimeout(() => this.cb.onDismiss(), ttl * 1000);
  }
  private cancelTip(): void { if (this.tipTimer) { clearTimeout(this.tipTimer); this.tipTimer = null; } }

  showFinale(title: string, flavor: string, body: string): void {
    this.cancelTip();
    this.fill(title, flavor, body, 'TUTORIAL COMPLETE', '', 0, 0, false);
    this.q('.tut-skip').style.display = 'none';
    this.q('.tut-prog').style.display = 'none';
    this.el.classList.add('done', 'finale');
    this.el.style.display = 'block';
    gsap.fromTo(this.el, { y: -16, opacity: 0, scale: 0.94 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(1.6)' });
    gsap.fromTo(this.q('.tut-check'), { scale: 0.2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.4)' });
  }

  hide(): void {
    this.cancelTip(); this.highlight([]); this.setArrow(null);
    if (this.el.style.display === 'none') return;
    gsap.to(this.el, { y: -14, opacity: 0, duration: 0.3, onComplete: () => { this.el.style.display = 'none'; this.el.classList.remove('finale', 'done'); this.q('.tut-skip').style.display = ''; } });
  }

  get isBusy(): boolean { return this.busy; }

  /** Pulse the named on-screen controls. */
  highlight(selectors: string[]): void {
    const next = selectors.flatMap((s) => Array.from(document.querySelectorAll(s)));
    for (const e of this.lit) if (!next.includes(e)) e.classList.remove('tut-pulse');
    for (const e of next) e.classList.add('tut-pulse');
    this.lit = next;
  }

  /** Edge-of-screen arrow toward an off-screen objective. */
  setArrow(a: { x: number; y: number; angle: number; label: string } | null): void {
    if (!a) { this.arrow.style.display = 'none'; return; }
    this.arrow.style.display = 'flex';
    this.arrow.style.transform = `translate(${a.x}px, ${a.y}px)`;
    (this.arrow.querySelector('i') as HTMLElement).style.transform = `rotate(${a.angle}rad)`;
    (this.arrow.querySelector('span') as HTMLElement).textContent = a.label;
  }
}
