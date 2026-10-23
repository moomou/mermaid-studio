export class Viewport {
  private svg?: SVGSVGElement;
  private scale = 1;
  private x = 0;
  private y = 0;
  private width = 1;
  private height = 1;
  private drag?: { id: number; x: number; y: number; originX: number; originY: number; moved: boolean };
  private resize: ResizeObserver;
  private fitted = true;
  private cancelledClick = false;

  constructor(private host: HTMLElement, private onZoom: (scale: number) => void) {
    this.resize = new ResizeObserver(() => {
      if (this.fitted) this.fit();
    });
    this.resize.observe(host);
    host.addEventListener('wheel', event => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const bounds = host.getBoundingClientRect();
        this.zoom(Math.exp(-event.deltaY * 0.008), event.clientX - bounds.left, event.clientY - bounds.top);
      } else {
        this.x -= event.deltaX;
        this.y -= event.deltaY;
        this.fitted = false;
        this.apply();
      }
    }, { passive: false });
    host.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.cancelledClick = false;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: this.x, originY: this.y, moved: false };
    });
    host.addEventListener('pointermove', event => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) < 4 && !this.drag.moved) return;
      if (!this.drag.moved) {
        host.setPointerCapture(event.pointerId);
        this.drag.moved = true;
        host.classList.add('is-panning');
      }
      this.x = this.drag.originX + dx;
      this.y = this.drag.originY + dy;
      this.fitted = false;
      this.apply();
    });
    const endDrag = (event: PointerEvent) => {
      if (this.drag?.id !== event.pointerId) return;
      this.cancelledClick = this.drag.moved;
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      this.drag = undefined;
      host.classList.remove('is-panning');
    };
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    host.addEventListener('click', event => {
      if (this.cancelledClick) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelledClick = false;
      }
    }, true);
    host.addEventListener('keydown', event => {
      if (event.target !== host) return;
      const keys: Record<string, [number, number]> = {
        ArrowLeft: [45, 0], ArrowRight: [-45, 0], ArrowUp: [0, 45], ArrowDown: [0, -45],
      };
      if (keys[event.key]) {
        event.preventDefault();
        this.x += keys[event.key][0]; this.y += keys[event.key][1];
        this.fitted = false; this.apply();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault(); this.zoom(1.2);
      } else if (event.key === '-') {
        event.preventDefault(); this.zoom(1 / 1.2);
      } else if (event.key === '0') {
        event.preventDefault(); this.fit();
      }
    });
  }

  set(svg: SVGSVGElement): void {
    this.svg = svg;
    const viewBox = svg.viewBox.baseVal;
    this.width = viewBox.width || Number(svg.getAttribute('width')) || 1;
    this.height = viewBox.height || Number(svg.getAttribute('height')) || 1;
    svg.style.width = `${this.width}px`;
    svg.style.height = `${this.height}px`;
    svg.style.maxWidth = 'none';
    svg.style.position = 'absolute';
    svg.style.transformOrigin = '0 0';
    this.host.replaceChildren(svg);
    this.fit();
  }

  fit(): void {
    if (!this.svg || !this.host.clientWidth || !this.host.clientHeight) return;
    this.scale = Math.min((this.host.clientWidth - 28) / this.width, (this.host.clientHeight - 28) / this.height, 1.3);
    this.x = (this.host.clientWidth - this.width * this.scale) / 2;
    this.y = (this.host.clientHeight - this.height * this.scale) / 2;
    this.fitted = true;
    this.apply();
  }

  zoom(factor: number, x = this.host.clientWidth / 2, y = this.host.clientHeight / 2): void {
    const next = Math.max(0.08, Math.min(4, this.scale * factor));
    const ratio = next / this.scale;
    this.x = x - (x - this.x) * ratio;
    this.y = y - (y - this.y) * ratio;
    this.scale = next;
    this.fitted = false;
    this.apply();
  }

  private apply(): void {
    if (!this.svg) return;
    this.svg.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.onZoom(this.scale);
  }

  destroy(): void {
    this.resize.disconnect();
  }
}
