(() => {
  'use strict';
  const core = globalThis.CanvoraCore;

  const $ = (id) => document.getElementById(id);
  const ui = {
    scanBtn: $('scanBtn'), statusLabel: $('statusLabel'), pageCount: $('pageCount'), viewerType: $('viewerType'), detectedTags: $('detectedTags'), scanNote: $('scanNote'),
    deepScan: $('deepScan'), autoScroll: $('autoScroll'), smartFilter: $('smartFilter'), includeMedia: $('includeMedia'),
    pageRange: $('pageRange'), pdfSize: $('pdfSize'), pdfQuality: $('pdfQuality'), imageFormat: $('imageFormat'), quality: $('quality'), qualityValue: $('qualityValue'), trim: $('trim'), reverse: $('reverse'),
    exportPdf: $('exportPdf'), exportZip: $('exportZip'), downloadOriginal: $('downloadOriginal'), progress: $('progress'), progressText: $('progressText'),
  };

  const state = { tab: null, bestFrameId: 0, frames: [], pdfSources: [], busy: false, deep: false };

  function setBusy(busy, text = 'Đang xử lý…') {
    state.busy = busy;
    ui.progress.hidden = !busy;
    ui.progressText.textContent = text;
    for (const btn of [ui.scanBtn, ui.exportPdf, ui.exportZip, ui.downloadOriginal]) btn.disabled = busy;
  }

  function setStatus(text, error = false) {
    ui.statusLabel.textContent = text;
    const dot = document.querySelector('.signal-dot');
    dot.classList.toggle('error', error);
  }

  function addTag(text, accent = false) {
    const span = document.createElement('span');
    span.className = `tag${accent ? ' accent' : ''}`;
    span.textContent = text;
    ui.detectedTags.appendChild(span);
  }

  function inferDirectPdf(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (/\.pdf$/i.test(parsed.pathname) || /\.pdf(?:[?#]|$)/i.test(url)) return url;
      if (parsed.protocol === 'chrome-extension:' && parsed.searchParams.get('file')) return parsed.searchParams.get('file');
    } catch {}
    return null;
  }

  function uniqueSources(sources) {
    const map = new Map();
    for (const src of sources) if (src?.url && !map.has(src.url)) map.set(src.url, src);
    return [...map.values()];
  }

  function renderScan() {
    const best = state.frames[0]?.result || null;
    ui.detectedTags.textContent = '';
    if (!best) {
      ui.pageCount.textContent = state.pdfSources.length ? 'PDF' : '0';
      ui.viewerType.textContent = state.pdfSources.length ? 'SOURCE' : '—';
      addTag(state.pdfSources.length ? 'original PDF found' : 'no render pages', !!state.pdfSources.length);
      ui.scanNote.textContent = state.pdfSources.length
        ? 'Trang này đã có nguồn PDF gốc. Bạn có thể tải trực tiếp bằng nút Original PDF.'
        : 'Không thấy canvas/page media phù hợp trong frame có thể truy cập.';
    } else {
      ui.pageCount.textContent = String(best.pageCount || best.counts?.smartCanvas || 0);
      ui.viewerType.textContent = (best.viewerTypes?.[0] || 'CANVAS').replace(/-like/i, '').toUpperCase().slice(0, 11);
      (best.viewerTypes || []).slice(0, 3).forEach((t, i) => addTag(t, i === 0));
      if (best.counts?.smartCanvas) addTag(`${best.counts.smartCanvas} canvas`);
      if (best.counts?.images) addTag(`${best.counts.images} images`);
      if (best.counts?.svgs) addTag(`${best.counts.svgs} SVG`);
      if (best.scrollTargets) addTag(`${best.scrollTargets} scroll area`);
      if (best.sourceResolution) addTag(`${best.sourceResolution.width}×${best.sourceResolution.height}px source`);
      if (state.deep) addTag('deep scan', true);
      const lowSource = best.sourceResolution && best.sourceResolution.megapixels < 1.2;
      ui.scanNote.textContent = lowSource
        ? `Nguồn viewer chỉ ${best.sourceResolution.width}×${best.sourceResolution.height}px (${best.sourceResolution.megapixels} MP). Lossless sẽ giữ đúng độ nét này; nếu vẫn mờ, hãy dùng Original PDF hoặc tăng zoom/render của viewer trước khi quét.`
        : `Best frame: ${best.title || 'document'} · ${best.counts?.allCanvas || 0} canvas tổng.`;
    }

    const downloadable = state.pdfSources.find((src) => /^https?:/i.test(src.url));
    ui.downloadOriginal.hidden = !downloadable;
    ui.downloadOriginal.dataset.url = downloadable?.url || '';
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Không lấy được tab hiện tại.');
    return tab;
  }

  async function injectCollector(target) {
    await chrome.scripting.executeScript({ target, files: ['collector.js'] });
  }

  async function scan() {
    setBusy(true, 'Đang dò viewer và page surface…');
    setStatus('Đang quét trang…');
    try {
      state.tab = await getActiveTab();
      const direct = inferDirectPdf(state.tab.url);
      const initialSources = direct ? [{ url: direct, kind: 'tab' }] : [];
      state.frames = [];

      const target = { tabId: state.tab.id, allFrames: state.deep };
      try {
        await injectCollector(target);
        const results = await chrome.scripting.executeScript({
          target,
          func: () => globalThis.__CANVORA__?.detect?.() || null,
        });
        state.frames = results.filter((r) => r.result).sort((a, b) => (b.result.score || 0) - (a.result.score || 0));
        state.bestFrameId = state.frames[0]?.frameId ?? 0;
      } catch (error) {
        if (!initialSources.length) throw error;
      }

      state.pdfSources = uniqueSources([...initialSources, ...state.frames.flatMap((x) => x.result.pdfSources || [])]);
      renderScan();
      setStatus(state.frames.length || state.pdfSources.length ? 'Sẵn sàng xuất' : 'Chưa tìm thấy document pages', !(state.frames.length || state.pdfSources.length));
    } catch (error) {
      console.error(error);
      state.frames = [];
      renderScan();
      setStatus('Trang này không cho phép quét', true);
      ui.scanNote.textContent = /Cannot access|chrome:\/\//i.test(String(error))
        ? 'Chrome chặn extension inject vào trang nội bộ. Nếu đây là PDF gốc, mở URL PDF trực tiếp hoặc dùng nút Original PDF khi có.'
        : String(error.message || error);
    } finally {
      setBusy(false);
    }
  }

  async function requestDeepScan(enabled) {
    if (!enabled) {
      state.deep = false;
      await chrome.storage.local.set({ deepScan: false });
      try { await chrome.permissions.remove({ origins: ['<all_urls>'] }); } catch {}
      await scan();
      return;
    }
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
      ui.deepScan.checked = false;
      state.deep = false;
      await chrome.storage.local.set({ deepScan: false });
      setStatus('Deep Scan chưa được cấp quyền', true);
      return;
    }
    state.deep = true;
    await chrome.storage.local.set({ deepScan: true });
    await scan();
  }

  function captureOptions(format = 'png', qualityOverride = null, trimOverride = null) {
    return {
      smart: ui.smartFilter.checked,
      includeMedia: ui.includeMedia.checked,
      autoScroll: ui.autoScroll.checked,
      trim: trimOverride ?? ui.trim.checked,
      format,
      quality: qualityOverride ?? (Number(ui.quality.value) / 100),
      maxSteps: 90,
      settleMs: 140,
    };
  }

  async function captureBestFrame(format = 'png', qualityOverride = null, trimOverride = null) {
    if (!state.tab) state.tab = await getActiveTab();
    const target = { tabId: state.tab.id, frameIds: [state.bestFrameId ?? 0] };
    await injectCollector(target);
    const [result] = await chrome.scripting.executeScript({
      target,
      func: async (options) => globalThis.__CANVORA__?.capture?.(options),
      args: [captureOptions(format, qualityOverride, trimOverride)],
    });
    if (!result?.result) throw new Error('Không nhận được dữ liệu từ viewer.');
    return result.result;
  }

  function selectPages(pages) {
    const range = core.parsePageRange(ui.pageRange.value, pages.length);
    if (!range.length) throw new Error('Page range không hợp lệ hoặc không có trang tương ứng.');
    let selected = range.map((n) => pages[n - 1]).filter(Boolean);
    if (ui.reverse.checked) selected = selected.reverse();
    return selected;
  }

  async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, saveAs: true });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  function baseName() {
    const title = state.frames[0]?.result?.title || state.tab?.title || 'canvora-document';
    return core.sanitizeFilename(title);
  }

  async function exportPdf() {
    const mode = ui.pdfQuality.value;
    const exact = mode === 'exact';
    const lossless = mode === 'lossless';
    const format = lossless ? 'png' : 'jpeg';
    const jpegQuality = exact ? 0.95 : Number(ui.quality.value) / 100;

    setBusy(true, exact ? 'Đang xuất Exact Canvas…' : lossless ? 'Đang dựng PDF lossless…' : 'Đang quét và dựng PDF…');
    try {
      // Exact Canvas deliberately follows the working console pipeline as closely
      // as an MV3 extension can: direct canvas.toDataURL('image/jpeg', 0.95),
      // source-size pages with jsPDF px_scaling-equivalent 0.75pt/px, and no
      // intermediate resampling unless the user explicitly enables trimming.
      const captured = await captureBestFrame(format, jpegQuality, exact ? false : null);
      const pages = selectPages(captured.pages || []);
      if (!pages.length) throw new Error('Không có trang nào để xuất.');
      const blob = await core.makePdfFromImages(pages, { sizeMode: ui.pdfSize.value });
      await downloadBlob(blob, `${baseName()}.pdf`);

      const label = exact ? 'Exact Canvas · JPEG 95%' : lossless ? 'Lossless PNG' : `JPEG ${ui.quality.value}%`;
      setStatus(`Đã xuất ${pages.length} trang · ${label}`);
      const largest = pages.reduce((best, page) => (page.width * page.height > best.width * best.height ? page : best), pages[0]);
      const sourceInfo = largest ? ` Source lớn nhất: ${largest.width}×${largest.height}px.` : '';
      const trimInfo = exact && ui.trim.checked ? ' Exact Canvas đã tự bỏ qua Trim để giữ pipeline 1:1.' : ui.trim.checked ? ' Trim đang bật nên trang phải qua canvas trung gian để crop.' : '';
      ui.scanNote.textContent = captured.errors?.length
        ? `Xuất xong; bỏ qua ${captured.errors.length} surface không thể rasterize do CORS/tainted canvas.${sourceInfo}${trimInfo}`
        : exact
          ? `Exact Canvas: direct JPEG 95% + 0.75pt/px, khớp pipeline console jsPDF của bạn.${sourceInfo}${trimInfo}`
          : lossless
            ? `PDF PNG lossless + 0.75pt/px; giữ nguyên bitmap nguồn và mật độ hiển thị.${sourceInfo}${trimInfo}`
            : `PDF JPEG ${ui.quality.value}% + 0.75pt/px.${sourceInfo}${trimInfo}`;
    } catch (error) {
      console.error(error);
      setStatus('Xuất PDF thất bại', true);
      ui.scanNote.textContent = String(error.message || error);
    } finally { setBusy(false); }
  }

  async function exportZip() {
    setBusy(true, 'Đang thu page images…');
    try {
      const format = ui.imageFormat.value === 'png' ? 'png' : 'jpeg';
      const captured = await captureBestFrame(format);
      const pages = selectPages(captured.pages || []);
      const ext = format === 'png' ? 'png' : 'jpg';
      const files = pages.map((page, index) => ({
        name: `page-${String(index + 1).padStart(3, '0')}.${ext}`,
        bytes: core.dataUrlToBytes(page.dataUrl).bytes,
      }));
      const blob = core.makeStoreZip(files);
      await downloadBlob(blob, `${baseName()}-pages.zip`);
      setStatus(`Đã xuất ${pages.length} page images`);
    } catch (error) {
      console.error(error);
      setStatus('Xuất ZIP thất bại', true);
      ui.scanNote.textContent = String(error.message || error);
    } finally { setBusy(false); }
  }

  async function downloadOriginal() {
    const url = ui.downloadOriginal.dataset.url;
    if (!url) return;
    try {
      const parsed = new URL(url);
      const filename = core.sanitizeFilename(parsed.pathname.split('/').pop() || `${baseName()}.pdf`);
      await chrome.downloads.download({ url, filename: filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`, saveAs: true });
      setStatus('Đang tải PDF gốc');
    } catch (error) {
      setStatus('Không tải được PDF gốc', true);
      ui.scanNote.textContent = String(error.message || error);
    }
  }

  async function restoreSettings() {
    const saved = await chrome.storage.local.get(['deepScan', 'autoScroll', 'smartFilter', 'includeMedia', 'quality', 'trim', 'pdfQuality', 'imageFormat', 'settingsVersion']);
    ui.autoScroll.checked = saved.autoScroll ?? true;
    ui.smartFilter.checked = saved.smartFilter ?? true;
    ui.includeMedia.checked = saved.includeMedia ?? true;
    ui.quality.value = saved.quality ?? 98;
    ui.qualityValue.textContent = `${ui.quality.value}%`;
    ui.trim.checked = saved.trim ?? false;
    const needsQualityMigration = saved.settingsVersion !== '1.2.0';
    ui.pdfQuality.value = needsQualityMigration ? 'exact' : (['exact', 'lossless', 'jpeg'].includes(saved.pdfQuality) ? saved.pdfQuality : 'exact');
    if (needsQualityMigration) await chrome.storage.local.set({ pdfQuality: 'exact', settingsVersion: '1.2.0' });
    ui.imageFormat.value = saved.imageFormat ?? 'png';
    if (saved.deepScan) {
      const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
      state.deep = has;
      ui.deepScan.checked = has;
    }
  }

  function bind() {
    ui.scanBtn.addEventListener('click', scan);
    ui.exportPdf.addEventListener('click', exportPdf);
    ui.exportZip.addEventListener('click', exportZip);
    ui.downloadOriginal.addEventListener('click', downloadOriginal);
    ui.deepScan.addEventListener('change', () => requestDeepScan(ui.deepScan.checked));
    ui.quality.addEventListener('input', () => { ui.qualityValue.textContent = `${ui.quality.value}%`; chrome.storage.local.set({ quality: Number(ui.quality.value) }); });
    ui.pdfQuality.addEventListener('change', () => chrome.storage.local.set({ pdfQuality: ui.pdfQuality.value }));
    ui.imageFormat.addEventListener('change', () => chrome.storage.local.set({ imageFormat: ui.imageFormat.value }));
    for (const [el, key] of [[ui.autoScroll, 'autoScroll'], [ui.smartFilter, 'smartFilter'], [ui.includeMedia, 'includeMedia'], [ui.trim, 'trim']]) {
      el.addEventListener('change', () => chrome.storage.local.set({ [key]: el.checked }));
    }
  }

  (async () => {
    bind();
    await restoreSettings();
    await scan();
  })();
})();
