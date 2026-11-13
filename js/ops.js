/* PixelPaint · ops.js — editing commands: selection, cutout, clipboard, layers, geometry, filter sessions.
 * Every mutating command is undoable: pixel edits via PixelEdit tiles, structure via docCommand snapshots,
 * selections via RLE-compressed before/after masks. */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, P = PP.Pixel, bus = PP.bus, M = PP.Model;
const app = () => PP.app, doc = () => PP.app.doc, H = () => PP.app.history;
const toast = (m, k) => PP.UI && PP.UI.toast(m, k);

const Ops = PP.Ops = {};

/* ───────────── guards ───────────── */
Ops.editableLayer = function ({ mask = false, any = false, rasterizeText = false } = {}) {
  const d = doc(), l = d && d.active;
  if (!l) { toast('No active layer', 'warn'); return null; }
  if (l.locked) { toast(`“${l.name}” is locked`, 'warn'); return null; }
  if (!any && !l.visible) { toast(`“${l.name}” is hidden`, 'warn'); return null; }
  if (l.type === 'text' && (rasterizeText || (!any && !mask))) { Ops.rasterize(l); toast('Text layer rasterized for pixel editing'); }
  return l;
};

/* ───────────── colours ───────────── */
Ops.setColor = (which, hex) => { app().colors[which] = hex; bus.emit('colors'); };
Ops.swapColors = () => { const c = app().colors; [c.fg, c.bg] = [c.bg, c.fg]; bus.emit('colors'); };
Ops.resetColors = () => { app().colors.fg = '#000000'; app().colors.bg = '#ffffff'; bus.emit('colors'); };

/* ───────────── selection ───────────── */
Ops.setSelection = function (mask, label = 'Selection') {
  const sel = doc().selection, n = sel.w * sel.h;
  const before = sel.mask ? P.rleEncode(sel.mask) : null;
  sel.set(mask);
  const after = sel.mask ? P.rleEncode(sel.mask) : null;
  H().push(M.entry('sel', label, { before, after, n }, (before ? before.length : 0) + (after ? after.length : 0)));
};
Ops.combineSelection = (mask, mode, label) => Ops.setSelection(P.combine(doc().selection.mask, mask, mode), label);
Ops.deselect = () => { if (doc().selection.active) Ops.setSelection(null, 'Deselect'); };
Ops.selectAll = () => { const d = doc(); Ops.setSelection(new Uint8Array(d.width * d.height).fill(255), 'Select All'); };
Ops.invertSelection = () => { const s = doc().selection; Ops.setSelection(s.mask ? P.invertMask(s.mask) : new Uint8Array(s.w * s.h).fill(255), 'Invert Selection'); };

function needSel() { if (!doc().selection.active) { toast('Make a selection first', 'warn'); return null; } return doc().selection; }
Ops.refine = function (kind, amount) {
  const s = needSel(); if (!s) return;
  const fn = { feather: P.feather, expand: P.expand, contract: P.contract, smooth: P.smooth, border: P.border }[kind];
  PP.UI.busy(true);
  setTimeout(() => { try { Ops.setSelection(fn(s.mask, s.w, s.h, amount), kind[0].toUpperCase() + kind.slice(1)); } finally { PP.UI.busy(false); } }, 16);
};
Ops.selectionFromAlpha = function () {
  const d = doc(), l = d.active; if (!l) return;
  const a = U.canvasAlpha(l.source()), m = new Uint8Array(d.width * d.height);
  for (let y = Math.max(0, l.y); y < Math.min(d.height, l.y + l.h); y++) {
    const x0 = Math.max(0, l.x), x1 = Math.min(d.width, l.x + l.w);
    if (x1 > x0) m.set(a.subarray((y - l.y) * l.w + x0 - l.x, (y - l.y) * l.w + x1 - l.x), y * d.width + x0);
  }
  Ops.setSelection(m, 'Load Layer Transparency');
};
Ops.colorRange = function (color, tolerance, fuzziness, mode, srcCanvas) {
  const d = doc(), l = d.active;
  let m;
  if (srcCanvas || !l) m = P.colorRangeMask(U.read(srcCanvas || PP.app.view.flattened()), color, { tolerance, fuzziness });
  else {
    const lm = P.colorRangeMask(U.read(l.source()), color, { tolerance, fuzziness });
    m = new Uint8Array(d.width * d.height);
    for (let y = Math.max(0, l.y); y < Math.min(d.height, l.y + l.h); y++) {
      const x0 = Math.max(0, l.x), x1 = Math.min(d.width, l.x + l.w);
      if (x1 > x0) m.set(lm.subarray((y - l.y) * l.w + x0 - l.x, (y - l.y) * l.w + x1 - l.x), y * d.width + x0);
    }
  }
  const f = app().opts.select.feather;
  Ops.combineSelection(f > 0 ? P.feather(m, d.width, d.height, f) : m, mode || 'replace', 'Color Range');
};
/* Saved selections ("alpha channels") live on the document. */
Ops.saveSelection = function (name) {
  const s = needSel(); if (!s) return;
  const d = doc(); (d.saved = d.saved || []).push({ name: name || `Selection ${d.saved.length + 1}`, w: s.w, h: s.h, rle: P.rleEncode(s.mask) });
  bus.emit('saved-selections'); toast('Selection saved');
};
Ops.loadSelection = function (i, mode = 'replace') {
  const d = doc(), e = d.saved && d.saved[i]; if (!e) return;
  if (e.w !== d.width || e.h !== d.height) { toast('Saved selection size no longer matches the canvas', 'warn'); return; }
  Ops.combineSelection(P.rleDecode(e.rle, e.w * e.h), mode, 'Load Selection');
};

/* ───────────── cutout workflow ───────────── */
/** Multiply the active layer's alpha by the selection (keep=true → Remove Outside). */
Ops.removeByMask = function (keep) {
  const s = needSel(); if (!s) return;
  const l = Ops.editableLayer(); if (!l) return;
  const m = l.selMask(s);
  const bb = keep ? { x: 0, y: 0, w: l.w, h: l.h } : P.bounds(m, l.w, l.h);
  if (!bb) return;
  const edit = new M.PixelEdit(l); edit.save(bb);
  const img = U.read(l.canvas, bb.x, bb.y, bb.w, bb.h), sub = new Uint8Array(bb.w * bb.h);
  for (let y = 0; y < bb.h; y++) sub.set(m.subarray((bb.y + y) * l.w + bb.x, (bb.y + y) * l.w + bb.x + bb.w), y * bb.w);
  P.applyMaskToAlpha(img.data, sub, keep);
  U.write(l.canvas, img, bb.x, bb.y); l.touch(bb);
  edit.commit(keep ? 'Remove Outside' : 'Remove Inside');
};

/** Selected pixels of a layer (alpha × mask), cropped to selection bounds, positioned in document space. */
function extract(l, merged) {
  const s = doc().selection, b = s.bounds; if (!b) return null;
  const src = merged ? PP.app.view.flattened() : l.source(), ox = merged ? 0 : l.x, oy = merged ? 0 : l.y;
  const c = U.canvas(b.w, b.h), g = c.getContext('2d');
  g.drawImage(src, ox - b.x, oy - b.y);
  const img = U.read(c);
  P.applyMaskToAlpha(img.data, s.maskForRect(b.x, b.y, b.w, b.h), true);
  U.write(c, img);
  return { canvas: c, x: b.x, y: b.y };
}

Ops.copySelectionToLayer = function (cut) {
  const s = needSel(); if (!s) return;
  const l = cut ? Ops.editableLayer() : doc().active; if (!l) return;
  const piece = extract(l, false); if (!piece) return;
  const d = doc(), nl = new M.Layer({ name: (cut ? 'Cut of ' : 'Copy of ') + l.name, canvas: piece.canvas, x: piece.x, y: piece.y });
  M.docCommand(cut ? 'Cut to New Layer' : 'Copy to New Layer', () => {
    if (cut) { // replace source canvas with a cleared copy (snapshot keeps the original for undo)
      const c = U.clone(l.canvas), img = U.read(c);
      P.applyMaskToAlpha(img.data, l.selMask(s), false); U.write(c, img);
      l.canvas = c; l.rev++;
    }
    d.layers.splice(d.index(l) + 1, 0, nl); d.activeId = nl.id;
  });
};

/* ───────────── clipboard ───────────── */
const isEmpty = c => !P.bounds(P.alphaToMask(U.read(c)), c.width, c.height);
Ops.isEmptyCanvas = isEmpty;
function toSystemClipboard(c) {
  if (navigator.clipboard && window.ClipboardItem) {
    U.toBlob(c, 'image/png').then(b => navigator.clipboard.write([new ClipboardItem({ 'image/png': b })])).catch(() => { /* permission denied → internal clipboard still works */ });
  }
}
Ops.copy = function (merged, cut) {
  const d = doc(), l = d.active, f = app().floating;
  if (f) { // a floating selection copies/cuts itself, as in MS Paint
    const c = f.render();
    app().clipboard = { canvas: c, x: f.x, y: f.y }; app().clipboardFresh = true; toSystemClipboard(c);
    if (cut) PP.app.tools.current.drop();
    toast(cut ? 'Cut' : 'Copied'); return;
  }
  if (!l && !merged) return;
  let piece;
  if (d.selection.active) piece = extract(l, merged);
  else { const src = merged ? PP.app.view.flattened() : U.clone(l.source()); piece = { canvas: src, x: merged ? 0 : l.x, y: merged ? 0 : l.y }; }
  if (!piece) return;
  if (!merged && !cut && isEmpty(piece.canvas)) { // nothing on the active layer there: copy what you see, like MS Paint
    piece = d.selection.active ? extract(l, true) : { canvas: PP.app.view.flattened(), x: 0, y: 0 };
    merged = true;
  }
  app().clipboard = piece; app().clipboardFresh = true; toSystemClipboard(piece.canvas);
  if (cut) { if (d.selection.active) Ops.removeByMask(false); else Ops.clearLayer(); }
  toast(cut ? 'Cut' : merged ? 'Copied merged' : 'Copied');
};
Ops.pasteCanvas = function (canvas, x, y, name = 'Pasted') {
  const d = doc();
  if (x == null || x + canvas.width <= 0 || y + canvas.height <= 0 || x >= d.width || y >= d.height) { x = Math.round((d.width - canvas.width) / 2); y = Math.round((d.height - canvas.height) / 2); }
  const nl = new M.Layer({ name, canvas: U.clone(canvas), x, y });
  M.docCommand('Paste', () => { const a = d.active; d.layers.splice(a ? d.index(a) + 1 : d.layers.length, 0, nl); d.activeId = nl.id; });
};
/** MS Paint style paste: a floating selection on the active layer, slightly offset from where it was copied
 * (or at the top-left of the visible area when that spot is off screen / the image came from outside). */
Ops.pasteFloating = function (canvas, x, y) {
  PP.Tools.settleFloat();
  const d = doc(), a = d.active, v = PP.app.view, sr = v.stage.getBoundingClientRect(), p0 = v.toDoc(sr.left, sr.top), p1 = v.toDoc(sr.right, sr.bottom);
  const vis = U.intersect(U.snap({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y }), { x: 0, y: 0, w: d.width, h: d.height }) || { x: 0, y: 0, w: d.width, h: d.height };
  const off = Math.max(1, Math.round(24 / v.zoom)); // ~24 screen px, so the copy is visibly off the original
  let px = x == null ? null : x + off, py = y == null ? null : y + off;
  if (px == null || !U.intersect({ x: px, y: py, w: canvas.width, h: canvas.height }, vis)) { px = vis.x; py = vis.y; }
  // The paste is a real layer straight away (visible in Layers), with move/resize handles until placed.
  const name = 'Pasted ' + (d.layers.filter(l => /^Pasted \d+$/.test(l.name)).length + 1);
  const nl = new M.Layer({ name, canvas: U.clone(canvas), x: px, y: py });
  M.docCommand('Paste', dd => { dd.layers.splice(a ? dd.index(a) + 1 : dd.layers.length, 0, nl); dd.activeId = nl.id; });
  PP.Tools.startFloat({ src: nl.canvas, x: px, y: py, layer: nl, ownLayer: true, hist: PP.app.history.index, label: 'Paste' });
  toast(`New layer “${name}” — drag to move, handles resize, Enter or click outside to place`);
};
/** Bring an image into the active layer as a floating selection (move/resize, then placed into that layer).
 * Images larger than the canvas start scaled down to fit; the full-resolution pixels are kept until placed. */
Ops.importIntoLayer = function (canvas) {
  PP.Tools.settleFloat();
  const d = doc(), l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  const k = Math.min(1, d.width / canvas.width, d.height / canvas.height);
  const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
  PP.Tools.startFloat({ src: canvas, x: Math.round((d.width - w) / 2), y: Math.round((d.height - h) / 2), w, h, layer: l, edit: null, label: 'Import Image' });
  toast(`Image added to “${l.name}” — drag to move, handles resize, Enter or click outside to place`);
};
Ops.pasteInternal = (asLayer) => { const c = app().clipboard; if (c) { (asLayer ? Ops.pasteCanvas : Ops.pasteFloating)(c.canvas, c.x, c.y); return true; } return false; };

/** Lift the selected pixels into a floating selection. copy=false leaves a hole (background colour on the
 * Background layer, transparency elsewhere); copy=true leaves the original in place. */
Ops.liftSelection = function (copy) {
  const d = doc(), s = d.selection; if (!s.active) return false;
  const l = Ops.editableLayer(); if (!l) return false;
  const piece = extract(l, false); if (!piece) return false;
  let edit = null;
  if (!copy) {
    const m = l.selMask(s), bb = P.bounds(m, l.w, l.h);
    if (bb) {
      edit = new M.PixelEdit(l); edit.save(bb);
      const img = U.read(l.canvas, bb.x, bb.y, bb.w, bb.h), sub = new Uint8Array(bb.w * bb.h);
      for (let y = 0; y < bb.h; y++) sub.set(m.subarray((bb.y + y) * l.w + bb.x, (bb.y + y) * l.w + bb.x + bb.w), y * bb.w);
      if (l === d.layers[0] && l.name === 'Background') P.fillThroughMask(img.data, sub, U.hexToRgb(app().colors.bg), 1);
      else P.applyMaskToAlpha(img.data, sub, false);
      U.write(l.canvas, img, bb.x, bb.y); l.touch(bb);
    }
  }
  return PP.Tools.startFloat({ src: piece.canvas, x: piece.x, y: piece.y, layer: l, edit, label: copy ? 'Duplicate Selection' : 'Move Selection' });
};

Ops.clearLayer = function () {
  const l = Ops.editableLayer(); if (!l) return;
  if (doc().selection.active) return Ops.removeByMask(false);
  const e = new M.PixelEdit(l); e.saveAll(); l.canvas.getContext('2d').clearRect(0, 0, l.w, l.h); l.touch(); e.commit('Clear');
};

/** Draw on the active layer through the selection. draw(g) receives document coordinates. */
Ops.paintOnLayer = function (label, draw, aa = true) {
  const l = Ops.editableLayer(); if (!l) return;
  const t = U.canvas(l.w, l.h), g = t.getContext('2d');
  g.translate(-l.x, -l.y); draw(g); g.setTransform(1, 0, 0, 1, 0, 0);
  const img = U.read(t), d = img.data;
  if (!aa) for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  const sm = l.selMask(doc().selection); if (sm) P.applyMaskToAlpha(d, sm, true);
  const bb = P.bounds(P.alphaToMask(img), l.w, l.h); if (!bb) return;
  U.write(t, img);
  const e = new M.PixelEdit(l); e.save(bb);
  l.canvas.getContext('2d').drawImage(t, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h);
  l.touch(bb); e.commit(label);
};
Ops.fillSelection = function (which = 'fg', opacity = 1) {
  const d = doc(), color = app().colors[which];
  Ops.paintOnLayer('Fill', g => { g.globalAlpha = opacity; g.fillStyle = color; g.fillRect(0, 0, d.width, d.height); });
};
Ops.strokeSelection = function (width = 2) {
  const s = needSel(); if (!s) return;
  const ring = P.border(s.mask, s.w, s.h, width), c = U.maskToCanvas(ring, s.w, s.h, U.hexToRgb(app().colors.fg));
  Ops.paintOnLayer('Stroke', g => g.drawImage(c, 0, 0));
};

/* ───────────── layers ───────────── */
const cmd = M.docCommand;
Ops.newLayer = function (name) {
  const d = doc(), a = d.active, l = new M.Layer({ name: name || `Layer ${d.layers.length + 1}`, w: d.width, h: d.height });
  cmd('New Layer', () => { d.layers.splice(a ? d.index(a) + 1 : d.layers.length, 0, l); d.activeId = l.id; });
  toast(`Empty “${l.name}” added — Layer ▸ Import Image into Layer… (or the picture button below the layers) to fill it`);
  return l;
};
Ops.duplicateLayer = function () {
  const d = doc(), a = d.active; if (!a) return;
  const l = new M.Layer({ name: a.name + ' copy', type: a.type, canvas: U.clone(a.canvas), mask: a.mask && U.clone(a.mask), x: a.x, y: a.y, opacity: a.opacity, blend: a.blend, text: a.text, maskEnabled: a.maskEnabled });
  cmd('Duplicate Layer', () => { d.layers.splice(d.index(a) + 1, 0, l); d.activeId = l.id; });
};
Ops.deleteLayer = function () {
  const d = doc(), a = d.active; if (!a) return;
  if (d.layers.length === 1) { toast('A document needs at least one layer', 'warn'); return; }
  cmd('Delete Layer', () => { const i = d.index(a); d.layers.splice(i, 1); d.activeId = d.layers[Math.max(0, i - 1)].id; });
};
Ops.moveLayer = function (layer, toIndex) {
  const d = doc(), from = d.index(layer); toIndex = U.clamp(toIndex, 0, d.layers.length - 1);
  if (from < 0 || from === toIndex) return;
  cmd('Reorder Layer', () => { d.layers.splice(from, 1); d.layers.splice(toIndex, 0, layer); });
};
Ops.setLayerProps = function (layer, props, label = 'Layer Properties') {
  if (Object.keys(props).every(k => layer[k] === props[k])) return;
  cmd(label, () => { Object.assign(layer, props); layer.rev++; });
};
Ops.recordMove = function (l, x0, y0) {
  const dx = l.x - x0, dy = l.y - y0; if (!dx && !dy) return;
  if (l.text) { l.text.ax += dx; l.text.ay += dy; }
  H().push(M.entry('move', 'Move', { layer: l, x0, y0, dx, dy }));
};
Ops.rasterize = function (l) {
  if (l.type !== 'text') return;
  cmd('Rasterize Type', () => { l.type = 'raster'; l.text = null; });
};
function bakeLayer(l) { // pixels with mask applied, opacity not included
  return U.clone(l.source());
}
Ops.mergeDown = function () {
  const d = doc(), a = d.active, i = d.index(a);
  if (!a || i <= 0) { toast('No layer below to merge into', 'warn'); return; }
  const b = d.layers[i - 1];
  if (b.locked) { toast(`“${b.name}” is locked`, 'warn'); return; }
  cmd('Merge Down', () => {
    const r = U.union(b.bounds, a.bounds), c = U.canvas(r.w, r.h), g = c.getContext('2d');
    if (b.visible) { g.globalAlpha = b.opacity; g.drawImage(bakeLayer(b), b.x - r.x, b.y - r.y); }
    if (a.visible) { g.globalAlpha = a.opacity; g.drawImage(bakeLayer(a), a.x - r.x, a.y - r.y); }
    Object.assign(b, { canvas: c, x: r.x, y: r.y, mask: null, opacity: 1, blend: 'normal', type: 'raster', text: null }); b.rev++;
    d.layers.splice(i, 1); d.activeId = b.id;
  });
};
Ops.flatten = function () {
  const d = doc(), flat = PP.app.view.flattened();
  cmd('Flatten Image', () => { const l = new M.Layer({ name: 'Background', canvas: flat }); d.layers = [l]; d.activeId = l.id; });
};
Ops.mergeVisible = function () {
  const d = doc(), flat = PP.app.view.flattened();
  cmd('Merge Visible', () => { const l = new M.Layer({ name: 'Merged', canvas: flat }); d.layers = d.layers.filter(x => !x.visible); d.layers.push(l); d.activeId = l.id; });
};
/* layer masks */
Ops.addMask = function (mode = 'reveal') { // 'reveal' | 'hide' | 'selection'
  const l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  if (l.mask) { toast('Layer already has a mask', 'warn'); return; }
  let m;
  if (mode === 'selection') { m = l.selMask(doc().selection); if (!m) { toast('No selection — mask reveals all'); mode = 'reveal'; } }
  if (!m) m = new Uint8Array(l.w * l.h).fill(mode === 'hide' ? 0 : 255);
  const c = U.maskToCanvas(m, l.w, l.h);
  cmd('Add Layer Mask', () => { l.mask = c; l.maskEnabled = true; l.rev++; });
  app().target = 'mask'; bus.emit('layers');
};
Ops.deleteMask = function () { const l = doc().active; if (!l || !l.mask) return; cmd('Delete Layer Mask', () => { l.mask = null; l.rev++; }); app().target = 'pixels'; bus.emit('layers'); };
Ops.applyMask = function () {
  const l = doc().active; if (!l || !l.mask) return;
  const c = bakeLayer(l);
  cmd('Apply Layer Mask', () => { l.canvas = c; l.mask = null; l.rev++; }); app().target = 'pixels'; bus.emit('layers');
};
Ops.maskToSelection = function () {
  const d = doc(), l = d.active; if (!l || !l.mask) return;
  const a = U.canvasAlpha(l.mask), m = new Uint8Array(d.width * d.height);
  for (let y = Math.max(0, l.y); y < Math.min(d.height, l.y + l.h); y++) {
    const x0 = Math.max(0, l.x), x1 = Math.min(d.width, l.x + l.w);
    if (x1 > x0) m.set(a.subarray((y - l.y) * l.w + x0 - l.x, (y - l.y) * l.w + x1 - l.x), y * d.width + x0);
  }
  Ops.setSelection(m, 'Load Mask as Selection');
};

/* text */
Ops.addTextLayer = function (x, y) {
  const d = doc(), a = d.active, o = app().opts.text;
  const l = new M.Layer({ name: 'Text', type: 'text', text: Object.assign({}, o, { text: 'Text', fill: app().colors.fg, ax: x, ay: y }) });
  M.renderText(l);
  cmd('New Text Layer', () => { d.layers.splice(a ? d.index(a) + 1 : d.layers.length, 0, l); d.activeId = l.id; });
  PP.UI.textDialog(l, true);
};
Ops.updateText = function (l, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const e = M.entry('text', 'Edit Text', { layer: l, before: Object.assign({}, before), after: Object.assign({}, after) });
  e.redo();
  H().push(e);
};

/* ───────────── geometry ───────────── */
function redraw(src, w, h, fn, smooth = true) {
  const c = U.canvas(w, h), g = c.getContext('2d');
  g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = 'high';
  fn(g); g.drawImage(src, 0, 0);
  return c;
}
/** High-quality downscale: successive halving, then a final high-quality step. */
function resample(src, w, h, smooth) {
  let cur = src;
  if (smooth) while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const c = U.canvas(Math.max(w, cur.width >> 1), Math.max(h, cur.height >> 1)), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, c.width, c.height); cur = c;
  }
  const c = U.canvas(w, h), g = c.getContext('2d');
  g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, w, h);
  return c;
}
Ops.resample = resample;
function textToRaster(l) { if (l.type === 'text') { l.type = 'raster'; l.text = null; } }

/** shape: crop to a non-rectangular selection — pixels outside it become transparent on every raster layer. */
Ops.crop = function (r, deletePixels = true, shape = false) {
  r = U.snap(r);
  if (!U.validSize(r.w, r.h)) { toast('Invalid crop size', 'error'); return; }
  const d = doc();
  cmd('Crop', () => {
    for (const l of d.layers) {
      if (deletePixels && l.type !== 'text') {
        const i = U.intersect(l.bounds, r);
        if (!i) { l.canvas = U.canvas(1, 1); l.mask = l.mask && U.canvas(1, 1); l.x = 0; l.y = 0; continue; }
        const cut = c => { const n = U.canvas(i.w, i.h); n.getContext('2d').drawImage(c, l.x - i.x, l.y - i.y); return n; };
        l.canvas = cut(l.canvas); if (l.mask) l.mask = cut(l.mask);
        if (shape) { const img = U.read(l.canvas); P.applyMaskToAlpha(img.data, d.selection.maskForRect(i.x, i.y, i.w, i.h), true); U.write(l.canvas, img); }
        l.x = i.x - r.x; l.y = i.y - r.y;
      } else { l.x -= r.x; l.y -= r.y; if (l.text) { l.text.ax -= r.x; l.text.ay -= r.y; } }
      l.rev++;
    }
    const old = d.selection.mask && !shape ? d.selection.maskForRect(r.x, r.y, r.w, r.h) : null;
    d.width = r.w; d.height = r.h; d.selection.w = r.w; d.selection.h = r.h; d.selection.set(old);
  });
  PP.app.view.fit();
};
/** Crop only the active layer to the selection (any shape): everything outside it is removed from that
 * layer; the canvas size and all other layers stay as they are. One undo step, selection cleared. */
Ops.cropLayer = function () {
  PP.Tools.settleFloat();
  const d = doc(), s = d.selection;
  if (!s.active) { toast('Make a selection first (marquee, Smart Select, lasso…)', 'warn'); return; }
  const l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  const piece = extract(l, false);
  if (!piece || !P.bounds(P.alphaToMask(U.read(piece.canvas)), piece.canvas.width, piece.canvas.height)) { toast(`Nothing of “${l.name}” is inside the selection`, 'warn'); return; }
  cmd('Crop Layer', () => { l.canvas = piece.canvas; l.mask = null; l.x = piece.x; l.y = piece.y; l.rev++; d.selection.set(null); });
  toast(`Cropped “${l.name}” — other layers unchanged`);
};
/** Crop the whole canvas (all layers) to the selection (any shape: marquee, ellipse, lasso, smart select…) or to a floating paste. */
Ops.cropToSelection = function () {
  const f = app().floating;
  if (f) { const r = { x: f.x, y: f.y, w: f.w, h: f.h }; PP.Tools.settleFloat(); Ops.crop(r, true); return; }
  const s = doc().selection, b = s.bounds;
  if (!b) { toast('Make a selection first (marquee, Smart Select, lasso…)', 'warn'); return; }
  let rect = true;
  for (let y = b.y; y < b.y + b.h && rect; y++) for (let x = b.x; x < b.x + b.w; x++) if (s.mask[y * s.w + x] !== 255) { rect = false; break; }
  Ops.crop(b, true, !rect);
};
Ops.trim = function () { // crop to non-transparent pixels of the composite
  const b = P.bounds(P.alphaToMask(U.read(PP.app.view.flattened())), doc().width, doc().height);
  if (!b) { toast('Image is fully transparent', 'warn'); return; }
  Ops.crop(b, true);
};

/** Canvas size: anchor ax, ay ∈ {0, 0.5, 1}. Bottom "Background" layer is extended with the background colour. */
Ops.canvasSize = function (w, h, ax = 0.5, ay = 0.5) {
  if (!U.validSize(w, h)) { toast('Invalid canvas size', 'error'); return; }
  const d = doc(), dx = Math.round((w - d.width) * ax), dy = Math.round((h - d.height) * ay), W0 = d.width, H0 = d.height;
  cmd('Canvas Size', () => {
    d.layers.forEach((l, i) => {
      if (i === 0 && l.name === 'Background' && l.x === 0 && l.y === 0 && l.w === W0 && l.h === H0 && !l.mask) {
        const c = U.canvas(w, h), g = c.getContext('2d'); g.fillStyle = app().colors.bg; g.fillRect(0, 0, w, h); g.drawImage(l.canvas, dx, dy);
        l.canvas = c; l.x = 0; l.y = 0;
      } else { l.x += dx; l.y += dy; if (l.text) { l.text.ax += dx; l.text.ay += dy; } }
      l.rev++;
    });
    d.width = w; d.height = h; d.selection.w = w; d.selection.h = h; d.selection.set(null);
  });
  PP.app.view.fit();
};
Ops.imageSize = function (w, h, smooth = true) {
  if (!U.validSize(w, h)) { toast('Invalid image size', 'error'); return; }
  const d = doc(), kx = w / d.width, ky = h / d.height;
  cmd('Image Size', () => {
    for (const l of d.layers) {
      const x0 = Math.round(l.x * kx), y0 = Math.round(l.y * ky), nw = Math.max(1, Math.round((l.x + l.w) * kx) - x0), nh = Math.max(1, Math.round((l.y + l.h) * ky) - y0);
      if (l.type === 'text') { l.text.size *= Math.sqrt(kx * ky); l.text.strokeWidth *= Math.sqrt(kx * ky); l.text.ax *= kx; l.text.ay *= ky; M.renderText(l); continue; }
      l.canvas = resample(l.canvas, nw, nh, smooth); if (l.mask) l.mask = resample(l.mask, nw, nh, smooth);
      l.x = x0; l.y = y0; l.rev++;
    }
    const s = d.selection.canvas();
    const m = s ? U.canvasAlpha(resample(s, w, h, true)) : null;
    d.width = w; d.height = h; d.selection.w = w; d.selection.h = h; d.selection.set(m);
  });
  PP.app.view.fit();
};

/** Whole-document rotation/flip. kind: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV'. */
Ops.rotateImage = function (kind) {
  const d = doc(), W = d.width, H = d.height, swap = kind === 'cw' || kind === 'ccw';
  const geo = (c, x, y) => {
    const w = c.width, h = c.height;
    switch (kind) {
      case 'cw': return { w: h, h: w, x: H - (y + h), y: x, t: g => { g.translate(h, 0); g.rotate(Math.PI / 2); } };
      case 'ccw': return { w: h, h: w, x: y, y: W - (x + w), t: g => { g.translate(0, w); g.rotate(-Math.PI / 2); } };
      case '180': return { w, h, x: W - (x + w), y: H - (y + h), t: g => { g.translate(w, h); g.rotate(Math.PI); } };
      case 'flipH': return { w, h, x: W - (x + w), y, t: g => { g.translate(w, 0); g.scale(-1, 1); } };
      default: return { w, h, x, y: H - (y + h), t: g => { g.translate(0, h); g.scale(1, -1); } };
    }
  };
  cmd({ cw: 'Rotate 90° CW', ccw: 'Rotate 90° CCW', '180': 'Rotate 180°', flipH: 'Flip Canvas Horizontal', flipV: 'Flip Canvas Vertical' }[kind], () => {
    for (const l of d.layers) {
      textToRaster(l);
      const G = geo(l.canvas, l.x, l.y);
      l.canvas = redraw(l.canvas, G.w, G.h, G.t, false); if (l.mask) l.mask = redraw(l.mask, G.w, G.h, G.t, false);
      l.x = G.x; l.y = G.y; l.rev++;
    }
    const s = d.selection.canvas();
    let m = null;
    if (s) { const G = geo(s, 0, 0); m = U.canvasAlpha(redraw(s, G.w, G.h, G.t, false)); }
    if (swap) { d.width = H; d.height = W; }
    d.selection.w = d.width; d.selection.h = d.height; d.selection.set(m);
  });
  if (swap) PP.app.view.fit();
};
Ops.flipLayer = function (horizontal) {
  const l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  const t = horizontal ? g => { g.translate(l.w, 0); g.scale(-1, 1); } : g => { g.translate(0, l.h); g.scale(1, -1); };
  cmd(horizontal ? 'Flip Layer Horizontal' : 'Flip Layer Vertical', () => {
    l.canvas = redraw(l.canvas, l.w, l.h, t, false); if (l.mask) l.mask = redraw(l.mask, l.mask.width, l.mask.height, t, false); l.rev++;
  });
};
Ops.applyTransform = function (l, m, label = 'Free Transform') {
  const pts = [[0, 0], [l.w, 0], [l.w, l.h], [0, l.h]].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
  const x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
  const w = Math.ceil(Math.max(...pts.map(p => p.x))) - x0, h = Math.ceil(Math.max(...pts.map(p => p.y))) - y0;
  if (!U.validSize(w, h)) { toast('Transformed layer would be too large', 'error'); bus.emit('pixels', { rect: null }); return; }
  const t = g => g.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
  cmd(label, () => {
    l.canvas = redraw(l.canvas, w, h, t); if (l.mask) l.mask = redraw(l.mask, w, h, t);
    l.x = x0; l.y = y0; l.rev++;
  });
};

/* ── per-layer transform panel: rotate, resize, position ── */
/** Rotate the active layer about its centre. Multiples of 90° are exact (no resampling blur). */
Ops.rotateLayer = function (deg) {
  deg = ((+deg % 360) + 360) % 360; if (!deg) return;
  const l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  const r = (deg * Math.PI) / 180, right = deg % 90 === 0;
  const c = right ? Math.round(Math.cos(r)) : Math.cos(r), n = right ? Math.round(Math.sin(r)) : Math.sin(r);
  const cx = l.x + l.w / 2, cy = l.y + l.h / 2, m = { a: c, b: n, c: -n, d: c };
  m.e = cx - (m.a * l.w) / 2 - (m.c * l.h) / 2; m.f = cy - (m.b * l.w) / 2 - (m.d * l.h) / 2;
  if (right) { // land the corners on whole pixels so a 90° turn is a pure pixel shuffle
    const xs = [0, l.w].flatMap(x => [0, l.h].map(y => m.a * x + m.c * y + m.e)), ys = [0, l.w].flatMap(x => [0, l.h].map(y => m.b * x + m.d * y + m.f));
    m.e += Math.round(Math.min(...xs)) - Math.min(...xs); m.f += Math.round(Math.min(...ys)) - Math.min(...ys);
  }
  Ops.applyTransform(l, m, `Rotate Layer ${deg > 180 ? deg - 360 : deg}°`);
};
/** Resize the active layer to w × h px, keeping its top-left corner (high-quality resampling). */
Ops.resizeLayer = function (w, h, label = 'Resize Layer') {
  const l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  w = Math.round(w); h = Math.round(h);
  if (!U.validSize(w, h)) { toast('Invalid layer size', 'warn'); return; }
  if (w === l.w && h === l.h) return;
  cmd(label, () => { l.canvas = resample(l.canvas, w, h, true); if (l.mask) l.mask = resample(l.mask, w, h, true); l.rev++; });
};
/** Scale the active layer to fit inside the canvas (keeping proportions) and centre it. */
Ops.fitLayer = function () {
  const d = doc(), l = Ops.editableLayer({ rasterizeText: true }); if (!l) return;
  const k = Math.min(d.width / l.w, d.height / l.h), w = Math.max(1, Math.round(l.w * k)), h = Math.max(1, Math.round(l.h * k));
  cmd('Fit Layer to Canvas', () => {
    if (w !== l.w || h !== l.h) { l.canvas = resample(l.canvas, w, h, true); if (l.mask) l.mask = resample(l.mask, w, h, true); }
    l.x = Math.round((d.width - w) / 2); l.y = Math.round((d.height - h) / 2); l.rev++;
  });
};
Ops.moveLayerTo = function (x, y) {
  const l = Ops.editableLayer({ any: true }); if (!l || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const x0 = l.x, y0 = l.y; l.x = Math.round(x); l.y = Math.round(y);
  Ops.recordMove(l, x0, y0); bus.emit('pixels', { rect: null }); bus.emit('layers');
};
Ops.centerLayer = function () { const d = doc(), l = d.active; if (l) Ops.moveLayerTo((d.width - l.w) / 2, (d.height - l.h) / 2); };

/* ───────────── filters & adjustments (live preview sessions) ─────────────
 * Preview runs at full resolution in a worker (cancellable, latest wins), limited to the
 * selection bounds plus a margin for spatial kernels. Commit writes the exact preview result. */
Ops.filterSession = function (name, label) {
  const l = Ops.editableLayer({ rasterizeText: true }); if (!l) return null;
  const d = doc(), sb = d.selection.bounds;
  const lr = { x: 0, y: 0, w: l.w, h: l.h };
  let core = sb ? U.intersect({ x: sb.x - l.x, y: sb.y - l.y, w: sb.w, h: sb.h }, lr) : lr;
  if (!core) { toast('Selection does not overlap the active layer', 'warn'); return null; }
  const preview = U.clone(l.canvas);
  l.preview = preview;
  let region = core, orig = null, mask = null, result = null, resultKey = null, pending = null, showOrig = false, closed = false;
  const setRegion = margin => {
    const r = U.intersect({ x: core.x - margin, y: core.y - margin, w: core.w + margin * 2, h: core.h + margin * 2 }, lr);
    if (orig && r.x === region.x && r.y === region.y && r.w === region.w && r.h === region.h) return;
    region = r; orig = U.read(l.canvas, r.x, r.y, r.w, r.h); result = null; resultKey = null;
    const pg = preview.getContext('2d'); pg.globalCompositeOperation = 'copy'; pg.drawImage(l.canvas, 0, 0); pg.globalCompositeOperation = 'source-over';
    const sm = l.selMask(d.selection);
    mask = null;
    if (sm) { mask = new Uint8Array(r.w * r.h); for (let y = 0; y < r.h; y++) mask.set(sm.subarray((r.y + y) * l.w + r.x, (r.y + y) * l.w + r.x + r.w), y * r.w); }
  };
  const marginOf = p => Math.ceil(3 * Math.max(p.radius || 0, p.distance || 0, p.size || 0)) + 2;
  const show = () => {
    const g = preview.getContext('2d');
    if (showOrig || !result) g.putImageData(orig, region.x, region.y);
    else g.putImageData(new ImageData(result, region.w, region.h), region.x, region.y);
    l.preview = preview; l.touch(region);
  };
  const S = {
    layer: l,
    update(params) {
      if (closed) return Promise.resolve();
      setRegion(marginOf(params));
      const key = JSON.stringify(params), reg = region;
      pending = PP.Jobs.filter(name, orig, params, mask, 'preview').then(out => {
        if (closed || reg !== region) return;
        result = out; resultKey = key; show();
      }, e => { if (!e || !e.cancelled) { console.error(e); toast('Filter failed: ' + (e && e.message), 'error'); } });
      return pending;
    },
    toggleOriginal(v) { showOrig = v; if (orig) show(); },
    async commit(params) {
      const key = JSON.stringify(params);
      if (resultKey !== key) await S.update(params);
      if (closed) return;
      closed = true; PP.Jobs.cancel('preview');
      l.preview = null;
      if (!result) { l.touch(); return; }
      const e = new M.PixelEdit(l); e.save(region);
      U.write(l.canvas, new ImageData(result, region.w, region.h), region.x, region.y);
      l.touch(region); e.commit(label);
    },
    cancel() { if (closed) return; closed = true; PP.Jobs.cancel('preview'); l.preview = null; l.touch(); },
    histogram() { setRegion(0); return P.histogram(orig); }
  };
  return S;
};
/** One-shot filter (no dialog). */
Ops.applyFilter = function (name, params, label) {
  const s = Ops.filterSession(name, label);
  if (s) { PP.UI.busy(true); s.commit(params || {}).finally(() => PP.UI.busy(false)); }
};
})();
