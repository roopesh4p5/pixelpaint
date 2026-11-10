/* PixelPaint · pixel.js — PixelProcessing / MaskEngine / FilterEngine / AdjustmentEngine
 *
 * Pure, deterministic image and mask algorithms. No DOM access, no AI.
 * The factory is stringified into a Web Worker (core.js), so it must not
 * reference anything outside its own body.
 *
 * Conventions
 *  - Images: {data: Uint8ClampedArray RGBA, width, height} (ImageData-compatible).
 *  - Masks: Uint8Array, one byte per pixel. 0 = unselected, 255 = selected.
 *  - Spatial filters run on premultiplied alpha so transparent RGB never bleeds (no halos).
 *  - Image borders are handled by clamping (edge pixels extend outward).
 */
(function (root) {
'use strict';

function PixelFactory() {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ───────────── separable blur primitives (interleaved float buffers, c channels) ───────────── */

  function boxH(src, dst, w, h, c, r) {
    const inv = 1 / (2 * r + 1), wm = w - 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let ch = 0; ch < c; ch++) {
        let acc = src[row * c + ch] * (r + 1);
        for (let j = 1; j <= r; j++) acc += src[(row + (j < wm ? j : wm)) * c + ch];
        for (let x = 0; x < w; x++) {
          dst[(row + x) * c + ch] = acc * inv;
          const a = x + r + 1, b = x - r;
          acc += src[(row + (a < wm ? a : wm)) * c + ch] - src[(row + (b > 0 ? b : 0)) * c + ch];
        }
      }
    }
  }

  // Row-major vertical pass (cache friendly): one running accumulator per column/channel.
  function boxV(src, dst, w, h, c, r) {
    const inv = 1 / (2 * r + 1), hm = h - 1, n = w * c, acc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = src[i] * (r + 1);
      for (let j = 1; j <= r; j++) s += src[(j < hm ? j : hm) * n + i];
      acc[i] = s;
    }
    for (let y = 0; y < h; y++) {
      const o = y * n, a = (y + r + 1 < hm ? y + r + 1 : hm) * n, b = (y - r > 0 ? y - r : 0) * n;
      for (let i = 0; i < n; i++) { dst[o + i] = acc[i] * inv; acc[i] += src[a + i] - src[b + i]; }
    }
  }

  function kernel1D(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) s += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }

  function convH(src, dst, w, h, c, k) {
    const r = (k.length - 1) >> 1, wm = w - 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < c; ch++) {
          let s = 0;
          for (let j = -r; j <= r; j++) { const xx = clamp(x + j, 0, wm); s += src[(row + xx) * c + ch] * k[j + r]; }
          dst[(row + x) * c + ch] = s;
        }
      }
    }
  }

  function convV(src, dst, w, h, c, k) {
    const r = (k.length - 1) >> 1, hm = h - 1, n = w * c;
    for (let y = 0; y < h; y++) {
      const o = y * n;
      for (let i = 0; i < n; i++) dst[o + i] = 0;
      for (let j = -r; j <= r; j++) {
        const yy = clamp(y + j, 0, hm) * n, kv = k[j + r];
        for (let i = 0; i < n; i++) dst[o + i] += src[yy + i] * kv;
      }
    }
  }

  // Box sizes approximating a Gaussian with three passes (Kutskir / Wells).
  function gaussRadii(sigma) {
    const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    const out = [];
    for (let i = 0; i < n; i++) out.push(((i < m ? wl : wu) - 1) >> 1);
    return out;
  }

  /** Gaussian blur of a float buffer. Exact kernel for small sigma, 3×box (O(n)) otherwise. */
  function gaussFloat(buf, w, h, c, sigma) {
    if (!(sigma > 0)) return buf;
    const tmp = new Float32Array(buf.length);
    if (sigma < 2) { const k = kernel1D(sigma); convH(buf, tmp, w, h, c, k); convV(tmp, buf, w, h, c, k); return buf; }
    for (const r of gaussRadii(sigma)) if (r > 0) { boxH(buf, tmp, w, h, c, r); boxV(tmp, buf, w, h, c, r); }
    return buf;
  }

  /* ───────────── premultiplied helpers ───────────── */

  function toPremul(d) {
    const f = new Float32Array(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      f[i] = d[i] * a; f[i + 1] = d[i + 1] * a; f[i + 2] = d[i + 2] * a; f[i + 3] = d[i + 3];
    }
    return f;
  }

  function fromPremul(f, out) {
    out = out || new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i += 4) {
      const a = f[i + 3];
      if (a < 0.5) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
      const k = 255 / a;
      out[i] = f[i] * k; out[i + 1] = f[i + 1] * k; out[i + 2] = f[i + 2] * k; out[i + 3] = a;
    }
    return out;
  }

  /** Blend result back over original by a selection mask (0…255). Returns res. */
  function mixMask(orig, res, mask) {
    if (!mask) return res;
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      const m = mask[p];
      if (m === 255) continue;
      if (m === 0) { res[i] = orig[i]; res[i + 1] = orig[i + 1]; res[i + 2] = orig[i + 2]; res[i + 3] = orig[i + 3]; continue; }
      const t = m / 255;
      for (let c = 0; c < 4; c++) res[i + c] = orig[i + c] + (res[i + c] - orig[i + c]) * t;
    }
    return res;
  }

  const luma = (r, g, b) => (54 * r + 183 * g + 19 * b) >> 8; // Rec.709 weights, integer form (sum 256)

  function conv3Premul(img, k, bias, keepAlpha) {
    const { width: w, height: h, data: s } = img, f = toPremul(s), o = new Float32Array(f.length);
    const wm = w - 1, hm = h - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        let acc = 0, ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = clamp(y + dy, 0, hm) * w;
          for (let dx = -1; dx <= 1; dx++) acc += f[(yy + clamp(x + dx, 0, wm)) * 4 + c] * k[ki++];
        }
        o[i + c] = acc + (c < 3 ? bias : 0);
      }
      o[i + 3] = keepAlpha ? f[i + 3] : clamp(o[i + 3], 0, 255);
      for (let c = 0; c < 3; c++) o[i + c] = clamp(o[i + c], 0, o[i + 3]);
    }
    return fromPremul(o);
  }

  /* ───────────── adjustment engine (LUT + per-pixel colour stage) ───────────── */

  const srgbToLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const linToSrgb = v => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

  /** Neutral parameters. Ranges documented inline; all values are clamped to 0…255 at the end. */
  const ADJUST_DEFAULTS = {
    exposure: 0,      // EV, −5…5, applied in linear light
    brightness: 0,    // −100…100, additive (±127)
    contrast: 0,      // −100…100, classic contrast factor around 128
    gamma: 1,         // 0.1…5
    blacks: 0, whites: 0, // −100…100, move black/white points
    highlights: 0, shadows: 0, // −100…100, luminance-weighted tone shift
    temperature: 0, tint: 0,   // −100…100
    saturation: 0, vibrance: 0, // −100…100
    hue: 0,           // −180…180 degrees (W3C hue-rotate matrix)
    levels: null,     // {inBlack,inWhite,gamma,outBlack,outWhite}
    curves: null,     // {rgb:Uint8Array(256), r, g, b} LUTs
    balance: null     // {shadows:[r,g,b], midtones:[r,g,b], highlights:[r,g,b]} each −100…100
  };

  function buildLuts(p) {
    const base = new Float32Array(256);
    const ev = Math.pow(2, p.exposure || 0);
    const wp = 255 - (p.whites || 0) * 1.275, bp = -(p.blacks || 0) * 1.275;
    const cv = (p.contrast || 0) * 2.55, cf = (259 * (cv + 255)) / (255 * (259 - cv));
    const g = 1 / (p.gamma || 1), L = p.levels;
    for (let i = 0; i < 256; i++) {
      let v = ev === 1 ? i : linToSrgb(srgbToLin(i) * ev);
      v = ((v - bp) * 255) / Math.max(1, wp - bp);
      v += ((p.brightness || 0) * 255) / 200;
      v = cf * (v - 128) + 128;
      v = 255 * Math.pow(clamp(v, 0, 255) / 255, g);
      if (L) {
        const t = clamp((v - L.inBlack) / Math.max(1, L.inWhite - L.inBlack), 0, 1);
        v = L.outBlack + Math.pow(t, 1 / (L.gamma || 1)) * (L.outWhite - L.outBlack);
      }
      base[i] = clamp(v, 0, 255);
    }
    const C = p.curves, luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    for (let i = 0; i < 256; i++) {
      let v = Math.round(base[i]);
      if (C && C.rgb) v = C.rgb[v];
      for (let c = 0; c < 3; c++) luts[c][i] = C && C[['r', 'g', 'b'][c]] ? C[['r', 'g', 'b'][c]][v] : v;
    }
    return luts;
  }

  // Additive per-channel delta indexed by luminance: shadows/highlights + colour balance.
  function buildToneDelta(p) {
    const sh = (p.shadows || 0) / 100, hl = (p.highlights || 0) / 100, B = p.balance;
    if (!sh && !hl && !B) return null;
    const d = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < 256; i++) {
      const l = i / 255, wS = (1 - l) * (1 - l), wH = l * l, wM = 1 - wS - wH;
      const tone = 64 * (sh * wS + hl * wH);
      for (let c = 0; c < 3; c++) {
        let v = tone;
        if (B) v += 0.64 * (B.shadows[c] * wS + B.midtones[c] * wM + B.highlights[c] * wH);
        d[c][i] = v;
      }
    }
    return d;
  }

  function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    return [
      0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072
    ];
  }

  function adjust(img, params) {
    const p = Object.assign({}, ADJUST_DEFAULTS, params);
    const s = img.data, o = new Uint8ClampedArray(s.length);
    const [lr, lg, lb] = buildLuts(p), td = buildToneDelta(p);
    const tr = (p.temperature || 0) * 0.5, tt = (p.tint || 0) * 0.5;
    const M = p.hue ? hueMatrix(p.hue) : null;
    const sat = 1 + (p.saturation || 0) / 100, vib = (p.vibrance || 0) / 100;
    const colour = tr || tt || M || sat !== 1 || vib;
    for (let i = 0; i < s.length; i += 4) {
      let r = lr[s[i]], g = lg[s[i + 1]], b = lb[s[i + 2]];
      if (td) { const l = luma(r, g, b); r += td[0][l]; g += td[1][l]; b += td[2][l]; }
      if (colour) {
        r += tr; b -= tr; g -= tt;
        if (M) {
          const R = r, G = g, B = b;
          r = M[0] * R + M[1] * G + M[2] * B; g = M[3] * R + M[4] * G + M[5] * B; b = M[6] * R + M[7] * G + M[8] * B;
        }
        let k = sat;
        if (vib) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); k *= 1 + vib * (1 - clamp((mx - mn) / 255, 0, 1)); }
        if (k !== 1) { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
      }
      o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = s[i + 3];
    }
    return o;
  }

  /* ───────────── filters ───────────── */

  function copy(img) { return new Uint8ClampedArray(img.data); }

  function gaussian(img, { radius = 2 }) {
    return fromPremul(gaussFloat(toPremul(img.data), img.width, img.height, 4, radius));
  }

  function boxBlur(img, { radius = 2 }) {
    const r = Math.round(radius); if (r < 1) return copy(img);
    const f = toPremul(img.data), t = new Float32Array(f.length);
    boxH(f, t, img.width, img.height, 4, r); boxV(t, f, img.width, img.height, 4, r);
    return fromPremul(f);
  }

  // Huang's sliding-histogram median with incremental median tracking: O(r) per pixel.
  function median(img, { radius = 1 }) {
    const r = Math.round(radius), { width: w, height: h, data: s } = img;
    if (r < 1) return copy(img);
    const o = new Uint8ClampedArray(s.length), hist = new Int32Array(1024);
    const half = ((2 * r + 1) * (2 * r + 1)) >> 1, wm = w - 1, hm = h - 1;
    const med = new Int32Array(4), lt = new Int32Array(4);
    const col = (x, sign, y) => {
      x = clamp(x, 0, wm);
      for (let dy = -r; dy <= r; dy++) {
        const i = (clamp(y + dy, 0, hm) * w + x) * 4;
        for (let c = 0; c < 4; c++) { const v = s[i + c]; hist[c * 256 + v] += sign; if (v < med[c]) lt[c] += sign; }
      }
    };
    for (let y = 0; y < h; y++) {
      hist.fill(0); med.fill(0); lt.fill(0);
      for (let dx = -r; dx <= r; dx++) col(dx, 1, y);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          const H = c * 256; let m = med[c], l = lt[c];
          while (l > half) { m--; l -= hist[H + m]; }
          while (l + hist[H + m] <= half) { l += hist[H + m]; m++; }
          med[c] = m; lt[c] = l; o[i + c] = m;
        }
        col(x - r, -1, y); col(x + r + 1, 1, y);
      }
    }
    return o;
  }

  function sharpen(img, { amount = 50 }) {
    const a = amount / 50;
    return conv3Premul(img, [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0], 0, true);
  }

  function unsharp(img, { amount = 100, radius = 2, threshold = 0 }) {
    const f = toPremul(img.data), b = gaussFloat(new Float32Array(f), img.width, img.height, 4, radius), k = amount / 100;
    for (let i = 0; i < f.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const d = f[i + c] - b[i + c];
        if (Math.abs(d) >= threshold) f[i + c] = clamp(f[i + c] + d * k, 0, f[i + 3]);
      }
    }
    return fromPremul(f);
  }

  function edges(img) { return conv3Premul(img, [-1, -1, -1, -1, 8, -1, -1, -1, -1], 0, true); }

  function emboss(img, { strength = 1 }) {
    const { width: w, height: h, data: s } = img, o = new Uint8ClampedArray(s.length), L = grayPlane(img);
    const wm = w - 1, hm = h - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = (dx, dy) => L[clamp(y + dy, 0, hm) * w + clamp(x + dx, 0, wm)];
      const v = 128 + strength * (at(1, 1) + at(1, 0) + at(0, 1) - at(-1, -1) - at(-1, 0) - at(0, -1));
      const i = (y * w + x) * 4; o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = s[i + 3];
    }
    return o;
  }

  function grayPlane(img) {
    const s = img.data, L = new Float32Array(img.width * img.height);
    for (let p = 0, i = 0; p < L.length; p++, i += 4) L[p] = luma(s[i], s[i + 1], s[i + 2]);
    return L;
  }

  /** Sobel gradient magnitude of luminance. Float32Array, ~0…1442. Also used by the magnetic lasso. */
  function sobelMagnitude(img) {
    const { width: w, height: h } = img, L = grayPlane(img), g = new Float32Array(w * h), wm = w - 1, hm = h - 1;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1) * w, y1 = y * w, y2 = Math.min(hm, y + 1) * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x2 = Math.min(wm, x + 1);
        const gx = L[y0 + x2] + 2 * L[y1 + x2] + L[y2 + x2] - L[y0 + x0] - 2 * L[y1 + x0] - L[y2 + x0];
        const gy = L[y2 + x0] + 2 * L[y2 + x] + L[y2 + x2] - L[y0 + x0] - 2 * L[y0 + x] - L[y0 + x2];
        g[y1 + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return g;
  }

  function sobel(img) {
    const g = sobelMagnitude(img), s = img.data, o = new Uint8ClampedArray(s.length);
    for (let p = 0, i = 0; p < g.length; p++, i += 4) { o[i] = o[i + 1] = o[i + 2] = g[p] / 4; o[i + 3] = s[i + 3]; }
    return o;
  }

  function perPixel(img, fn) {
    const s = img.data, o = new Uint8ClampedArray(s.length);
    for (let i = 0; i < s.length; i += 4) fn(s, o, i);
    return o;
  }

  const grayscale = img => perPixel(img, (s, o, i) => { o[i] = o[i + 1] = o[i + 2] = luma(s[i], s[i + 1], s[i + 2]); o[i + 3] = s[i + 3]; });
  const invert = img => perPixel(img, (s, o, i) => { o[i] = 255 - s[i]; o[i + 1] = 255 - s[i + 1]; o[i + 2] = 255 - s[i + 2]; o[i + 3] = s[i + 3]; });
  const sepia = img => perPixel(img, (s, o, i) => {
    const r = s[i], g = s[i + 1], b = s[i + 2];
    o[i] = 0.393 * r + 0.769 * g + 0.189 * b; o[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b; o[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b; o[i + 3] = s[i + 3];
  });

  function posterize(img, { levels = 4 }) {
    const n = clamp(Math.round(levels), 2, 255) - 1, lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = (Math.round((i / 255) * n) * 255) / n;
    return perPixel(img, (s, o, i) => { o[i] = lut[s[i]]; o[i + 1] = lut[s[i + 1]]; o[i + 2] = lut[s[i + 2]]; o[i + 3] = s[i + 3]; });
  }

  function pixelate(img, { size = 8 }) {
    const n = Math.max(1, Math.round(size)), { width: w, height: h } = img, f = toPremul(img.data);
    for (let by = 0; by < h; by += n) for (let bx = 0; bx < w; bx += n) {
      const ex = Math.min(w, bx + n), ey = Math.min(h, by + n), acc = [0, 0, 0, 0];
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 4; for (let c = 0; c < 4; c++) acc[c] += f[i + c]; }
      const cnt = (ex - bx) * (ey - by);
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 4; for (let c = 0; c < 4; c++) f[i + c] = acc[c] / cnt; }
    }
    return fromPremul(f);
  }

  function vignette(img, { amount = 50, size = 50 }) {
    const { width: w, height: h } = img, cx = w / 2, cy = h / 2, k = amount / 100, inner = clamp(size / 100, 0, 0.99) * 1.4142;
    return perPixel(img, (s, o, i) => {
      const p = i >> 2, x = p % w, y = (p / w) | 0;
      const dx = (x + 0.5 - cx) / cx, dy = (y + 0.5 - cy) / cy, d = Math.sqrt(dx * dx + dy * dy);
      let t = clamp((d - inner) / (1.4142 - inner), 0, 1); t = t * t * (3 - 2 * t);
      for (let c = 0; c < 3; c++) o[i + c] = k >= 0 ? s[i + c] * (1 - k * t) : s[i + c] + (255 - s[i + c]) * -k * t;
      o[i + 3] = s[i + 3];
    });
  }

  function noise(img, { amount = 20, mono = true, seed = 1 }) {
    let st = seed >>> 0 || 1;
    const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const g = () => (rnd() + rnd() + rnd() - 1.5) * 2, k = amount * 0.64;
    return perPixel(img, (s, o, i) => {
      const n = mono ? g() * k : 0;
      for (let c = 0; c < 3; c++) o[i + c] = s[i + c] + (mono ? n : g() * k);
      o[i + 3] = s[i + 3];
    });
  }

  function motionBlur(img, { angle = 0, distance = 10 }) {
    const { width: w, height: h } = img, f = toPremul(img.data), o = new Float32Array(f.length);
    const a = (angle * Math.PI) / 180, d = Math.max(1, Math.round(distance)), offs = [];
    for (let t = -d / 2; t <= d / 2 + 1e-9; t++) offs.push([Math.round(t * Math.cos(a)), Math.round(-t * Math.sin(a))]);
    const inv = 1 / offs.length, wm = w - 1, hm = h - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (const [dx, dy] of offs) {
        const j = (clamp(y + dy, 0, hm) * w + clamp(x + dx, 0, wm)) * 4;
        o[i] += f[j]; o[i + 1] += f[j + 1]; o[i + 2] += f[j + 2]; o[i + 3] += f[j + 3];
      }
      o[i] *= inv; o[i + 1] *= inv; o[i + 2] *= inv; o[i + 3] *= inv;
    }
    return fromPremul(o);
  }

  /** Chroma key: alpha ramp on RGB distance; spill = clamp key-dominant channel toward max(others). */
  function chromaKey(img, { key = [0, 255, 0], tolerance = 60, softness = 40, spill = 50 }) {
    const kd = key.indexOf(Math.max(key[0], key[1], key[2])), o1 = (kd + 1) % 3, o2 = (kd + 2) % 3, sp = spill / 100;
    return perPixel(img, (s, o, i) => {
      const dr = s[i] - key[0], dg = s[i + 1] - key[1], db = s[i + 2] - key[2];
      const d = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
      const m = d <= tolerance ? 0 : softness > 0 && d < tolerance + softness ? (d - tolerance) / softness : 1;
      o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = s[i + 3] * m;
      const lim = Math.max(s[i + o1], s[i + o2]);
      if (sp && s[i + kd] > lim) o[i + kd] = s[i + kd] - (s[i + kd] - lim) * sp;
    });
  }

  const FILTERS = {
    adjust: (img, p) => adjust(img, p),
    gaussian, boxBlur, median, sharpen, unsharp, edges, emboss, sobel,
    grayscale, invert, sepia, posterize, pixelate, vignette, noise, motionBlur, chromaKey
  };

  /** Run a named filter and blend by optional selection mask. Returns Uint8ClampedArray. */
  function runFilter(name, img, params, mask) {
    const fn = FILTERS[name];
    if (!fn) throw new Error('Unknown filter: ' + name);
    return mixMask(img.data, fn(img, params || {}), mask);
  }

  function histogram(img) {
    const s = img.data, r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    for (let i = 0; i < s.length; i += 4) { if (!s[i + 3]) continue; r[s[i]]++; g[s[i + 1]]++; b[s[i + 2]]++; l[luma(s[i], s[i + 1], s[i + 2])]++; }
    return { r, g, b, l };
  }

  /* ───────────── selection / mask engine ───────────── */

  function combine(a, b, mode) {
    const n = b.length, o = new Uint8Array(n);
    if (mode === 'replace' || (!a && mode === 'add')) { o.set(b); return o; }
    if (!a) return o; // subtract / intersect from nothing → nothing
    if (mode === 'add') for (let i = 0; i < n; i++) o[i] = a[i] > b[i] ? a[i] : b[i];
    else if (mode === 'subtract') for (let i = 0; i < n; i++) { const v = 255 - b[i]; o[i] = a[i] < v ? a[i] : v; }
    else for (let i = 0; i < n; i++) o[i] = a[i] < b[i] ? a[i] : b[i];
    return o;
  }

  function invertMask(m) { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = 255 - m[i]; return o; }

  function blurMask(m, w, h, sigma) {
    const f = Float32Array.from(m);
    gaussFloat(f, w, h, 1, sigma);
    const o = new Uint8Array(m.length);
    for (let i = 0; i < f.length; i++) o[i] = clamp(Math.round(f[i]), 0, 255);
    return o;
  }

  /** Feather: Gaussian blur of the mask only. sigma = radius / 2 → transition spans ≈ ±radius px. */
  const feather = (m, w, h, radius) => (radius > 0 ? blurMask(m, w, h, radius / 2) : m.slice());

  // Felzenszwalb–Huttenlocher exact squared Euclidean distance transform.
  function edt(feature, w, h) {
    const INF = 1e20, n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n);
    const v = new Int32Array(n), z = new Float64Array(n + 1), D = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) D[i] = feature[i] ? 0 : INF;
    const pass = len => {
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      const isect = q => { const p = v[k]; return (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p); };
      for (let q = 1; q < len; q++) {
        let s = isect(q);
        while (s <= z[k]) { k--; s = isect(q); } // z[0] = −∞ guarantees termination at k = 0
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
    };
    for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = D[y * w + x]; pass(h); for (let y = 0; y < h; y++) D[y * w + x] = d[y]; }
    for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) f[x] = D[o + x]; pass(w); for (let x = 0; x < w; x++) D[o + x] = d[x]; }
    return D;
  }

  /** Expand by a disk of radius r (px). Antialiased by sub-pixel distance. */
  function expand(m, w, h, r) {
    const feat = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) feat[i] = m[i] >= 128;
    const D = edt(feat, w, h), o = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) { const v = clamp((r + 1 - Math.sqrt(D[i])) * 255, 0, 255); o[i] = v > m[i] ? v : m[i]; }
    return o;
  }

  /** Contract by a disk of radius r (px). Canvas bounds are not treated as unselected. */
  function contract(m, w, h, r) {
    const feat = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) feat[i] = m[i] < 128;
    const D = edt(feat, w, h), o = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) { const v = clamp((Math.sqrt(D[i]) - r) * 255, 0, 255); o[i] = v < m[i] ? v : m[i]; }
    return o;
  }

  function border(m, w, h, width) {
    const hw = width / 2, a = expand(m, w, h, hw), b = contract(m, w, h, hw), o = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) { const v = 255 - b[i]; o[i] = a[i] < v ? a[i] : v; }
    return o;
  }

  /** Smooth: blur then re-threshold with a soft ramp — rounds jagged contours, keeps a thin AA edge. */
  function smooth(m, w, h, radius) {
    const b = blurMask(m, w, h, Math.max(0.5, radius / 2));
    for (let i = 0; i < b.length; i++) b[i] = clamp(Math.round((b[i] - 127.5) * 4 + 127.5), 0, 255);
    return b;
  }

  /** One-pixel antialias for hard masks (3×3 box on boundary pixels only). */
  function antialias(m, w, h) {
    const o = m.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, v = m[i];
      const edge = (x > 0 && m[i - 1] !== v) || (x < w - 1 && m[i + 1] !== v) || (y > 0 && m[i - w] !== v) || (y < h - 1 && m[i + w] !== v);
      if (!edge) continue;
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += m[yy * w + xx]; c++;
      }
      o[i] = Math.round(s / c);
    }
    return o;
  }

  function bounds(m, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let rowHit = false;
      for (let x = 0; x < w; x++) if (m[o + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; rowHit = true; }
      if (rowHit) { if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Boundary segments of the 50 % iso-line (pixel edges), merged into runs. Float32Array [x1,y1,x2,y2,…]. */
  function outline(m, w, h, bb) {
    bb = bb || bounds(m, w, h);
    if (!bb) return new Float32Array(0);
    const segs = [], X0 = bb.x, X1 = bb.x + bb.w, Y0 = bb.y, Y1 = bb.y + bb.h;
    const sel = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] >= 128;
    for (let y = Y0; y <= Y1; y++) {
      let start = -1;
      for (let x = X0; x <= X1; x++) {
        const e = x < X1 && sel(x, y - 1) !== sel(x, y);
        if (e && start < 0) start = x; else if (!e && start >= 0) { segs.push(start, y, x, y); start = -1; }
      }
    }
    const run = new Int32Array(X1 - X0 + 1).fill(-1);
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        const e = y < Y1 && sel(x - 1, y) !== sel(x, y), k = x - X0;
        if (e && run[k] < 0) run[k] = y; else if (!e && run[k] >= 0) { segs.push(x, run[k], x, y); run[k] = -1; }
      }
    }
    return Float32Array.from(segs);
  }

  /** Premultiplied RGBA distance / 2 → 0…255 scale (transparent pixels are all equal). */
  function colorDistFn(s, ref) {
    const ra = ref[3] / 255, R = ref[0] * ra, G = ref[1] * ra, B = ref[2] * ra, A = ref[3];
    return i => {
      const a = s[i + 3] / 255, dr = s[i] * a - R, dg = s[i + 1] * a - G, db = s[i + 2] * a - B, da = s[i + 3] - A;
      return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2;
    };
  }

  /** Magic wand / flood region. Iterative scanline fill (no recursion). Returns 0/255 mask. */
  function floodMask(img, sx, sy, { tolerance = 32, contiguous = true, diagonal = false } = {}) {
    const { width: w, height: h, data: s } = img, mask = new Uint8Array(w * h);
    sx = Math.floor(sx); sy = Math.floor(sy);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
    const si = (sy * w + sx) * 4, dist = colorDistFn(s, [s[si], s[si + 1], s[si + 2], s[si + 3]]);
    const ok = p => dist(p * 4) <= tolerance;
    if (!contiguous) { for (let p = 0; p < mask.length; p++) if (ok(p)) mask[p] = 255; return mask; }
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop(), row = y * w;
      if (mask[row + x]) continue;
      let lx = x, rx = x;
      while (lx > 0 && !mask[row + lx - 1] && ok(row + lx - 1)) lx--;
      while (rx < w - 1 && !mask[row + rx + 1] && ok(row + rx + 1)) rx++;
      for (let i = lx; i <= rx; i++) mask[row + i] = 255;
      const a = diagonal ? Math.max(0, lx - 1) : lx, b = diagonal ? Math.min(w - 1, rx + 1) : rx;
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nr = ny * w;
        for (let i = a; i <= b; i++) {
          if (mask[nr + i] || !ok(nr + i)) continue;
          stack.push(i, ny);
          while (i < b && !mask[nr + i + 1] && ok(nr + i + 1)) i++;
        }
      }
    }
    return mask;
  }

  /** Colour Range: global (non-contiguous) selection with a soft fuzziness ramp. */
  function colorRangeMask(img, color, { tolerance = 32, fuzziness = 16 } = {}) {
    const s = img.data, n = img.width * img.height, m = new Uint8Array(n), dist = colorDistFn(s, color);
    for (let p = 0; p < n; p++) {
      const d = dist(p * 4);
      m[p] = d <= tolerance ? 255 : fuzziness > 0 && d < tolerance + fuzziness ? Math.round(255 * (1 - (d - tolerance) / fuzziness)) : 0;
    }
    return m;
  }

  function alphaToMask(img) {
    const s = img.data, m = new Uint8Array(img.width * img.height);
    for (let p = 0; p < m.length; p++) m[p] = s[p * 4 + 3];
    return m;
  }

  /** Multiply alpha by mask (keep = true) or by its inverse. Exact: m = 255 leaves pixels untouched. */
  function applyMaskToAlpha(data, mask, keep) {
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) {
      const m = keep ? mask[p] : 255 - mask[p];
      if (m !== 255) data[i] = Math.round((data[i] * m) / 255);
    }
    return data;
  }

  /** Source-over a solid colour through a mask (fill bucket). */
  function fillThroughMask(data, mask, rgb, opacity) {
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      if (!mask[p]) continue;
      const sa = (mask[p] / 255) * opacity, da = data[i + 3] / 255, oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      for (let c = 0; c < 3; c++) data[i + c] = (rgb[c] * sa + data[i + c] * da * (1 - sa)) / oa;
      data[i + 3] = oa * 255;
    }
    return data;
  }

  /* RLE for masks (history/project storage): [value, varint runLength]… */
  function rleEncode(m) {
    const out = []; let i = 0;
    while (i < m.length) {
      const v = m[i]; let j = i + 1; while (j < m.length && m[j] === v) j++;
      let n = j - i; out.push(v);
      while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
      out.push(n); i = j;
    }
    return Uint8Array.from(out);
  }

  function rleDecode(buf, length) {
    const m = new Uint8Array(length); let i = 0, p = 0;
    while (i < buf.length && p < length) {
      const v = buf[i++]; let n = 0, shift = 0, b;
      do { b = buf[i++]; n |= (b & 127) << shift; shift += 7; } while (b & 128);
      if (v) m.fill(v, p, Math.min(length, p + n));
      p += n;
    }
    return m;
  }

  return {
    ADJUST_DEFAULTS, runFilter, FILTERS, adjust, histogram, sobelMagnitude, mixMask,
    combine, invertMask, feather, expand, contract, border, smooth, antialias, bounds, outline,
    floodMask, colorRangeMask, alphaToMask, applyMaskToAlpha, fillThroughMask, rleEncode, rleDecode, blurMask
  };
}

root.PP = root.PP || {};
root.PP.PixelFactory = PixelFactory;
root.PP.Pixel = PixelFactory();
})(typeof globalThis !== 'undefined' ? globalThis : self);
