/* PixelPaint · ui.js — UIController + KeyboardManager
 * All user-visible text is set via textContent (U.el). Icons are static, app-defined SVG paths. */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, bus = PP.bus, el = U.el;
const app = () => PP.app, Ops = () => PP.Ops, IO = () => PP.IO;
const UI = PP.UI = {};
const $ = s => document.querySelector(s);
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl+';

function icon(d, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.append(p);
  return svg;
}
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, path, v) => { const ks = path.split('.'), last = ks.pop(); ks.reduce((a, k) => (a[k] = a[k] || {}), o)[last] = v; };

/* ───────────── toast / status / busy ───────────── */
UI.toast = function (msg, kind = 'info') {
  const t = el('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status', text: msg });
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2600);
};
const statusState = {};
UI.status = function (o) {
  Object.assign(statusState, o);
  if (o.pos) { const p = o.pos, d = app().doc; $('#st-pos').textContent = d && p.x >= 0 && p.y >= 0 && p.x < d.width && p.y < d.height ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '—'; }
  if ('sel' in o) $('#st-sel').textContent = o.sel || '';
  if (o.save) $('#st-save').textContent = o.save;
};
let busyCount = 0, jobBusy = false, busyMsg = '';
function paintBusy() {
  const on = busyCount > 0 || jobBusy;
  $('#st-busy').hidden = !on;
  $('#st-busy').textContent = on ? busyMsg || 'Processing…' : '';
  document.body.classList.toggle('busy', busyCount > 0);
}
UI.busy = function (on, msg) { busyCount = Math.max(0, busyCount + (on ? 1 : -1)); if (on) busyMsg = msg || ''; paintBusy(); };
function refreshStatus() {
  const d = app().doc, v = app().view;
  $('#st-zoom').value = d ? Math.round(v.zoom * 1000) / 10 + '%' : '';
  $('#st-size').textContent = d ? `${d.width} × ${d.height} px` : '';
  const b = d && d.selection.bounds;
  $('#st-sel').textContent = b ? `Sel ${b.w} × ${b.h}` : '';
  $('#st-tool').textContent = app().tools && app().tools.current ? app().tools.current.name : '';
}

/* ───────────── dialogs ───────────── */
let openDialog = null;
/**
 * fields: [{key,label,type:'range'|'number'|'check'|'select'|'color'|'text'|'textarea'|'note', min,max,step,options,unit}]
 * Returns {close, values, root}.
 */
UI.dialog = function ({ title, fields = [], values = {}, ok = 'OK', cancel = 'Cancel', onChange, onOk, onCancel, before, after, preview, wide, seeThrough }) {
  if (openDialog) openDialog.close(false);
  const vals = Object.assign({}, values), defaults = Object.assign({}, values), inputs = {};
  const body = el('div', { class: 'dlg-body' });
  if (before) body.append(before);
  const fire = () => onChange && onChange(vals);
  for (const f of fields) {
    if (f.type === 'note') { body.append(el('p', { class: 'note', text: f.text })); continue; }
    if (f.type === 'heading') { body.append(el('h4', { text: f.text })); continue; }
    const id = 'f-' + f.key.replace(/\W/g, '-');
    const row = el('div', { class: 'field ' + f.type });
    const lab = el('label', { for: id, text: f.label, title: f.type === 'range' ? 'Double-click to reset' : null });
    row.append(lab);
    let inp;
    if (f.type === 'range') {
      const num = el('input', { type: 'number', id, min: f.min, max: f.max, step: f.step || 1, value: vals[f.key], 'aria-label': f.label });
      const rng = el('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: vals[f.key], 'aria-label': f.label, tabindex: -1 });
      const set = v => { v = U.clamp(+v, f.min, f.max); if (!Number.isFinite(v)) return; vals[f.key] = v; num.value = v; rng.value = v; fire(); };
      rng.addEventListener('input', () => set(rng.value)); num.addEventListener('change', () => set(num.value));
      lab.addEventListener('dblclick', () => set(defaults[f.key]));
      row.append(rng, num); if (f.unit) row.append(el('span', { class: 'unit', text: f.unit }));
      inp = { set };
    } else if (f.type === 'check') {
      const c = el('input', { type: 'checkbox', id, checked: !!vals[f.key] });
      c.addEventListener('change', () => { vals[f.key] = c.checked; fire(); });
      row.prepend(c); inp = { set: v => { c.checked = v; vals[f.key] = v; } };
    } else if (f.type === 'select') {
      const s = el('select', { id }, f.options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(vals[f.key]) })));
      s.addEventListener('change', () => { vals[f.key] = typeof f.options[0][0] === 'number' ? +s.value : s.value; fire(); });
      row.append(s); inp = { set: v => { s.value = v; vals[f.key] = v; } };
    } else if (f.type === 'textarea') {
      const t = el('textarea', { id, rows: 4, spellcheck: 'false' }); t.value = vals[f.key] || '';
      t.addEventListener('input', () => { vals[f.key] = t.value; fire(); });
      row.append(t); inp = { set: v => { t.value = v; vals[f.key] = v; }, focus: () => t.focus() };
    } else {
      const i = el('input', { id, type: f.type === 'color' ? 'color' : f.type === 'number' ? 'number' : 'text', min: f.min, max: f.max, step: f.step, value: vals[f.key] });
      i.addEventListener(f.type === 'text' ? 'input' : 'change', () => { vals[f.key] = f.type === 'number' ? +i.value : i.value; fire(); });
      if (f.type === 'color') i.addEventListener('input', () => { vals[f.key] = i.value; fire(); });
      row.append(i); if (f.unit) row.append(el('span', { class: 'unit', text: f.unit }));
      inp = { set: v => { i.value = v; vals[f.key] = v; }, focus: () => i.focus() };
    }
    inputs[f.key] = inp;
    body.append(row);
  }
  if (after) body.append(after);
  const foot = el('div', { class: 'dlg-foot' });
  if (preview) {
    const pv = el('input', { type: 'checkbox', checked: true, id: 'dlg-preview' });
    pv.addEventListener('change', () => preview(!pv.checked));
    foot.append(el('label', { class: 'preview-toggle', title: 'Uncheck to see the original (before/after)' }, pv, 'Preview'));
    const rs = el('button', { type: 'button', class: 'btn ghost', text: 'Reset', onclick: () => { for (const k in inputs) inputs[k].set(defaults[k]); fire(); } });
    foot.append(rs);
  }
  foot.append(el('span', { class: 'grow' }));
  if (cancel) foot.append(el('button', { type: 'button', class: 'btn ghost', text: cancel, onclick: () => close(false) }));
  const okBtn = ok ? el('button', { type: 'submit', class: 'btn primary', text: ok }) : null;
  if (okBtn) foot.append(okBtn);
  const form = el('form', { class: 'dlg' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'dlg-head' }, el('h3', { text: title }), el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: () => close(false) })),
    body, foot);
  form.addEventListener('submit', e => { e.preventDefault(); close(true); });
  const wrap = el('div', { class: 'dlg-wrap' + (preview || seeThrough ? ' see-through' : '') }, form);
  document.body.append(wrap);
  let closed = false;
  function close(accept) {
    if (closed) return; closed = true;
    wrap.remove(); if (openDialog === api) openDialog = null;
    if (accept) onOk && onOk(vals); else onCancel && onCancel(vals);
  }
  const api = { close, values: vals, inputs, root: form };
  openDialog = api;
  setTimeout(() => { const f = form.querySelector('textarea, input:not([type=range]):not([type=checkbox]), select, button'); f && f.focus(); }, 0);
  return api;
};
UI.confirm = (title, text, ok = 'OK') => new Promise(res => UI.dialog({ title, fields: [{ type: 'note', text }], ok, onOk: () => res(true), onCancel: () => res(false) }));

/* Filter / adjustment dialog with live, cancellable worker preview. */
function filterDialog(name, label, fields, values, map = v => v, extra) {
  if (!app().doc) return;
  const s = Ops().filterSession(name, label); if (!s) return;
  let raf = 0;
  const run = v => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => s.update(map(v))); };
  const dlg = UI.dialog({
    title: label, fields, values, preview: on => s.toggleOriginal(on),
    after: extra && extra(s, v => run(v)),
    onChange: run,
    onOk: v => { UI.busy(true, 'Applying…'); s.commit(map(v)).finally(() => UI.busy(false)); },
    onCancel: () => s.cancel()
  });
  run(dlg.values);
  return dlg;
}

const R = (key, label, min, max, step, unit) => ({ key, label, type: 'range', min, max, step, unit });
const ADJ = {
  brightness: ['Brightness/Contrast', [R('brightness', 'Brightness', -100, 100), R('contrast', 'Contrast', -100, 100)]],
  exposure: ['Exposure', [R('exposure', 'Exposure', -5, 5, 0.01, 'EV'), R('gamma', 'Gamma', 0.1, 5, 0.01)]],
  hsl: ['Hue/Saturation', [R('hue', 'Hue', -180, 180, 1, '°'), R('saturation', 'Saturation', -100, 100), R('vibrance', 'Vibrance', -100, 100)]],
  temp: ['Temperature/Tint', [R('temperature', 'Temperature', -100, 100), R('tint', 'Tint', -100, 100)]],
  tone: ['Shadows/Highlights', [R('shadows', 'Shadows', -100, 100), R('highlights', 'Highlights', -100, 100), R('blacks', 'Blacks', -100, 100), R('whites', 'Whites', -100, 100)]]
};
function adjustDialog(kind) {
  const [label, fields] = ADJ[kind], vals = {};
  for (const f of fields) vals[f.key] = PP.Pixel.ADJUST_DEFAULTS[f.key];
  filterDialog('adjust', label, fields, vals);
}
function colorBalanceDialog() {
  const fields = [], vals = {};
  for (const t of ['shadows', 'midtones', 'highlights']) {
    fields.push({ type: 'heading', text: t[0].toUpperCase() + t.slice(1) });
    [['r', 'Cyan ↔ Red'], ['g', 'Magenta ↔ Green'], ['b', 'Yellow ↔ Blue']].forEach(([c, l]) => { fields.push(R(t + '_' + c, l, -100, 100)); vals[t + '_' + c] = 0; });
  }
  filterDialog('adjust', 'Color Balance', fields, vals, v => ({ balance: { shadows: [v.shadows_r, v.shadows_g, v.shadows_b], midtones: [v.midtones_r, v.midtones_g, v.midtones_b], highlights: [v.highlights_r, v.highlights_g, v.highlights_b] } }));
}

function drawHistogram(cv, h, which = 'l') {
  const g = cv.getContext('2d'), W = cv.width, Hh = cv.height, a = h[which];
  let max = 1; for (let i = 0; i < 256; i++) if (a[i] > max) max = a[i];
  const lm = Math.log(max + 1);
  g.clearRect(0, 0, W, Hh); g.fillStyle = getComputedStyle(document.body).getPropertyValue('--fg-dim');
  for (let i = 0; i < 256; i++) { const v = (Math.log(a[i] + 1) / lm) * Hh; g.fillRect((i / 256) * W, Hh - v, W / 256 + 0.5, v); }
}
function levelsDialog() {
  let sess;
  const cv = el('canvas', { class: 'histogram', width: 256, height: 100 });
  filterDialog('adjust', 'Levels', [
    R('inBlack', 'Input black', 0, 254), R('gamma', 'Midtone gamma', 0.1, 9.99, 0.01), R('inWhite', 'Input white', 1, 255),
    R('outBlack', 'Output black', 0, 255), R('outWhite', 'Output white', 0, 255)
  ], { inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 },
  v => ({ levels: { inBlack: v.inBlack, inWhite: Math.max(v.inWhite, v.inBlack + 1), gamma: v.gamma, outBlack: v.outBlack, outWhite: v.outWhite } }),
  s => { sess = s; drawHistogram(cv, s.histogram()); return el('div', { class: 'hist-wrap' }, cv); });
  return sess;
}

/* Monotone cubic (Fritsch–Carlson) curve → 256-entry LUT. */
function curveLUT(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0]), n = p.length, lut = new Uint8ClampedArray(256);
  if (n < 2) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  const dx = [], s = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; s[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  m[0] = s[0]; m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]);
  for (let x = 0; x < 256; x++) {
    if (x <= p[0][0]) { lut[x] = p[0][1]; continue; }
    if (x >= p[n - 1][0]) { lut[x] = p[n - 1][1]; continue; }
    let i = 0; while (x > p[i + 1][0]) i++;
    const h = dx[i], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
    lut[x] = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
  }
  return lut;
}
function curvesDialog() {
  const curves = { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };
  let ch = 'rgb', hist = null, push = null, drag = -1;
  const cv = el('canvas', { class: 'curves', width: 256, height: 256, 'aria-label': 'Curve editor: click to add points, drag to move, drag out to remove' });
  const map = () => ({ curves: { rgb: curveLUT(curves.rgb), r: curveLUT(curves.r), g: curveLUT(curves.g), b: curveLUT(curves.b) } });
  const draw = () => {
    const g = cv.getContext('2d'), css = getComputedStyle(document.body);
    g.clearRect(0, 0, 256, 256);
    if (hist) { const a = hist[ch === 'rgb' ? 'l' : ch]; let mx = 1; for (const v of a) mx = Math.max(mx, v); g.fillStyle = css.getPropertyValue('--line'); for (let i = 0; i < 256; i++) { const v = (Math.log(a[i] + 1) / Math.log(mx + 1)) * 256; g.fillRect(i, 256 - v, 1, v); } }
    g.strokeStyle = css.getPropertyValue('--line'); g.beginPath(); for (let i = 64; i < 256; i += 64) { g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); } g.moveTo(0, 256); g.lineTo(256, 0); g.stroke();
    const lut = curveLUT(curves[ch]);
    g.strokeStyle = { rgb: css.getPropertyValue('--fg'), r: '#ff5a5a', g: '#4cd964', b: '#4aa3ff' }[ch]; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x < 256; x++) g[x ? 'lineTo' : 'moveTo'](x, 255 - lut[x]);
    g.stroke(); g.lineWidth = 1;
    for (const [x, y] of curves[ch]) { g.fillStyle = '#fff'; g.fillRect(x - 4, 255 - y - 4, 8, 8); g.strokeStyle = '#000'; g.strokeRect(x - 3.5, 255 - y - 3.5, 7, 7); }
  };
  const pos = e => { const r = cv.getBoundingClientRect(); return [U.clamp(Math.round(((e.clientX - r.left) / r.width) * 255), 0, 255), U.clamp(Math.round(255 - ((e.clientY - r.top) / r.height) * 255), 0, 255), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  cv.addEventListener('pointerdown', e => {
    const [x, y] = pos(e), pts = curves[ch];
    drag = pts.findIndex(p => Math.abs(p[0] - x) < 8 && Math.abs(p[1] - y) < 8);
    if (drag < 0) { pts.push([x, y]); drag = pts.length - 1; }
    cv.setPointerCapture(e.pointerId); draw(); push && push();
  });
  cv.addEventListener('pointermove', e => {
    if (drag < 0) return;
    const [x, y, fx, fy] = pos(e), pts = curves[ch], end = drag === 0 || drag === pts.length - 1;
    if (!end && pts.length > 2 && (fx < -0.1 || fx > 1.1 || fy < -0.1 || fy > 1.1)) { pts.splice(drag, 1); drag = -1; }
    else { const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255; pts[drag] = [U.clamp(x, lo, hi), y]; }
    draw(); push && push();
  });
  cv.addEventListener('pointerup', () => { drag = -1; });
  const sel = el('select', { 'aria-label': 'Channel' }, [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']].map(([v, t]) => el('option', { value: v, text: t })));
  sel.addEventListener('change', () => { ch = sel.value; draw(); });
  const dlg = filterDialog('adjust', 'Curves', [], {}, () => map(), (s, run) => { hist = s.histogram(); push = () => run({}); draw(); return el('div', { class: 'curves-wrap' }, sel, cv, el('p', { class: 'note', text: 'Click to add a point · drag to adjust · drag off the graph to remove' })); });
  return dlg;
}

const FILTER_DEFS = {
  gaussian: ['Gaussian Blur', [R('radius', 'Radius (σ)', 0.1, 250, 0.1, 'px')], { radius: 2 }],
  boxBlur: ['Box Blur', [R('radius', 'Radius', 1, 250, 1, 'px')], { radius: 3 }],
  median: ['Median', [R('radius', 'Radius', 1, 20, 1, 'px')], { radius: 1 }],
  motionBlur: ['Motion Blur', [R('angle', 'Angle', -180, 180, 1, '°'), R('distance', 'Distance', 1, 500, 1, 'px')], { angle: 0, distance: 15 }],
  sharpen: ['Sharpen', [R('amount', 'Amount', 0, 100, 1, '%')], { amount: 50 }],
  unsharp: ['Unsharp Mask', [R('amount', 'Amount', 1, 500, 1, '%'), R('radius', 'Radius', 0.1, 100, 0.1, 'px'), R('threshold', 'Threshold', 0, 255)], { amount: 100, radius: 1.5, threshold: 0 }],
  emboss: ['Emboss', [R('strength', 'Strength', 0.1, 5, 0.1)], { strength: 1 }],
  posterize: ['Posterize', [R('levels', 'Levels', 2, 32)], { levels: 4 }],
  pixelate: ['Pixelate', [R('size', 'Cell size', 2, 200, 1, 'px')], { size: 10 }],
  vignette: ['Vignette', [R('amount', 'Amount', -100, 100, 1, '%'), R('size', 'Size', 0, 99, 1, '%')], { amount: 50, size: 50 }],
  noise: ['Add Noise', [R('amount', 'Amount', 0, 100, 1, '%'), { key: 'mono', label: 'Monochromatic', type: 'check' }, R('seed', 'Seed', 1, 9999)], { amount: 15, mono: true, seed: 1 }]
};
function filterFromDef(id) { const [label, fields, vals] = FILTER_DEFS[id]; filterDialog(id, label, fields, Object.assign({}, vals)); }

function chromaKeyDialog() {
  const prevBg = app().view.bg;
  const setBg = v => { app().view.bg = v === 'checker' ? 'checker' : v; app().view.request(true); };
  const d = filterDialog('chromaKey', 'Chroma Key', [
    { key: 'key', label: 'Key colour', type: 'color' }, R('tolerance', 'Tolerance', 0, 255), R('softness', 'Edge softness', 0, 255), R('spill', 'Spill suppression', 0, 100, 1, '%'),
    { key: 'bg', label: 'Preview on', type: 'select', options: [['checker', 'Checkerboard'], ['#000000', 'Black'], ['#ffffff', 'White'], ['#00a0ff', 'Blue']] }
  ], { key: '#00ff00', tolerance: 60, softness: 40, spill: 50, bg: 'checker' }, v => { setBg(v.bg); return { key: U.hexToRgb(v.key), tolerance: v.tolerance, softness: v.softness, spill: v.spill }; });
  if (!d) return;
  const restore = () => { app().view.bg = prevBg; app().view.request(true); };
  const oc = d.close; d.close = a => { oc(a); restore(); };
  d.root.addEventListener('submit', restore); d.root.querySelectorAll('.dlg-head button, .dlg-foot .btn.ghost').forEach(b => b.addEventListener('click', restore));
}

/* text dialog */
const FONTS = ['system-ui, sans-serif', 'Arial, Helvetica, sans-serif', 'Georgia, serif', '"Times New Roman", serif', '"Courier New", monospace', 'Verdana, sans-serif', 'Impact, sans-serif', '"Trebuchet MS", sans-serif', 'cursive', 'fantasy'];
UI.textDialog = function (layer, isNew) {
  const before = Object.assign({}, layer.text), live = Object.assign({}, layer.text);
  const apply = v => {
    Object.assign(live, v, { size: +v.size, weight: +v.weight, lineHeight: +v.lineHeight, letterSpacing: +v.letterSpacing, strokeWidth: +v.strokeWidth, shadowBlur: +v.shadowBlur, shadowX: +v.shadowX, shadowY: +v.shadowY, rotation: +v.rotation });
    layer.text = Object.assign({}, live);
    try { PP.Model.renderText(layer); } catch (e) { UI.toast(e.message, 'error'); }
  };
  const fontOpts = FONTS.includes(before.font) ? FONTS : [before.font, ...FONTS];
  UI.dialog({
    title: isNew ? 'Add Text' : 'Edit Text', wide: true, seeThrough: true, values: Object.assign({}, before),
    fields: [
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'font', label: 'Font', type: 'select', options: fontOpts.map(f => [f, f.split(',')[0].replace(/"/g, '')]) },
      R('size', 'Size', 4, 1000, 1, 'px'),
      { key: 'weight', label: 'Weight', type: 'select', options: [[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']] },
      { key: 'italic', label: 'Italic', type: 'check' }, { key: 'underline', label: 'Underline', type: 'check' },
      { key: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
      R('lineHeight', 'Line height', 0.5, 4, 0.05), R('letterSpacing', 'Letter spacing', -20, 100, 0.5, 'px'),
      { key: 'fill', label: 'Fill', type: 'color' },
      { key: 'strokeColor', label: 'Outline', type: 'color' }, R('strokeWidth', 'Outline width', 0, 50, 0.5, 'px'),
      { key: 'shadowColor', label: 'Shadow', type: 'color' }, R('shadowBlur', 'Shadow blur', 0, 100, 1, 'px'), R('shadowX', 'Shadow X', -100, 100, 1, 'px'), R('shadowY', 'Shadow Y', -100, 100, 1, 'px'),
      R('rotation', 'Rotation', -180, 180, 1, '°')
    ],
    onChange: apply,
    onOk: v => {
      apply(v);
      const after = Object.assign({}, layer.text);
      layer.text = Object.assign({}, before); // record an undoable change from the pre-dialog state
      Ops().updateText(layer, before, after);
      if (isNew) { const o = app().opts.text; for (const k of ['font', 'size', 'weight', 'italic', 'align']) o[k] = after[k]; IO().savePrefs(); }
    },
    onCancel: () => {
      if (isNew) { const h = app().history; h.undo(); h.stack.splice(h.index + 1); bus.emit('history'); }
      else { layer.text = before; PP.Model.renderText(layer); }
    }
  });
};

/* misc dialogs */
function newDocDialog() {
  const presets = [['custom', 'Custom'], ['1920x1080', 'Full HD 1920×1080'], ['1280x720', 'HD 1280×720'], ['3840x2160', '4K 3840×2160'], ['1080x1080', 'Square 1080'], ['2480x3508', 'A4 @300dpi'], ['800x600', '800×600']];
  const dlg = UI.dialog({
    title: 'New Document', ok: 'Create', values: { name: 'Untitled', preset: 'custom', width: 1280, height: 720, bg: 'white' },
    fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'preset', label: 'Preset', type: 'select', options: presets },
      { key: 'width', label: 'Width', type: 'number', min: 1, max: PP.Config.MAX_SIDE, unit: 'px' }, { key: 'height', label: 'Height', type: 'number', min: 1, max: PP.Config.MAX_SIDE, unit: 'px' },
      { key: 'bg', label: 'Background', type: 'select', options: [['white', 'White'], ['transparent', 'Transparent'], ['bgcolor', 'Background colour']] }],
    onChange: v => { if (v.preset !== 'custom') { const [w, h] = v.preset.split('x').map(Number); dlg.inputs.width.set(w); dlg.inputs.height.set(h); dlg.inputs.preset.set('custom'); } },
    onOk: v => { const w = Math.round(v.width), h = Math.round(v.height); if (!U.validSize(w, h)) return UI.toast('Invalid size', 'error'); PP.App.newDocument(w, h, v.bg, v.name || 'Untitled'); }
  });
}
function imageSizeDialog() {
  const d = app().doc, ratio = d.width / d.height;
  const dlg = UI.dialog({
    title: 'Image Size', values: { width: d.width, height: d.height, lock: true, smooth: 'smooth' },
    fields: [{ key: 'width', label: 'Width', type: 'number', min: 1, unit: 'px' }, { key: 'height', label: 'Height', type: 'number', min: 1, unit: 'px' }, { key: 'lock', label: 'Constrain proportions', type: 'check' },
      { key: 'smooth', label: 'Resample', type: 'select', options: [['smooth', 'Smooth (bicubic-quality)'], ['nearest', 'Nearest neighbour (hard edges)']] }],
    onChange: v => { if (!v.lock) return; const a = document.activeElement && document.activeElement.id; if (a === 'f-width') dlg.inputs.height.set(Math.max(1, Math.round(v.width / ratio))); else if (a === 'f-height') dlg.inputs.width.set(Math.max(1, Math.round(v.height * ratio))); },
    onOk: v => Ops().imageSize(Math.round(v.width), Math.round(v.height), v.smooth === 'smooth')
  });
}
function canvasSizeDialog() {
  const d = app().doc;
  let ax = 0.5, ay = 0.5;
  const grid = el('div', { class: 'anchor', role: 'radiogroup', 'aria-label': 'Anchor' });
  const paint = () => grid.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.x === ax && +b.dataset.y === ay));
  for (const y of [0, 0.5, 1]) for (const x of [0, 0.5, 1]) grid.append(el('button', { type: 'button', 'data-x': x, 'data-y': y, 'aria-label': `Anchor ${x},${y}`, onclick: () => { ax = x; ay = y; paint(); } }));
  paint();
  UI.dialog({
    title: 'Canvas Size', values: { width: d.width, height: d.height },
    fields: [{ key: 'width', label: 'Width', type: 'number', min: 1, unit: 'px' }, { key: 'height', label: 'Height', type: 'number', min: 1, unit: 'px' }],
    after: el('div', { class: 'field' }, el('label', { text: 'Anchor' }), grid),
    onOk: v => Ops().canvasSize(Math.round(v.width), Math.round(v.height), ax, ay)
  });
}
function exportDialog() {
  const d = app().doc; if (!d) return;
  const prefs = app().opts.export, hasSel = d.selection.active;
  const size = scope => { if (scope === 'layer') return [d.active.w, d.active.h]; if (scope === 'selection' && hasSel) { const b = d.selection.bounds; return [b.w, b.h]; } return [d.width, d.height]; };
  const [w0, h0] = size('flat');
  let ratio = w0 / h0;
  const fmts = [['png', 'PNG (lossless, transparency)'], ['jpeg', 'JPEG']]; if (IO().supports.webp) fmts.push(['webp', 'WebP']);
  const dlg = UI.dialog({
    title: 'Export Image', ok: 'Export',
    values: { name: d.name, format: prefs.format, quality: prefs.quality, scope: 'flat', width: w0, height: h0, bg: '#ffffff' },
    fields: [{ key: 'name', label: 'File name', type: 'text' }, { key: 'format', label: 'Format', type: 'select', options: fmts }, R('quality', 'Quality', 1, 100, 1, '%'),
      { key: 'scope', label: 'Content', type: 'select', options: [['flat', 'Entire image (flattened)'], ['layer', 'Active layer'], ...(hasSel ? [['selection', 'Selection only']] : [])] },
      { key: 'width', label: 'Width', type: 'number', min: 1, unit: 'px' }, { key: 'height', label: 'Height', type: 'number', min: 1, unit: 'px' },
      { key: 'bg', label: 'JPEG background', type: 'color' }],
    onChange: v => {
      const a = document.activeElement && document.activeElement.id;
      if (a === 'f-scope') { const [w, h] = size(v.scope); ratio = w / h; dlg.inputs.width.set(w); dlg.inputs.height.set(h); }
      else if (a === 'f-width') dlg.inputs.height.set(Math.max(1, Math.round(v.width / ratio)));
      else if (a === 'f-height') dlg.inputs.width.set(Math.max(1, Math.round(v.height * ratio)));
    },
    onOk: v => { prefs.format = v.format; prefs.quality = v.quality; IO().savePrefs(); IO().exportImage({ name: v.name, format: v.format, quality: v.quality / 100, scope: v.scope, width: Math.round(v.width), height: Math.round(v.height), bg: v.bg }); }
  });
}
function numberDialog(title, label, value, min, max, unit, fn) {
  UI.dialog({ title, values: { v: value }, fields: [{ key: 'v', label, type: 'number', min, max, step: 0.5, unit }], onOk: v => fn(U.clamp(+v.v, min, max)) });
}
function colorRangeDialog() {
  const c = U.hexToRgb(app().colors.fg);
  UI.dialog({
    title: 'Color Range', values: { color: app().colors.fg, tolerance: app().opts.range.tolerance, fuzziness: app().opts.range.fuzziness, mode: 'replace' },
    fields: [{ key: 'color', label: 'Colour', type: 'color' }, R('tolerance', 'Tolerance', 0, 255), R('fuzziness', 'Fuzziness', 0, 255),
      { key: 'mode', label: 'Mode', type: 'select', options: [['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']] }, { type: 'note', text: 'Selects every pixel of a similar colour (non-contiguous). Distance: premultiplied RGBA Euclidean.' }],
    onOk: v => { const rgb = U.hexToRgb(v.color); Ops().colorRange([rgb[0], rgb[1], rgb[2], 255], v.tolerance, v.fuzziness, v.mode); void c; }
  });
}
async function recoveryDialog(auto) {
  let list = [];
  try { list = await IO().listSaved(); } catch (e) { if (!auto) UI.toast('Local storage unavailable: ' + e.message, 'error'); return; }
  const cur = app().doc && app().doc.id;
  list = list.filter(r => r.id !== cur);
  if (!list.length) { if (!auto) UI.toast('No locally saved documents'); return; }
  const box = el('div', { class: 'recover-list' });
  const urls = [];
  const render = () => {
    box.replaceChildren();
    for (const r of list) {
      let img = null;
      if (r.thumb instanceof Blob) { const u = URL.createObjectURL(r.thumb); urls.push(u); img = el('img', { src: u, alt: '' }); }
      box.append(el('div', { class: 'recover-item' }, img || el('div', { class: 'thumb-ph' }),
        el('div', { class: 'grow' }, el('strong', { text: r.name }), el('small', { text: `${r.width} × ${r.height} · ${new Date(r.updatedAt).toLocaleString()}` })),
        el('button', { type: 'button', class: 'btn primary', text: 'Open', onclick: () => { dlg.close(false); IO().restore(r.id).catch(e => UI.toast(e.message, 'error')); } }),
        el('button', { type: 'button', class: 'btn ghost', text: 'Delete', onclick: async () => {
          if (!(await UI.confirm('Delete saved copy?', `“${r.name}” will be permanently removed from this browser. This may be the only copy.`, 'Delete'))) { recoveryDialog(false); return; }
          await IO().deleteSaved(r.id); recoveryDialog(false);
        } })));
    }
  };
  render();
  const dlg = UI.dialog({
    title: auto ? 'Recover previous work?' : 'Locally saved documents', ok: null, cancel: auto ? 'Start fresh' : 'Close', wide: true,
    fields: [{ type: 'note', text: auto ? 'PixelPaint found documents autosaved in this browser. Saved copies are kept until you delete them.' : 'Autosaved in this browser’s storage. Browser storage can be cleared — export a .pforge backup for important work.' }],
    after: box, onCancel: () => urls.forEach(u => URL.revokeObjectURL(u))
  });
}
async function storageDialog() {
  const s = await IO().storageInfo();
  const txt = [`Persistent storage: ${s.persisted == null ? 'unknown' : s.persisted ? 'granted' : 'not granted (browser may evict data under pressure)'}`,
    `Used: ${s.usage == null ? 'unknown' : U.formatBytes(s.usage)} of ${s.quota == null ? 'unknown' : U.formatBytes(s.quota)}`,
    'Browser storage is not a permanent backup. Use File → Save Project (.pforge) for important work.'];
  UI.dialog({ title: 'Storage', ok: 'Request persistence', fields: txt.map(t => ({ type: 'note', text: t })), onOk: async () => UI.toast((await IO().requestPersist()) ? 'Persistent storage granted' : 'Browser declined persistent storage', 'info') });
}
function shortcutsDialog() {
  const rows = [['Open', MOD + 'O'], ['Save project', MOD + 'S'], ['Export', MOD + 'Shift+S'], ['Undo / Redo', `${MOD}Z / ${MOD}Y, ${MOD}Shift+Z`], ['Cut / Copy / Paste', `${MOD}X / ${MOD}C / ${MOD}V`], ['Copy merged', MOD + 'Shift+C'],
    ['Select all / Deselect / Invert', `${MOD}A / ${MOD}D / ${MOD}Shift+I`], ['Free transform', MOD + 'T'], ['Copy selection to layer', MOD + 'J'], ['New layer', MOD + 'Shift+N'],
    ['Fit / 100% / Zoom ±', `${MOD}0 / ${MOD}1 / ${MOD}+ ${MOD}−`], ['Pan', 'Space+drag, middle mouse, wheel, two fingers'], ['Zoom at cursor', 'Ctrl/Alt+wheel, pinch'],
    ['Brush size', '[ / ]'], ['Swap / reset colours', 'X / D'], ['Delete selected pixels', 'Delete'], ['Cancel operation', 'Esc'],
    ['Selection modifiers', 'Shift add · Alt subtract · Shift+Alt intersect'], ...PP.Tools.list.filter(t => t.key).map(t => [t.name, t.key.toUpperCase()])];
  const tbl = el('table', { class: 'keys' }, rows.map(([a, b]) => el('tr', null, el('td', { text: a }), el('td', null, el('kbd', { text: b })))));
  UI.dialog({ title: 'Keyboard Shortcuts', ok: null, cancel: 'Close', after: tbl, wide: true });
}
function aboutDialog() {
  UI.dialog({ title: 'About PixelPaint', ok: null, cancel: 'Close', fields: [
    { type: 'note', text: 'PixelPaint 1.0 — a manual-first, algorithm-driven image editor. Plain HTML, CSS and JavaScript; no frameworks, no build step.' },
    { type: 'note', text: 'Zero AI: no machine learning, no LLMs, no generative models, no remote inference. Selections come from your own geometry; tools such as Magic Wand, Color Range, Magnetic Lasso and Healing use classical, deterministic algorithms (colour distance, scanline flood fill, Sobel gradients, mean-colour blending) and do not recognise objects.' },
    { type: 'note', text: 'Privacy: images are processed and stored only in this browser. Nothing is uploaded; there is no telemetry.' }] });
}

/* ───────────── menus ───────────── */
function needDoc(fn) { return (...a) => (app().doc ? fn(...a) : UI.toast('Open or create a document first', 'warn')); }
function menus() {
  const O = Ops(), I = IO(), v = () => app().view, h = () => app().history, T = id => () => app().tools.select(id);
  const F = f => needDoc(() => filterFromDef(f)), A = k => needDoc(() => adjustDialog(k));
  return [
    ['File', [['New…', MOD + 'N', newDocDialog], ['Open…', MOD + 'O', () => I.pickFiles({ newDoc: true })], ['Place Image as Layer…', '', needDoc(() => I.pickFiles())], ['Recover / Local Documents…', '', () => recoveryDialog(false)], '-',
      ['Save Project (.pforge)', MOD + 'S', needDoc(() => I.saveProject())], ['Export Image…', MOD + 'Shift+S', needDoc(exportDialog)], ['Quick Export PNG', '', needDoc(() => I.exportImage({ format: 'png', scope: 'flat' }))], '-', ['Storage…', '', storageDialog]]],
    ['Edit', [['Undo', MOD + 'Z', () => { app().tools.cancel(); h().undo(); }, () => h().canUndo], ['Redo', MOD + 'Y', () => { app().tools.cancel(); h().redo(); }, () => h().canRedo], '-',
      ['Cut', MOD + 'X', needDoc(() => O.copy(false, true))], ['Copy', MOD + 'C', needDoc(() => O.copy(false))], ['Copy Merged', MOD + 'Shift+C', needDoc(() => O.copy(true))], ['Paste', MOD + 'V', needDoc(() => O.pasteInternal() || UI.toast('Use ' + MOD + 'V to paste from the system clipboard'))], '-',
      ['Fill with Foreground', '', needDoc(() => O.fillSelection('fg'))], ['Fill with Background', '', needDoc(() => O.fillSelection('bg'))], ['Stroke Selection…', '', needDoc(() => numberDialog('Stroke Selection', 'Width', 2, 0.5, 200, 'px', w => O.strokeSelection(w)))], ['Clear', 'Delete', needDoc(() => O.clearLayer())], '-',
      ['Free Transform', MOD + 'T', needDoc(T('transform'))], ['Flip Layer Horizontal', '', needDoc(() => O.flipLayer(true))], ['Flip Layer Vertical', '', needDoc(() => O.flipLayer(false))]]],
    ['Image', [['Image Size…', '', needDoc(imageSizeDialog)], ['Canvas Size…', '', needDoc(canvasSizeDialog)], ['Crop to Selection', '', needDoc(() => O.cropToSelection())], ['Trim Transparent', '', needDoc(() => O.trim())], '-',
      ['Rotate 90° CW', '', needDoc(() => O.rotateImage('cw'))], ['Rotate 90° CCW', '', needDoc(() => O.rotateImage('ccw'))], ['Rotate 180°', '', needDoc(() => O.rotateImage('180'))], ['Flip Canvas Horizontal', '', needDoc(() => O.rotateImage('flipH'))], ['Flip Canvas Vertical', '', needDoc(() => O.rotateImage('flipV'))], '-',
      ['Chroma Key…', '', needDoc(chromaKeyDialog)]]],
    ['Layer', [['New Layer', MOD + 'Shift+N', needDoc(() => O.newLayer())], ['Duplicate Layer', '', needDoc(() => O.duplicateLayer())], ['Delete Layer', '', needDoc(() => O.deleteLayer())], '-',
      ['Copy Selection to New Layer', MOD + 'J', needDoc(() => O.copySelectionToLayer(false))], ['Cut Selection to New Layer', MOD + 'Shift+J', needDoc(() => O.copySelectionToLayer(true))], '-',
      ['Add Mask: Reveal All', '', needDoc(() => O.addMask('reveal'))], ['Add Mask: Hide All', '', needDoc(() => O.addMask('hide'))], ['Add Mask from Selection', '', needDoc(() => O.addMask('selection'))], ['Apply Mask', '', needDoc(() => O.applyMask())], ['Delete Mask', '', needDoc(() => O.deleteMask())], ['Load Mask as Selection', '', needDoc(() => O.maskToSelection())], '-',
      ['Rasterize Text', '', needDoc(() => app().doc.active && O.rasterize(app().doc.active))], ['Merge Down', '', needDoc(() => O.mergeDown())], ['Merge Visible', '', needDoc(() => O.mergeVisible())], ['Flatten Image', '', needDoc(() => O.flatten())]]],
    ['Select', [['All', MOD + 'A', needDoc(() => O.selectAll())], ['Deselect', MOD + 'D', needDoc(() => O.deselect())], ['Invert', MOD + 'Shift+I', needDoc(() => O.invertSelection())], ['Load Layer Transparency', '', needDoc(() => O.selectionFromAlpha())], ['Color Range…', '', needDoc(colorRangeDialog)], '-',
      ['Feather…', '', needDoc(() => numberDialog('Feather Selection', 'Radius', 5, 0.5, 250, 'px', r => O.refine('feather', r)))], ['Expand…', '', needDoc(() => numberDialog('Expand Selection', 'By', 2, 0.5, 500, 'px', r => O.refine('expand', r)))],
      ['Contract…', '', needDoc(() => numberDialog('Contract Selection', 'By', 2, 0.5, 500, 'px', r => O.refine('contract', r)))], ['Smooth…', '', needDoc(() => numberDialog('Smooth Selection', 'Radius', 3, 0.5, 100, 'px', r => O.refine('smooth', r)))], ['Border…', '', needDoc(() => numberDialog('Border Selection', 'Width', 4, 1, 500, 'px', r => O.refine('border', r)))], '-',
      ['Remove Outside (cut out)', '', needDoc(() => O.removeByMask(true))], ['Remove Inside', 'Delete', needDoc(() => O.removeByMask(false))], '-',
      ['Save Selection', '', needDoc(() => O.saveSelection())], ['Load Selection…', '', needDoc(loadSelectionDialog)], ['Toggle Quick Mask View', '', needDoc(toggleQuickMask)]]],
    ['Adjustments', [['Brightness/Contrast…', '', A('brightness')], ['Exposure/Gamma…', '', A('exposure')], ['Levels…', '', needDoc(levelsDialog)], ['Curves…', '', needDoc(curvesDialog)], ['Shadows/Highlights…', '', A('tone')], '-',
      ['Hue/Saturation…', '', A('hsl')], ['Temperature/Tint…', '', A('temp')], ['Color Balance…', '', needDoc(colorBalanceDialog)], '-',
      ['Grayscale', '', needDoc(() => O.applyFilter('grayscale', {}, 'Grayscale'))], ['Invert', '', needDoc(() => O.applyFilter('invert', {}, 'Invert'))], ['Sepia', '', needDoc(() => O.applyFilter('sepia', {}, 'Sepia'))]]],
    ['Filters', [['Gaussian Blur…', '', F('gaussian')], ['Box Blur…', '', F('boxBlur')], ['Median…', '', F('median')], ['Motion Blur…', '', F('motionBlur')], '-',
      ['Sharpen…', '', F('sharpen')], ['Unsharp Mask…', '', F('unsharp')], '-',
      ['Edge Detect', '', needDoc(() => O.applyFilter('edges', {}, 'Edge Detect'))], ['Sobel Edges', '', needDoc(() => O.applyFilter('sobel', {}, 'Sobel'))], ['Emboss…', '', F('emboss')], '-',
      ['Posterize…', '', F('posterize')], ['Pixelate…', '', F('pixelate')], ['Vignette…', '', F('vignette')], ['Add Noise…', '', F('noise')]]],
    ['View', [['Zoom In', MOD + '+', needDoc(() => v().step(1))], ['Zoom Out', MOD + '−', needDoc(() => v().step(-1))], ['Fit on Screen', MOD + '0', needDoc(() => v().fit())], ['Actual Pixels', MOD + '1', needDoc(() => v().actual())], '-',
      ['Pixel Grid (≥800%)', '', () => { v().showGrid = !v().showGrid; v().requestOverlay(); IO().savePrefs(); }], ['Transparency: Checkerboard', '', () => setBg('checker')], ['Transparency: White', '', () => setBg('#ffffff')], ['Transparency: Black', '', () => setBg('#000000')], '-',
      ['Toggle Panels', 'Tab', togglePanels]]],
    ['Help', [['Keyboard Shortcuts', '?', shortcutsDialog], ['Storage…', '', storageDialog], ['About PixelPaint', '', aboutDialog]]]
  ];
}
function setBg(c) { app().view.bg = c; app().view.request(true); IO().savePrefs(); }
function toggleQuickMask() { app().quickMaskSticky = !app().quickMaskSticky; app().quickMask = app().quickMaskSticky || (app().tools.current && app().tools.current.id === 'mask-brush'); app().view.requestOverlay(); }
function togglePanels() { document.body.classList.toggle('panels-hidden'); app().view.resize(); }
function loadSelectionDialog() {
  const s = app().doc.saved || [];
  if (!s.length) return UI.toast('No saved selections', 'warn');
  UI.dialog({ title: 'Load Selection', values: { i: 0, mode: 'replace' }, fields: [{ key: 'i', label: 'Selection', type: 'select', options: s.map((x, i) => [i, x.name]) }, { key: 'mode', label: 'Mode', type: 'select', options: [['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']] }],
    onOk: v => Ops().loadSelection(+v.i, v.mode) });
}

function buildMenubar() {
  const bar = $('#menubar'); bar.replaceChildren();
  let open = null;
  const closeAll = () => { if (open) { open.classList.remove('open'); open.querySelector('button').setAttribute('aria-expanded', 'false'); open = null; } };
  for (const [name, items] of menus()) {
    const list = el('div', { class: 'menu-list', role: 'menu' });
    const btn = el('button', { type: 'button', class: 'menu-btn', text: name, 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    const m = el('div', { class: 'menu' }, btn, list);
    const fill = () => {
      list.replaceChildren();
      for (const it of items) {
        if (it === '-') { list.append(el('div', { class: 'sep', role: 'separator' })); continue; }
        const [label, key, fn, enabled] = it, dis = enabled && !enabled();
        list.append(el('button', { type: 'button', role: 'menuitem', class: 'menu-item', disabled: dis, onclick: () => { closeAll(); fn(); } }, el('span', { text: label }), el('kbd', { text: key || '' })));
      }
    };
    btn.addEventListener('click', e => { e.stopPropagation(); const was = open === m; closeAll(); if (!was) { fill(); m.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); open = m; const r = btn.getBoundingClientRect(); list.style.left = Math.min(r.left, window.innerWidth - 260) + 'px'; list.style.top = r.bottom + 'px'; } });
    btn.addEventListener('pointerenter', () => { if (open && open !== m) btn.click(); });
    bar.append(m);
  }
  document.addEventListener('pointerdown', e => { if (open && !open.contains(e.target)) closeAll(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { closeAll(); e.stopPropagation(); } }, true);
  bar.append(el('span', { class: 'grow' }), el('button', { type: 'button', class: 'icon-btn panel-toggle', 'aria-label': 'Toggle panels', title: 'Toggle panels (Tab)', onclick: togglePanels }, icon('M3 4h18v16H3zM15 4v16')));
}

/* ───────────── toolbar & colours ───────────── */
function buildToolbar() {
  const tb = $('#toolbar'); tb.replaceChildren();
  const groups = [['move', 'hand', 'zoom'], ['rect-select', 'ellipse-select', 'lasso', 'poly-lasso', 'magnetic-lasso', 'wand', 'color-range', 'mask-brush'], ['brush', 'pencil', 'eraser', 'fill', 'picker', 'clone', 'heal'], ['crop', 'text', 'line', 'arrow', 'rect', 'rrect', 'ellipse', 'polygon']];
  for (const g of groups) {
    const box = el('div', { class: 'tool-group', role: 'group' });
    for (const id of g) {
      const t = PP.Tools.list.find(x => x.id === id);
      box.append(el('button', { type: 'button', class: 'tool', 'data-tool': id, title: t.name + (t.key ? ` (${t.key.toUpperCase()})` : ''), 'aria-label': t.name, 'aria-pressed': 'false', onclick: () => app().tools.select(id) }, icon(t.icon)));
    }
    tb.append(box);
  }
  const fgI = el('input', { type: 'color', 'aria-label': 'Foreground colour' }), bgI = el('input', { type: 'color', 'aria-label': 'Background colour' });
  fgI.addEventListener('input', () => Ops().setColor('fg', fgI.value)); bgI.addEventListener('input', () => Ops().setColor('bg', bgI.value));
  const sw = el('div', { class: 'swatches' },
    el('label', { class: 'sw bg', title: 'Background colour' }, bgI), el('label', { class: 'sw fg', title: 'Foreground colour' }, fgI),
    el('button', { type: 'button', class: 'mini swap', title: 'Swap (X)', 'aria-label': 'Swap colours', text: '⇄', onclick: () => Ops().swapColors() }),
    el('button', { type: 'button', class: 'mini reset', title: 'Reset (D)', 'aria-label': 'Reset colours', text: '◩', onclick: () => Ops().resetColors() }));
  tb.append(sw);
  const paint = () => { const c = app().colors; fgI.value = c.fg; bgI.value = c.bg; fgI.parentNode.style.background = c.fg; bgI.parentNode.style.background = c.bg; };
  bus.on('colors', () => { paint(); IO().savePrefs(); }); paint();
  bus.on('tool', t => { tb.querySelectorAll('.tool').forEach(b => { const on = b.dataset.tool === t.id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); });
}

/* ───────────── options bar (contextual) ───────────── */
function buildOptions(tool) {
  const bar = $('#options'); bar.replaceChildren();
  bar.append(el('strong', { class: 'tool-name', text: tool.name }));
  const o = app().opts, refreshers = [];
  for (const d of tool.options || []) {
    if (d.type === 'note') { bar.append(el('span', { class: 'note', text: d.text })); continue; }
    if (d.type === 'button') { bar.append(el('button', { type: 'button', class: 'btn small', text: d.label, onclick: d.action })); continue; }
    const wrap = el('label', { class: 'opt ' + d.type }, el('span', { text: d.label }));
    const changed = v => { setPath(o, d.key, v); IO().savePrefs(); tool.optionChanged && tool.optionChanged(d.key); app().view.requestOverlay(); };
    if (d.type === 'range') {
      const toS = v => (d.log ? (Math.log(v / d.min) / Math.log(d.max / d.min)) * 1000 : v), fromS = s => (d.log ? Math.round(d.min * Math.pow(d.max / d.min, s / 1000)) : +s);
      const r = el('input', { type: 'range', min: d.log ? 0 : d.min, max: d.log ? 1000 : d.max, step: d.log ? 1 : d.step || 1, 'aria-label': d.label });
      const n = el('input', { type: 'number', min: d.min, max: d.max, step: d.step || 1, 'aria-label': d.label });
      const show = () => { const v = getPath(o, d.key); r.value = toS(v); n.value = v; };
      r.addEventListener('input', () => { const v = fromS(r.value); n.value = v; changed(v); });
      n.addEventListener('change', () => { const v = U.clamp(+n.value, d.min, d.max); if (Number.isFinite(v)) { changed(v); show(); } });
      show(); refreshers.push(show);
      wrap.append(r, n); if (d.unit) wrap.append(el('span', { class: 'unit', text: d.unit }));
    } else if (d.type === 'check') {
      const c = el('input', { type: 'checkbox', checked: !!getPath(o, d.key) });
      c.addEventListener('change', () => changed(c.checked)); wrap.prepend(c);
      refreshers.push(() => { c.checked = !!getPath(o, d.key); });
    } else if (d.type === 'select') {
      const s = el('select', null, d.options.map(([v, t]) => el('option', { value: v, text: t })));
      s.value = getPath(o, d.key);
      s.addEventListener('change', () => changed(typeof d.options[0][0] === 'number' ? +s.value : s.value)); wrap.append(s);
      refreshers.push(() => { s.value = getPath(o, d.key); });
    } else if (d.type === 'number') {
      const n = el('input', { type: 'number', step: 'any', value: getPath(o, d.key) });
      n.addEventListener('change', () => changed(+n.value)); wrap.append(n);
      refreshers.push(() => { if (document.activeElement !== n) n.value = getPath(o, d.key); });
    }
    bar.append(wrap);
  }
  UI.refreshOptions = () => refreshers.forEach(f => f());
}

/* ───────────── panels ───────────── */
function section(id, title, body, actions) {
  const open = app().panels[id] !== false;
  const head = el('button', { type: 'button', class: 'sec-head', 'aria-expanded': String(open) }, el('span', { text: title }));
  const s = el('section', { class: 'panel-sec' + (open ? '' : ' closed'), id: 'sec-' + id }, el('div', { class: 'sec-bar' }, head, actions || null), el('div', { class: 'sec-body' }, body));
  head.addEventListener('click', () => { const o = s.classList.toggle('closed'); head.setAttribute('aria-expanded', String(!o)); app().panels[id] = !o; IO().savePrefs(); });
  return s;
}

function buildLayersPanel() {
  const list = el('ul', { class: 'layers', role: 'listbox', 'aria-label': 'Layers' });
  const blend = el('select', { 'aria-label': 'Blend mode' }, Object.keys(PP.Model.BLEND).map(k => el('option', { value: k, text: k.replace('-', ' ').replace(/^./, c => c.toUpperCase()) })));
  const op = el('input', { type: 'range', min: 0, max: 100, 'aria-label': 'Layer opacity' }), opN = el('span', { class: 'unit' });
  let opStart = null;
  blend.addEventListener('change', () => { const l = app().doc.active; if (l) Ops().setLayerProps(l, { blend: blend.value }, 'Blend Mode'); });
  op.addEventListener('input', () => { const l = app().doc.active; if (!l) return; if (opStart == null) opStart = l.opacity; l.opacity = op.value / 100; opN.textContent = op.value + '%'; bus.emit('pixels', { rect: null }); });
  op.addEventListener('change', () => { const l = app().doc.active; if (!l || opStart == null) return; const v = op.value / 100; l.opacity = opStart; opStart = null; Ops().setLayerProps(l, { opacity: v }, 'Layer Opacity'); });
  const B = (label, d, fn) => el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick: needDoc(fn) }, icon(d, 18));
  const O = Ops();
  const foot = el('div', { class: 'layer-actions' },
    B('New layer', 'M12 5v14M5 12h14', () => O.newLayer()), B('Duplicate layer', 'M8 8h12v12H8zM4 16V4h12', () => O.duplicateLayer()),
    B('Add mask (from selection if any)', 'M4 4h16v16H4zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8', () => O.addMask(app().doc.selection.active ? 'selection' : 'reveal')),
    B('Move layer up', 'M12 19V5M6 11l6-6 6 6', () => { const d = app().doc, l = d.active; l && O.moveLayer(l, d.index(l) + 1); }),
    B('Move layer down', 'M12 5v14M6 13l6 6 6-6', () => { const d = app().doc, l = d.active; l && O.moveLayer(l, d.index(l) - 1); }),
    B('Merge down', 'M12 4v10M7 9l5 5 5-5M5 20h14', () => O.mergeDown()), B('Delete layer', 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', () => O.deleteLayer()));
  const ctrl = el('div', { class: 'layer-ctrl' }, blend, el('label', { class: 'op' }, el('span', { text: 'Opacity' }), op, opN));
  const thumbs = new Map();
  const drawThumb = (c, src) => {
    const g = c.getContext('2d'), k = Math.min(c.width / src.width, c.height / src.height);
    g.clearRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high';
    g.drawImage(src, (c.width - src.width * k) / 2, (c.height - src.height * k) / 2, src.width * k, src.height * k);
  };
  let dragId = null;
  const render = () => {
    const d = app().doc; list.replaceChildren(); thumbs.clear();
    if (!d) return;
    const a = d.active;
    blend.value = a ? a.blend : 'normal'; op.value = a ? Math.round(a.opacity * 100) : 100; opN.textContent = op.value + '%';
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i], active = l === a;
      const tc = el('canvas', { class: 'thumb' + (active && app().target !== 'mask' ? ' target' : ''), width: 40, height: 40, title: 'Edit layer pixels' });
      const mc = l.mask ? el('canvas', { class: 'thumb mask' + (active && app().target === 'mask' ? ' target' : '') + (l.maskEnabled ? '' : ' off'), width: 40, height: 40, title: 'Edit mask (Shift+click: enable/disable)' }) : null;
      drawThumb(tc, l.canvas); if (mc) { const g = mc.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 40, 40); const t = U.canvas(l.mask.width, l.mask.height), tg = t.getContext('2d'); tg.fillStyle = '#fff'; tg.fillRect(0, 0, t.width, t.height); tg.globalCompositeOperation = 'destination-in'; tg.drawImage(l.mask, 0, 0); drawThumb(mc, t); g.globalCompositeOperation = 'destination-over'; g.fillRect(0, 0, 40, 40); }
      thumbs.set(l.id, { tc, rev: l.rev, l });
      const name = el('span', { class: 'lname', text: l.name + (l.type === 'text' ? '  T' : '') });
      name.addEventListener('dblclick', () => {
        const inp = el('input', { type: 'text', value: l.name, class: 'rename', 'aria-label': 'Layer name' });
        name.replaceWith(inp); inp.focus(); inp.select();
        const done = ok => { if (ok && inp.value.trim()) Ops().setLayerProps(l, { name: inp.value.trim().slice(0, 100) }, 'Rename Layer'); else render(); };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
        inp.addEventListener('blur', () => done(true));
      });
      const eye = el('button', { type: 'button', class: 'icon-btn eye' + (l.visible ? '' : ' off'), 'aria-label': l.visible ? 'Hide layer' : 'Show layer', onclick: e => { e.stopPropagation(); Ops().setLayerProps(l, { visible: !l.visible }, l.visible ? 'Hide Layer' : 'Show Layer'); } }, icon(l.visible ? 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6' : 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 16));
      const lock = el('button', { type: 'button', class: 'icon-btn lock' + (l.locked ? ' on' : ''), 'aria-label': l.locked ? 'Unlock layer' : 'Lock layer', onclick: e => { e.stopPropagation(); Ops().setLayerProps(l, { locked: !l.locked }, l.locked ? 'Unlock Layer' : 'Lock Layer'); } }, icon(l.locked ? 'M6 11h12v9H6zM8 11V7a4 4 0 0 1 8 0v4' : 'M6 11h12v9H6zM8 11V7a4 4 0 0 1 7.7-1.5', 16));
      const li = el('li', { class: 'layer' + (active ? ' active' : ''), role: 'option', 'aria-selected': String(active), draggable: true, 'data-id': l.id }, eye, tc, mc, name, lock);
      li.addEventListener('click', e => {
        if (mc && e.target === mc) { if (e.shiftKey) Ops().setLayerProps(l, { maskEnabled: !l.maskEnabled }, l.maskEnabled ? 'Disable Mask' : 'Enable Mask'); else { app().target = 'mask'; d.setActive(l); } return; }
        if (e.target === tc && (e.ctrlKey || e.metaKey)) { d.setActive(l); Ops().selectionFromAlpha(); return; }
        app().target = 'pixels'; d.setActive(l);
      });
      li.addEventListener('dragstart', e => { dragId = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); });
      li.addEventListener('dragover', e => { if (dragId) { e.preventDefault(); li.classList.add('drop'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop'));
      li.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); li.classList.remove('drop'); const src = d.byId(dragId); dragId = null; if (src && src !== l) Ops().moveLayer(src, d.index(l)); });
      list.append(li);
    }
  };
  // incremental thumbnail refresh (throttled) when pixels change
  const refreshThumbs = U.debounce(() => { for (const t of thumbs.values()) if (t.rev !== t.l.rev) { t.rev = t.l.rev; drawThumb(t.tc, t.l.canvas); } }, 250);
  bus.on('layers', render); bus.on('pixels', refreshThumbs); bus.on('history', render);
  return section('layers', 'Layers', el('div', null, ctrl, list, foot));
}

function buildSelectionPanel() {
  const O = Ops(), info = el('p', { class: 'note sel-info' });
  const B = (t, fn, cls) => el('button', { type: 'button', class: 'btn small ' + (cls || ''), text: t, onclick: needDoc(fn) });
  const N = (t, k, def, max) => B(t, () => numberDialog(t + ' Selection', 'Amount', def, 0.5, max, 'px', r => O.refine(k, r)));
  const body = el('div', { class: 'sel-panel' }, info,
    el('div', { class: 'btn-grid' }, B('All', () => O.selectAll()), B('None', () => O.deselect()), B('Invert', () => O.invertSelection()), B('Quick mask', toggleQuickMask)),
    el('h4', { text: 'Refine edge' }),
    el('div', { class: 'btn-grid' }, N('Feather', 'feather', 2, 250), N('Expand', 'expand', 2, 500), N('Contract', 'contract', 2, 500), N('Smooth', 'smooth', 3, 100), N('Border', 'border', 4, 500), B('Mask brush', () => app().tools.select('mask-brush'))),
    el('h4', { text: 'Cut out' }),
    el('div', { class: 'btn-grid' }, B('Remove outside', () => O.removeByMask(true), 'primary'), B('Remove inside', () => O.removeByMask(false)), B('Copy → layer', () => O.copySelectionToLayer(false)), B('Cut → layer', () => O.copySelectionToLayer(true)), B('Layer mask', () => O.addMask('selection')), B('Save', () => O.saveSelection())));
  const upd = () => { const d = app().doc, b = d && d.selection.bounds; info.textContent = b ? `Selection: ${b.w} × ${b.h} at ${b.x}, ${b.y}` : 'No selection. Use a selection tool (M, L, W) to start.'; refreshStatus(); };
  bus.on('selection', upd); upd();
  return section('selection', 'Selection & Cutout', body);
}

function buildHistoryPanel() {
  const list = el('ol', { class: 'history', 'aria-label': 'History' }), mem = el('p', { class: 'note' });
  const render = () => {
    const h = app().history; list.replaceChildren();
    const item = (label, i) => el('li', { class: (i === h.index ? 'cur ' : '') + (i > h.index ? 'future' : ''), tabindex: 0, text: label, onclick: () => { app().tools.cancel(); h.goto(i); }, onkeydown: e => { if (e.key === 'Enter') { app().tools.cancel(); h.goto(i); } } });
    list.append(item(h.base, -1));
    h.stack.forEach((e, i) => list.append(item(e.label, i)));
    mem.textContent = `${h.stack.length} steps · ${U.formatBytes(h.bytes)}`;
    const cur = list.querySelector('.cur'); cur && cur.scrollIntoView({ block: 'nearest' });
  };
  bus.on('history', render);
  return section('history', 'History', el('div', null, list, mem), el('div', { class: 'sec-actions' },
    el('button', { type: 'button', class: 'icon-btn', title: 'Undo', 'aria-label': 'Undo', onclick: () => { app().tools.cancel(); app().history.undo(); } }, icon('M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3', 16)),
    el('button', { type: 'button', class: 'icon-btn', title: 'Redo', 'aria-label': 'Redo', onclick: () => { app().tools.cancel(); app().history.redo(); } }, icon('M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3', 16))));
}

/* ───────────── keyboard ───────────── */
function bindKeys() {
  const O = Ops(), I = IO();
  document.addEventListener('keydown', e => {
    if (openDialog) { if (e.key === 'Escape') { e.preventDefault(); openDialog.close(false); } return; }
    if (U.isTyping(e.target)) return;
    if (!app().doc && !(e.ctrlKey || e.metaKey)) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey, t = app().tools, cur = t.current;
    if (k === ' ' && !e.repeat) { t.setSpace(true); e.preventDefault(); return; }
    if (k === ' ') { e.preventDefault(); return; }
    if (!mod && cur && cur.key && cur.key(e)) { e.preventDefault(); return; }
    const run = fn => { e.preventDefault(); fn(); };
    if (mod) {
      const K = k.toLowerCase();
      if (K === 'z' && !e.shiftKey) return run(() => { t.cancel(); app().history.undo(); });
      if ((K === 'z' && e.shiftKey) || K === 'y') return run(() => { t.cancel(); app().history.redo(); });
      if (K === 'o') return run(() => I.pickFiles({ newDoc: true }));
      if (K === 'n' && e.shiftKey) return run(needDoc(() => O.newLayer()));
      if (K === 'n') return run(newDocDialog);
      if (!app().doc) return;
      if (K === 's' && e.shiftKey) return run(exportDialog);
      if (K === 's') return run(() => I.saveProject());
      if (K === 'c' && e.shiftKey) return run(() => O.copy(true));
      if (K === 'c') return run(() => O.copy(false));
      if (K === 'x') return run(() => O.copy(false, true));
      if (K === 'a') return run(() => O.selectAll());
      if (K === 'd') return run(() => O.deselect());
      if (K === 'i' && e.shiftKey) return run(() => O.invertSelection());
      if (K === 't') return run(() => t.select('transform'));
      if (K === 'j') return run(() => O.copySelectionToLayer(e.shiftKey));
      if (K === '0') return run(() => app().view.fit());
      if (K === '1') return run(() => app().view.actual());
      if (K === '=' || K === '+') return run(() => app().view.step(1));
      if (K === '-') return run(() => app().view.step(-1));
      return;
    }
    if (e.altKey) return;
    if (k === 'Escape') return run(() => t.cancel());
    if (k === 'Delete' || k === 'Backspace') return run(() => O.clearLayer());
    if (k === 'Tab') return run(togglePanels);
    if (k === '?') return run(shortcutsDialog);
    if (k === '[' || k === ']') return run(() => { const b = app().opts.brush; b.size = U.clamp(Math.round(b.size * (k === ']' ? 1.15 : 1 / 1.15) + (k === ']' ? 1 : -1)), 1, 1000); UI.refreshOptions && UI.refreshOptions(); app().view.requestOverlay(); I.savePrefs(); });
    if (k === 'x' || k === 'X') return run(() => O.swapColors());
    if (k === 'd' || k === 'D') return run(() => O.resetColors());
    const tool = PP.Tools.list.find(x => x.key && x.key === k.toLowerCase());
    if (tool) return run(() => t.select(tool.id));
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') app().tools.setSpace(false); });
  window.addEventListener('blur', () => app().tools && app().tools.setSpace(false));
}

/* ───────────── build ───────────── */
UI.build = function () {
  buildMenubar(); buildToolbar();
  const panel = $('#panel'); panel.replaceChildren(buildLayersPanel(), buildSelectionPanel(), buildHistoryPanel());
  bus.on('tool', t => { buildOptions(t); refreshStatus(); });
  bus.on('options-values', () => UI.refreshOptions && UI.refreshOptions());
  bus.on('view', refreshStatus); bus.on('docsize', refreshStatus); bus.on('selection', refreshStatus);
  const z = $('#st-zoom');
  z.addEventListener('change', () => { const v = parseFloat(z.value); if (v > 0) app().view.setZoom(v / 100); else refreshStatus(); });
  z.addEventListener('keydown', e => e.stopPropagation());
  bus.on('busy', on => { jobBusy = !!on; paintBusy(); }); // worker jobs: a state flag, not a counter
  bindKeys();
  $('#empty-new').addEventListener('click', newDocDialog);
  $('#empty-open').addEventListener('click', () => IO().pickFiles({ newDoc: true }));
  $('#empty-recover').addEventListener('click', () => recoveryDialog(false));
};
UI.recoveryDialog = recoveryDialog;
UI.refreshStatus = refreshStatus;
})();
