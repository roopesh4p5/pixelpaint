/* PixelPaint · view.js — CoordinateMapper + CanvasRenderer
 *
 * Coordinate spaces
 *   client  : CSS px from the browser event (clientX/Y)
 *   device  : backing-store px of the display canvas (client × dpr, CSS-scaling aware)
 *   document: image pixels. device = ox + doc × scale, where scale = zoom × dpr.
 * All tools receive document coordinates from View.toDoc — the only conversion in the app.
 */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, bus = PP.bus, BLEND = PP.Model.BLEND;
const ZOOMS = [0.01, 0.02, 0.03, 0.05, 0.0625, 0.083, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

class View {
  constructor(stage) {
    this.stage = stage;
    this.main = U.el('canvas', { class: 'view-main', 'aria-label': 'Document canvas' });
    this.over = U.el('canvas', { class: 'view-over', 'aria-hidden': 'true' });
    stage.append(this.main, this.over);
    this.mx = this.main.getContext('2d', { alpha: false });
    this.ox_ = this.over.getContext('2d');
    this.zoom = 1; this.panX = 0; this.panY = 0; this.dpr = 1;
    this.composite = null; this.cx = null;
    this.dirty = null; this.full = true; this.frame = 0; this.wantDisplay = true; this.wantOverlay = true;
    this.antsPhase = 0; this.cursor = null; this.showGrid = false; this.bg = 'checker';
    new ResizeObserver(() => this.resize()).observe(stage);
    bus.on('pixels', e => this.invalidate(e && e.rect));
    bus.on('selection', () => this.requestOverlay());
    bus.on('docsize', () => this.allocate());
    setInterval(() => { if (PP.app.doc && PP.app.doc.selection.active && !document.hidden) { this.antsPhase = (this.antsPhase + 1) % 8; this.requestOverlay(); } }, 140);
    this.resize();
  }

  /* ───── coordinate mapper ───── */
  get scale() { return this.zoom * this.dpr; }
  get ox() { return Math.round(this.panX * this.dpr); }
  get oy() { return Math.round(this.panY * this.dpr); }
  toDoc(clientX, clientY) {
    const r = this.main.getBoundingClientRect(), kx = this.main.width / r.width, ky = this.main.height / r.height;
    return { x: ((clientX - r.left) * kx - this.ox) / this.scale, y: ((clientY - r.top) * ky - this.oy) / this.scale };
  }
  X(x) { return this.ox + x * this.scale; }
  Y(y) { return this.oy + y * this.scale; }
  /** Device-px transform for drawing document-space geometry on the overlay. */
  docTransform(ctx) { ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy); }

  resize() {
    const r = this.stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const first = this.cssW == null;
    if (!first) { this.panX += (r.width - this.cssW) / 2; this.panY += (r.height - this.cssH) / 2; } // keep centre
    this.cssW = r.width; this.cssH = r.height; this.dpr = dpr;
    for (const c of [this.main, this.over]) { c.width = w; c.height = h; }
    this.checker = null;
    this.wsColor = (getComputedStyle(this.stage).getPropertyValue('--workspace') || '').trim() || '#17181b';
    this.request(true);
  }

  allocate() {
    const d = PP.app.doc; if (!d) return;
    if (!this.composite || this.composite.width !== d.width || this.composite.height !== d.height) {
      this.composite = document.createElement('canvas');
      this.composite.width = d.width; this.composite.height = d.height;
      this.cx = this.composite.getContext('2d');
    }
    this.invalidate(null);
  }

  /* ───── zoom / pan ───── */
  setZoom(z, clientX, clientY) {
    z = U.clamp(z, PP.Config.ZOOM_MIN, PP.Config.ZOOM_MAX);
    const r = this.main.getBoundingClientRect();
    const cx = clientX == null ? r.width / 2 : clientX - r.left, cy = clientY == null ? r.height / 2 : clientY - r.top;
    const dx = (cx - this.panX) / this.zoom, dy = (cy - this.panY) / this.zoom;
    this.zoom = z; this.panX = cx - dx * z; this.panY = cy - dy * z;
    this.clampPan(); this.request(true); bus.emit('view');
  }
  step(dir, clientX, clientY) {
    const z = this.zoom;
    const next = dir > 0 ? ZOOMS.find(v => v > z * 1.001) : [...ZOOMS].reverse().find(v => v < z / 1.001);
    if (next) this.setZoom(next, clientX, clientY);
  }
  panBy(dx, dy) { this.panX += dx; this.panY += dy; this.clampPan(); this.request(true); bus.emit('view'); }
  clampPan() {
    const d = PP.app.doc; if (!d) return;
    const m = 48, w = d.width * this.zoom, h = d.height * this.zoom;
    this.panX = U.clamp(this.panX, m - w, this.cssW - m); this.panY = U.clamp(this.panY, m - h, this.cssH - m);
  }
  fit() {
    const d = PP.app.doc; if (!d) return;
    const pad = 32, z = Math.min((this.cssW - pad) / d.width, (this.cssH - pad) / d.height, 1);
    this.zoom = U.clamp(z, PP.Config.ZOOM_MIN, PP.Config.ZOOM_MAX);
    this.panX = (this.cssW - d.width * this.zoom) / 2; this.panY = (this.cssH - d.height * this.zoom) / 2;
    this.request(true); bus.emit('view');
  }
  actual() { this.setZoom(1); }

  /* ───── scheduling ───── */
  invalidate(rect) {
    if (!rect) this.full = true;
    else if (!this.full) this.dirty = U.union(this.dirty, U.snap(rect));
    this.request(true);
  }
  request(display) { if (display) this.wantDisplay = true; this.wantOverlay = true; if (!this.frame) this.frame = requestAnimationFrame(() => this.draw()); }
  requestOverlay() { this.request(false); }

  draw() {
    this.frame = 0;
    const d = PP.app.doc;
    if (d && this.composite) {
      if (this.full) this.recomposite(null);
      else if (this.dirty) { const r = U.intersect(this.dirty, { x: 0, y: 0, w: d.width, h: d.height }); if (r) this.recomposite(r); }
      this.full = false; this.dirty = null;
    }
    if (this.wantDisplay) this.drawDisplay();
    if (this.wantOverlay) this.drawOverlay();
    this.wantDisplay = this.wantOverlay = false;
  }

  /** Composite visible layers into the document-size cache (optionally only a rect). */
  recomposite(r) {
    const d = PP.app.doc, x = this.cx;
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (r) { x.beginPath(); x.rect(r.x, r.y, r.w, r.h); x.clip(); x.clearRect(r.x, r.y, r.w, r.h); }
    else x.clearRect(0, 0, d.width, d.height);
    for (const l of d.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      x.globalAlpha = l.opacity;
      x.globalCompositeOperation = BLEND[l.blend] || 'source-over';
      if (l.xform) { const m = l.xform; x.save(); x.imageSmoothingQuality = 'high'; x.transform(m.a, m.b, m.c, m.d, m.e, m.f); x.drawImage(l.source(), 0, 0); x.restore(); }
      else x.drawImage(l.source(), l.x, l.y);
    }
    x.restore();
  }

  checkerPattern() {
    if (this.checker) return this.checker;
    const s = Math.round(8 * this.dpr), c = U.el('canvas', { width: s * 2, height: s * 2 }), g = c.getContext('2d');
    g.fillStyle = '#cfcfcf'; g.fillRect(0, 0, s * 2, s * 2); g.fillStyle = '#9e9e9e'; g.fillRect(0, 0, s, s); g.fillRect(s, s, s, s);
    return (this.checker = this.mx.createPattern(c, 'repeat'));
  }

  drawDisplay() {
    const g = this.mx, d = PP.app.doc, W = this.main.width, H = this.main.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.wsColor;
    g.fillRect(0, 0, W, H);
    if (!d || !this.composite) return;
    const s = this.scale, ox = this.ox, oy = this.oy;
    // visible document region (integer-aligned for exact nearest-neighbour pixels)
    const vx0 = Math.max(0, Math.floor(-ox / s)), vy0 = Math.max(0, Math.floor(-oy / s));
    const vx1 = Math.min(d.width, Math.ceil((W - ox) / s)), vy1 = Math.min(d.height, Math.ceil((H - oy) / s));
    if (vx1 <= vx0 || vy1 <= vy0) return;
    const dx = ox + vx0 * s, dy = oy + vy0 * s, dw = (vx1 - vx0) * s, dh = (vy1 - vy0) * s;
    g.fillStyle = this.bg === 'checker' ? this.checkerPattern() : this.bg;
    g.fillRect(Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    g.imageSmoothingEnabled = this.zoom < 1;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.composite, vx0, vy0, vx1 - vx0, vy1 - vy0, dx, dy, dw, dh);
  }

  drawOverlay() {
    const g = this.ox_, d = PP.app.doc, dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.over.width, this.over.height);
    if (!d) return;
    const s = this.scale;
    // quick-mask tint (unselected area in red)
    if (PP.app.quickMask) {
      const t = this.quickMaskCanvas();
      if (t) { this.docTransform(g); g.imageSmoothingEnabled = this.zoom < 1; g.globalAlpha = 0.5; g.drawImage(t, 0, 0); g.globalAlpha = 1; g.setTransform(1, 0, 0, 1, 0, 0); }
    }
    // pixel grid
    if (this.showGrid && this.zoom >= 8) {
      g.beginPath();
      const x0 = Math.max(0, Math.floor(-this.ox / s)), x1 = Math.min(d.width, Math.ceil((this.over.width - this.ox) / s));
      const y0 = Math.max(0, Math.floor(-this.oy / s)), y1 = Math.min(d.height, Math.ceil((this.over.height - this.oy) / s));
      for (let x = x0; x <= x1; x++) { const X = Math.round(this.X(x)) + 0.5; g.moveTo(X, this.Y(y0)); g.lineTo(X, this.Y(y1)); }
      for (let y = y0; y <= y1; y++) { const Y = Math.round(this.Y(y)) + 0.5; g.moveTo(this.X(x0), Y); g.lineTo(this.X(x1), Y); }
      g.strokeStyle = 'rgba(128,128,128,.35)'; g.lineWidth = 1; g.stroke();
    }
    // document edge
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1;
    g.strokeRect(Math.round(this.X(0)) - 0.5, Math.round(this.Y(0)) - 0.5, Math.round(d.width * s) + 1, Math.round(d.height * s) + 1);
    // marching ants
    const path = d.selection.outline;
    if (path) {
      this.docTransform(g);
      g.lineWidth = dpr / s;
      g.setLineDash([]); g.strokeStyle = '#fff'; g.stroke(path);
      g.setLineDash([4 * dpr / s, 4 * dpr / s]); g.lineDashOffset = -this.antsPhase * dpr / s; g.strokeStyle = '#000'; g.stroke(path);
      g.setLineDash([]); g.setTransform(1, 0, 0, 1, 0, 0);
    }
    const tool = PP.app.tools && PP.app.tools.current;
    if (tool && tool.overlay) { g.save(); tool.overlay(g, this); g.restore(); }
    // brush cursor
    if (this.cursor && this.cursor.r) {
      const X = this.X(this.cursor.x), Y = this.Y(this.cursor.y), R = Math.max(1, this.cursor.r * s);
      g.beginPath(); g.arc(X, Y, R, 0, Math.PI * 2);
      g.lineWidth = dpr; g.strokeStyle = 'rgba(0,0,0,.8)'; g.stroke();
      g.beginPath(); g.arc(X, Y, R + dpr, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.8)'; g.stroke();
    }
  }

  /** Red tint over unselected pixels: solid fill minus the selection alpha (GPU composite, no pixel loop). */
  quickMaskCanvas() {
    const sel = PP.app.doc.selection, live = PP.app.qmPreview, src = live || sel.canvas();
    if (!live && this._qmRev === sel.rev && this._qm) return this._qm;
    if (!this._qm || this._qm.width !== sel.w || this._qm.height !== sel.h) { this._qm = document.createElement('canvas'); this._qm.width = sel.w; this._qm.height = sel.h; }
    const g = this._qm.getContext('2d');
    g.globalCompositeOperation = 'copy'; g.fillStyle = '#ff2020'; g.fillRect(0, 0, sel.w, sel.h);
    if (src) { g.globalCompositeOperation = 'destination-out'; g.drawImage(src, 0, 0); }
    g.globalCompositeOperation = 'source-over';
    this._qmRev = live ? -1 : sel.rev;
    return this._qm;
  }

  /** Flattened copy of the current composite (always fully up to date). */
  flattened() {
    if (this.full || this.dirty) { this.recomposite(null); this.full = false; this.dirty = null; }
    return U.clone(this.composite);
  }
}

PP.View = View;
})();
