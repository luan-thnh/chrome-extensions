(() => {
  'use strict';
  if (globalThis.__CANVORA__) return;

  const VIEWER_HINT = /(pdf|document|viewer|preview|reader|page|sheet|slide|paper|canvas)/i;
  const PDF_SOURCE = /(?:\.pdf(?:$|[?#])|application\/pdf)/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function collectRoots() {
    const roots = [document];
    const queue = [document.documentElement];
    const seen = new Set();
    while (queue.length) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
        queue.push(...node.shadowRoot.querySelectorAll('*'));
      }
      if (node.querySelectorAll) queue.push(...node.querySelectorAll(':scope > *'));
      if (seen.size > 5000) break;
    }
    return roots;
  }

  function queryAll(selector) {
    const out = [];
    const seen = new Set();
    for (const root of collectRoots()) {
      for (const el of root.querySelectorAll(selector)) {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
    }
    return out;
  }

  function contextText(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
      parts.push(node.id || '', typeof node.className === 'string' ? node.className : '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('role') || '');
    }
    return parts.join(' ');
  }

  function inferPageNumber(el) {
    let node = el;
    for (let i = 0; node && i < 7; i += 1, node = node.parentElement) {
      const indexed = node.getAttribute?.('data-index');
      if (indexed != null && /^\s*\d{1,5}\s*$/.test(indexed)) return Number(indexed) + 1;
      const attrs = [
        node.getAttribute?.('data-page-number'), node.getAttribute?.('data-page'),
        node.getAttribute?.('aria-label'), node.id,
      ].filter(Boolean);
      for (const raw of attrs) {
        const direct = String(raw).match(/^\s*(\d{1,5})\s*$/);
        if (direct) return Number(direct[1]);
        const labeled = String(raw).match(/(?:page|trang|slide|sheet)[^\d]{0,8}(\d{1,5})/i);
        if (labeled) return Number(labeled[1]);
      }
    }
    return null;
  }

  function isLargeMedia(el, width, height) {
    const area = width * height;
    if (width < 220 || height < 220 || area < 90000) return false;
    const ratio = width / height;
    const hint = VIEWER_HINT.test(contextText(el));
    return hint || (area >= 180000 && ratio > 0.35 && ratio < 2.8);
  }

  function canvasCandidates(smart = true) {
    const all = queryAll('canvas').filter((canvas) => canvas.width > 0 && canvas.height > 0);
    if (!smart) return all;
    return all.filter((canvas) => isLargeMedia(canvas, canvas.width, canvas.height));
  }

  function imageCandidates() {
    return queryAll('img').filter((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return isLargeMedia(img, w, h) && VIEWER_HINT.test(contextText(img));
    });
  }

  function svgCandidates() {
    return queryAll('svg').filter((svg) => {
      const rect = svg.getBoundingClientRect();
      const vb = svg.viewBox?.baseVal;
      const w = vb?.width || rect.width;
      const h = vb?.height || rect.height;
      return isLargeMedia(svg, w, h) && VIEWER_HINT.test(contextText(svg));
    });
  }

  function detectViewerTypes() {
    const text = `${document.documentElement?.className || ''} ${document.body?.className || ''}`;
    const types = [];
    if (document.querySelector('.pdfViewer, #viewerContainer, #viewer .page')) types.push('PDF.js');
    if (document.querySelector('.react-pdf__Document, .react-pdf__Page')) types.push('React-PDF');
    if (document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')) types.push('Native PDF');
    if (/pspdfkit/i.test(text) || document.querySelector('[class*="PSPDFKit"], [class*="pspdfkit"]')) types.push('PSPDFKit-like');
    if (/webviewer|pdftron|apryse/i.test(text) || document.querySelector('[class*="DocumentContainer"], [data-element="documentContainer"]')) types.push('WebViewer-like');
    if (document.querySelector('#pdfframe')) types.push('#pdfframe');
    if (!types.length && canvasCandidates(true).length) types.push('Canvas viewer');
    return [...new Set(types)];
  }

  function normalizeUrl(raw) {
    if (!raw) return null;
    try { return new URL(raw, location.href).href; } catch { return raw; }
  }

  function detectPdfSources() {
    const found = [];
    const add = (url, kind) => {
      url = normalizeUrl(url);
      if (!url) return;
      if (!found.some((x) => x.url === url)) found.push({ url, kind });
    };

    if (PDF_SOURCE.test(location.href)) add(location.href, 'page');
    for (const el of queryAll('embed, object, iframe, a')) {
      const raw = el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href');
      const type = el.getAttribute('type') || '';
      if (!raw) continue;
      if (PDF_SOURCE.test(raw) || /application\/pdf/i.test(type) || /^blob:/i.test(raw)) add(raw, el.tagName.toLowerCase());
    }
    return found.slice(0, 20);
  }

  function findScrollableElements() {
    const out = [];
    const candidates = [document.scrollingElement, ...queryAll('div, main, section, article')].filter(Boolean);
    for (const el of candidates) {
      const ch = el === document.scrollingElement ? window.innerHeight : el.clientHeight;
      const sh = el.scrollHeight;
      const cw = el === document.scrollingElement ? window.innerWidth : el.clientWidth;
      if (ch >= 220 && cw >= 260 && sh > ch + 240) out.push(el);
    }
    return [...new Set(out)];
  }

  function scrollTargetScore(el) {
    let score = Math.min(10000, el.scrollHeight - (el.clientHeight || window.innerHeight));
    const hint = contextText(el);
    if (VIEWER_HINT.test(hint)) score += 20000;
    try { score += el.querySelectorAll('canvas, .page, [data-page-number], img, svg').length * 2500; } catch {}
    if (el === document.scrollingElement) score += 1000;
    return score;
  }

  function detect() {
    const smart = canvasCandidates(true);
    const all = canvasCandidates(false);
    const largestCanvas = smart.reduce((best, canvas) => {
      if (!best || canvas.width * canvas.height > best.width * best.height) return canvas;
      return best;
    }, null);
    const largestRect = largestCanvas?.getBoundingClientRect?.();
    const sourceResolution = largestCanvas ? {
      width: largestCanvas.width,
      height: largestCanvas.height,
      megapixels: Number(((largestCanvas.width * largestCanvas.height) / 1e6).toFixed(2)),
      cssScale: largestRect?.width > 0 && largestRect?.height > 0
        ? Number(Math.min(largestCanvas.width / largestRect.width, largestCanvas.height / largestRect.height).toFixed(2))
        : null,
    } : null;
    const images = imageCandidates();
    const svgs = svgCandidates();
    const types = detectViewerTypes();
    const pdfSources = detectPdfSources();
    const numbered = [...smart, ...images, ...svgs].map(inferPageNumber).filter(Number.isFinite);
    const hintedPages = numbered.length ? Math.max(...numbered) : 0;
    const pageCount = Math.max(smart.length, hintedPages, images.length, svgs.length);
    const score = pageCount * 120 + types.length * 80 + pdfSources.length * 25 + (smart.length ? 100 : 0);

    return {
      url: location.href,
      title: document.title,
      counts: { smartCanvas: smart.length, allCanvas: all.length, images: images.length, svgs: svgs.length },
      pageCount,
      hintedPages,
      viewerTypes: types,
      pdfSources,
      scrollTargets: findScrollableElements().length,
      sourceResolution,
      score,
    };
  }

  function trimRect(source) {
    const maxSide = 220;
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const a = data[i + 3];
        const nonWhite = a > 12 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245);
        if (nonWhite) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      }
    }
    if (maxX < 0 || maxY < 0) return { x: 0, y: 0, width: source.width, height: source.height };
    const pad = 4;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    return {
      x: Math.floor(minX / scale), y: Math.floor(minY / scale),
      width: Math.min(source.width, Math.ceil((maxX - minX + 1) / scale)),
      height: Math.min(source.height, Math.ceil((maxY - minY + 1) / scale)),
    };
  }

  function rasterizeCanvas(source, { format = 'jpeg', quality = 0.98, trim = false } = {}) {
    // Direct fast paths: when no crop is requested, encode the viewer canvas itself.
    // This intentionally mirrors the proven console snippet:
    // canvas.toDataURL('image/jpeg', 0.95)
    // and avoids an unnecessary drawImage round-trip/resample.
    if (!trim && format === 'png') {
      return { dataUrl: source.toDataURL('image/png'), width: source.width, height: source.height };
    }
    if (!trim && format === 'jpeg') {
      return { dataUrl: source.toDataURL('image/jpeg', quality), width: source.width, height: source.height };
    }

    const crop = trim ? trimRect(source) : { x: 0, y: 0, width: source.width, height: source.height };
    const out = document.createElement('canvas');
    out.width = crop.width; out.height = crop.height;
    const ctx = out.getContext('2d', { alpha: format !== 'jpeg' });
    ctx.imageSmoothingEnabled = false;
    if (format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height); }
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
    return { dataUrl: out.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', quality), width: out.width, height: out.height };
  }

  function fingerprintCanvas(canvas) {
    try {
      const probe = document.createElement('canvas');
      probe.width = 12; probe.height = 12;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, 12, 12);
      const data = ctx.getImageData(0, 0, 12, 12).data;
      let h = 2166136261;
      for (let i = 0; i < data.length; i += 7) { h ^= data[i]; h = Math.imul(h, 16777619); }
      return (h >>> 0).toString(16);
    } catch { return null; }
  }

  async function imageToRaster(img, options) {
    if (!img.complete) await new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); });
    const w = img.naturalWidth || img.width; const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('Image has no dimensions');
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (options.format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    return rasterizeCanvas(canvas, options);
  }

  async function svgToRaster(svg, options) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox?.baseVal;
    const w = Math.max(1, Math.round(vb?.width || rect.width));
    const h = Math.max(1, Math.round(vb?.height || rect.height));
    const text = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (options.format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, 0, 0, w, h);
      return rasterizeCanvas(canvas, options);
    } finally { URL.revokeObjectURL(url); }
  }

  async function capture(options = {}) {
    const settings = {
      smart: options.smart !== false,
      includeMedia: options.includeMedia !== false,
      autoScroll: options.autoScroll !== false,
      trim: options.trim === true,
      format: options.format === 'png' ? 'png' : 'jpeg',
      quality: Math.max(0.6, Math.min(1, Number(options.quality) || 0.98)),
      maxSteps: Math.max(4, Math.min(120, Number(options.maxSteps) || 80)),
      settleMs: Math.max(60, Math.min(800, Number(options.settleMs) || 140)),
    };

    const pages = new Map();
    const errors = [];
    let discovery = 0;

    const addPage = (key, pageNo, kind, raster) => {
      if (!raster?.dataUrl || pages.has(key)) return;
      pages.set(key, { ...raster, pageNo, kind, discovery: discovery++ });
    };

    const captureCurrent = async () => {
      const canvases = canvasCandidates(settings.smart);
      const canvasInfo = canvases.map((canvas, i) => ({
        canvas, i, pageNo: inferPageNumber(canvas), fp: null, occurrence: 0,
      }));
      const fpTotals = new Map();
      for (const info of canvasInfo) {
        if (Number.isFinite(info.pageNo)) continue;
        info.fp = fingerprintCanvas(info.canvas);
        if (info.fp) fpTotals.set(info.fp, (fpTotals.get(info.fp) || 0) + 1);
      }
      const fpSeen = new Map();
      for (const info of canvasInfo) {
        const { canvas, i, pageNo, fp } = info;
        let key;
        if (Number.isFinite(pageNo)) key = `page:${pageNo}`;
        else if (fp) {
          const occurrence = fpSeen.get(fp) || 0;
          fpSeen.set(fp, occurrence + 1);
          key = fpTotals.get(fp) > 1 ? `fp:${fp}:slot:${occurrence}` : `fp:${fp}`;
        } else key = `canvas-raw:${i}`;
        try { addPage(key, pageNo, 'canvas', rasterizeCanvas(canvas, settings)); }
        catch (error) { errors.push(`Canvas ${pageNo || i + 1}: ${error.message || error}`); }
      }

      if (!settings.includeMedia) return;
      const images = imageCandidates();
      for (let i = 0; i < images.length; i += 1) {
        const img = images[i]; const pageNo = inferPageNumber(img); const key = pageNo ? `page:${pageNo}` : `img:${img.currentSrc || img.src || i}`;
        if (pages.has(key)) continue;
        try { addPage(key, pageNo, 'image', await imageToRaster(img, settings)); }
        catch (error) { errors.push(`Image ${pageNo || i + 1}: ${error.message || error}`); }
      }

      const svgs = svgCandidates();
      for (let i = 0; i < svgs.length; i += 1) {
        const svg = svgs[i]; const pageNo = inferPageNumber(svg); const key = pageNo ? `page:${pageNo}` : `svg:${i}:${Math.round(svg.getBoundingClientRect().top)}`;
        if (pages.has(key)) continue;
        try { addPage(key, pageNo, 'svg', await svgToRaster(svg, settings)); }
        catch (error) { errors.push(`SVG ${pageNo || i + 1}: ${error.message || error}`); }
      }
    };

    await captureCurrent();

    if (settings.autoScroll) {
      const targets = findScrollableElements().sort((a, b) => scrollTargetScore(b) - scrollTargetScore(a));
      const target = targets[0];
      if (target) {
        const isDoc = target === document.scrollingElement;
        const original = isDoc ? window.scrollY : target.scrollTop;
        const client = isDoc ? window.innerHeight : target.clientHeight;
        const max = Math.max(0, target.scrollHeight - client);
        const step = Math.max(180, Math.floor(client * 0.78));
        const positions = [];
        for (let pos = 0; pos <= max && positions.length < settings.maxSteps; pos += step) positions.push(pos);
        if (positions[positions.length - 1] !== max) positions.push(max);
        try {
          for (const pos of positions) {
            if (isDoc) window.scrollTo({ top: pos, behavior: 'instant' }); else target.scrollTop = pos;
            await sleep(settings.settleMs);
            await captureCurrent();
          }
        } finally {
          if (isDoc) window.scrollTo({ top: original, behavior: 'instant' }); else target.scrollTop = original;
        }
      }
    }

    const ordered = [...pages.values()].sort((a, b) => {
      if (Number.isFinite(a.pageNo) && Number.isFinite(b.pageNo)) return a.pageNo - b.pageNo;
      if (Number.isFinite(a.pageNo)) return -1;
      if (Number.isFinite(b.pageNo)) return 1;
      return a.discovery - b.discovery;
    });

    return {
      pages: ordered,
      errors: errors.slice(0, 30),
      meta: { ...detect(), captured: ordered.length },
    };
  }

  globalThis.__CANVORA__ = { detect, capture };
})();
