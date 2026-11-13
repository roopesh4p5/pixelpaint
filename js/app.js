/* PixelPaint · app.js — AppBootstrap */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, bus = PP.bus, M = PP.Model, IO = PP.IO;

const DEFAULT_OPTS = {
  brush: { size: 24, hardness: 80, opacity: 100, flow: 100, spacing: 15, smoothing: 0, pressure: true, airbrush: false },
  select: { mode: 'replace', feather: 0, antialias: true, smoothing: 0 },
  wand: { tolerance: 32, contiguous: true, diagonal: false, merged: true },
  range: { tolerance: 32, fuzziness: 24 },
  magnetic: { width: 10, contrast: 20, frequency: 8 },
  smart: { radius: 14, contrast: 15, shapes: true },
  quick: { mode: 'add', size: 30, tolerance: 24 },
  skin: { mode: 'smooth', size: 40, strength: 70, radius: 6, detail: 40 },
  maskBrush: { mode: 'reveal' },
  fill: { tolerance: 32, opacity: 100, contiguous: true, diagonal: false, merged: false, antialias: true },
  picker: { size: 1, merged: true },
  clone: { aligned: true, merged: false },
  crop: { delete: true },
  shape: { stroke: true, fill: false, width: 4, radius: 16, antialias: true },
  text: { font: 'system-ui, sans-serif', size: 48, weight: 400, italic: false, align: 'left' },
  export: { format: 'png', quality: 92 },
  xf: { sx: 100, sy: 100, rot: 0 },
  paste: { x: 0, y: 0, w: 1, h: 1, ratio: false, transparent: false }
};

/** Merge saved prefs into defaults: only known keys, only matching types (untrusted storage). */
function merge(def, saved) {
  const out = {};
  for (const k in def) {
    const d = def[k], s = saved && saved[k];
    if (d && typeof d === 'object') out[k] = merge(d, s);
    else out[k] = typeof s === typeof d && (typeof s !== 'number' || Number.isFinite(s)) ? s : d;
  }
  return out;
}
const hex = v => (/^#[0-9a-f]{6}$/i.test(v) ? v : null);

const prefs = IO.loadPrefs();
const app = PP.app = {
  doc: null, history: new M.History(), opts: merge(DEFAULT_OPTS, prefs.opts),
  colors: { fg: hex(prefs.colors && prefs.colors.fg) || '#000000', bg: hex(prefs.colors && prefs.colors.bg) || '#ffffff' },
  panels: prefs.panels && typeof prefs.panels === 'object' ? prefs.panels : {},
  target: 'pixels', quickMask: false, quickMaskSticky: false, clipboard: null, dirty: false
};

PP.App = {
  setDocument(d, label = 'Open') {
    if (app.tools) app.tools.cancel();
    app.doc = d; app.target = 'pixels';
    app.history.clear(label);
    app.view.allocate(); app.view.fit();
    document.body.classList.add('has-doc');
    document.title = `${d.name} — PixelPaint`;
    bus.emit('docsize'); bus.emit('layers'); bus.emit('selection', d.selection); bus.emit('history');
    IO.session.set('doc', d.id);
    IO.autosave();
  },
  /** Drop the current document without saving (its autosave is discarded by the caller). */
  closeDocument() {
    if (app.tools) app.tools.cancel();
    app.doc = null; app.dirty = false; app.clipboard = null; app.target = 'pixels';
    app.history.clear('Open');
    document.body.classList.remove('has-doc');
    document.title = 'PixelPaint';
    IO.session.set('doc', null);
    bus.emit('docsize'); bus.emit('layers'); bus.emit('selection', null); bus.emit('pixels', { rect: null });
    PP.UI.status({ save: ' ', sel: '' }); PP.UI.refreshStatus();
  },
  newDocument(w, h, bg = 'white', name = 'Untitled') {
    const d = new M.Doc({ name, width: w, height: h });
    const l = new M.Layer({ name: bg === 'transparent' ? 'Layer 1' : 'Background', w, h });
    if (bg !== 'transparent') { const g = l.canvas.getContext('2d'); g.fillStyle = bg === 'bgcolor' ? app.colors.bg : '#ffffff'; g.fillRect(0, 0, w, h); }
    d.layers.push(l); d.activeId = l.id;
    PP.App.setDocument(d, 'New');
  }
};

/* ── boot ── */
if (window.innerWidth < 760) document.body.classList.add('panels-hidden');
app.view = new PP.View(document.getElementById('stage'));
app.view.bg = prefs.bg === 'checker' || hex(prefs.bg) ? prefs.bg : 'checker';
app.view.showGrid = !!prefs.grid;
app.tools = new PP.Tools.ToolManager(app.view);
app.opts.select.mode = 'replace'; // a remembered Add/Subtract made later marquees look broken
PP.UI.build();
app.tools.select(PP.Tools.list.some(t => t.id === prefs.tool && !t.hidden) ? prefs.tool : 'brush');
IO.bindInputs();

let persistAsked = false;
bus.on('history', e => {
  if (!e || !e.change || !app.doc) return;
  app.doc.updatedAt = Date.now(); app.dirty = true;
  IO.autosave();
  if (!persistAsked) { persistAsked = true; IO.requestPersist(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && app.dirty) { app.dirty = false; IO.saveNow(); } });
// Reload / close / navigate away with an open image: ask first (browsers show their own generic wording).
window.addEventListener('beforeunload', e => {
  if (!app.doc || !(app.history.stack.length || app.dirty)) return;
  if (app.dirty) IO.saveNow(); // start saving the latest steps in case the user confirms
  e.preventDefault(); e.returnValue = '';
});
window.addEventListener('pagehide', () => { if (app.dirty) { app.dirty = false; IO.saveNow(); } });

window.addEventListener('error', e => { console.error(e.error || e.message); PP.UI.toast('Unexpected error: ' + (e.message || 'see console'), 'error'); });
window.addEventListener('unhandledrejection', e => {
  if (e.reason && e.reason.cancelled) { e.preventDefault(); return; }
  const r = e.reason, m = r && r.name === 'QuotaExceededError' ? 'Storage quota exceeded' : (r && r.message) || String(r);
  PP.UI.toast('Operation failed: ' + m, 'error');
});

/* Recovery: a reload of this tab silently reopens its document; otherwise offer saved work. */
(async () => {
  let list = [];
  try { list = await IO.listSaved(); } catch (e) { PP.UI.status({ save: 'Local storage unavailable' }); return; }
  const mine = IO.session.get('doc');
  if (mine && list.some(r => r.id === mine)) {
    try { await IO.restore(mine); return; } catch (e) { PP.UI.toast('Could not restore session: ' + e.message, 'error'); }
  }
  if (list.length && !app.doc) PP.UI.recoveryDialog(true);
})();
})();
