// DOM helper for the rev-light style level meter (see .revlights in theme.css).

export class RevLights {
  private segs: HTMLSpanElement[] = [];

  constructor(el: HTMLElement, count = 15) {
    el.classList.add('revlights');
    el.style.setProperty('--segments', String(count));
    el.replaceChildren();
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      const pos = i / (count - 1);
      s.className = pos < 0.6 ? 'g' : pos < 0.85 ? 'a' : 'r';
      el.appendChild(s);
      this.segs.push(s);
    }
  }

  /** level 0..1 */
  set(level: number): void {
    const lit = Math.round(level * this.segs.length);
    this.segs.forEach((s, i) => s.classList.toggle('on', i < lit));
  }
}
