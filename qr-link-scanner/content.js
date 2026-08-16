(() => {
  const MIN_IMAGE_SIZE = 48;
  const MAX_IMAGE_AREA = 5_000_000;
  const MAX_PARALLEL_SCANS = 2;
  const SCREENSHOT_DELAY_MS = 1200;
  const RESCAN_DEBOUNCE_MS = 350;

  const state = {
    detector: null,
    supported: false,
    results: [],
    resultKeys: new Set(),
    scannedSources: new Set(),
    queuedElements: new WeakSet(),
    queue: [],
    activeWorkers: 0,
    autoScan: true,
    autoOpen: false,
    openedFirst: false,
    overlay: null,
    screenshotScanned: false
  };

  initialize();

  async function initialize() {
    const settings = await chrome.storage.local.get({ autoScan: true, autoOpen: false });
    state.autoScan = settings.autoScan !== false;
    state.autoOpen = settings.autoOpen === true;

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    chrome.storage.onChanged.addListener(handleStorageChange);

    state.supported = await initializeDetector();
    if (!state.supported) {
      console.warn('[QR Link Hunter] BarcodeDetector is unavailable in this Chrome build.');
      return;
    }

    if (state.autoScan) startAutomaticScanning();
  }

  async function initializeDetector() {
    if (!('BarcodeDetector' in globalThis)) return false;

    try {
      if (typeof BarcodeDetector.getSupportedFormats === 'function') {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (!formats.includes('qr_code')) return false;
      }
      state.detector = new BarcodeDetector({ formats: ['qr_code'] });
      return true;
    } catch (error) {
      console.warn('[QR Link Hunter] Failed to initialize BarcodeDetector:', error);
      return false;
    }
  }

  function startAutomaticScanning() {
    scanDocument();
    observeDynamicContent();

    window.setTimeout(() => {
      if (document.visibilityState === 'visible' && state.autoScan) {
        scanVisibleViewport();
      }
    }, SCREENSHOT_DELAY_MS);
  }

  function stopAutomaticScanning() {
    state.queue.length = 0;
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'local') return;

    if (changes.autoScan) {
      state.autoScan = changes.autoScan.newValue !== false;
      if (state.autoScan) startAutomaticScanning();
      else stopAutomaticScanning();
    }

    if (changes.autoOpen) {
      state.autoOpen = changes.autoOpen.newValue === true;
    }
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'GET_RESULTS') {
      sendResponse({
        ok: true,
        supported: state.supported,
        results: state.results,
        scanning: state.activeWorkers > 0 || state.queue.length > 0
      });
      return;
    }

    if (message.type === 'SCAN_NOW') {
      Promise.resolve()
        .then(() => scanDocument(true))
        .then(() => scanVisibleViewport(true))
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  }

  function scanDocument(force = false) {
    if (!state.supported) return;
    if (force) state.scannedSources.clear();

    collectScannableElements(document).forEach((element) => queueElement(element, force));
  }

  function collectScannableElements(root) {
    const elements = [];

    const visit = (node) => {
      if (!node?.querySelectorAll) return;

      node.querySelectorAll('img, canvas').forEach((element) => elements.push(element));

      node.querySelectorAll('*').forEach((element) => {
        if (element.shadowRoot) visit(element.shadowRoot);
      });
    };

    visit(root);
    return elements;
  }

  function queueElement(element, force = false) {
    if (!state.autoScan && !force) return;
    if (state.queuedElements.has(element)) return;

    state.queuedElements.add(element);
    state.queue.push(element);
    pumpQueue();
  }

  function pumpQueue() {
    while (state.activeWorkers < MAX_PARALLEL_SCANS && state.queue.length) {
      const element = state.queue.shift();
      state.activeWorkers += 1;

      scanElement(element)
        .catch(() => {})
        .finally(() => {
          state.activeWorkers -= 1;
          pumpQueue();
        });
    }
  }

  async function scanElement(element) {
    if (!element?.isConnected) return;

    if (element instanceof HTMLImageElement) {
      await scanImageElement(element);
      return;
    }

    if (element instanceof HTMLCanvasElement) {
      if (element.width < MIN_IMAGE_SIZE || element.height < MIN_IMAGE_SIZE) return;
      await decodeVisualSource(element, 'canvas');
    }
  }

  async function scanImageElement(image) {
    if (!image.complete) {
      await waitForImage(image);
    }

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) return;
    if (width * height > MAX_IMAGE_AREA) return;

    const source = image.currentSrc || image.src;
    const sourceKey = source || `inline:${width}x${height}`;
    if (state.scannedSources.has(sourceKey)) return;
    state.scannedSources.add(sourceKey);

    // Fast path: the browser may be able to inspect the rendered image directly.
    if (await decodeVisualSource(image, sourceKey)) return;

    // Cross-origin fallback: fetch the image from the extension service worker,
    // then decode a local data URL so canvas access is origin-clean.
    if (/^https?:/i.test(source)) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: source });
        if (response?.ok && response.dataUrl) {
          const localImage = await loadImage(response.dataUrl);
          await decodeVisualSource(localImage, sourceKey);
        }
      } catch (_) {
        // Ignore single-image failures; the viewport screenshot fallback can still catch it.
      }
    }
  }

  async function decodeVisualSource(source, sourceLabel) {
    const dimensions = getSourceDimensions(source);
    if (!dimensions) return false;

    const { width, height } = dimensions;
    if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) return false;

    const attempts = [
      { scale: 1, paddingRatio: 0.10 },
      { scale: 2, paddingRatio: 0.12 }
    ];

    for (const attempt of attempts) {
      try {
        const canvas = renderWithQuietZone(source, width, height, attempt.scale, attempt.paddingRatio);
        const barcodes = await state.detector.detect(canvas);
        const qrCodes = barcodes.filter((item) => !item.format || item.format === 'qr_code');

        if (qrCodes.length) {
          qrCodes.forEach((item) => registerResult(item.rawValue, sourceLabel));
          return true;
        }
      } catch (_) {
        // SecurityError, detached source, unsupported image, etc.
      }
    }

    return false;
  }

  function renderWithQuietZone(source, width, height, scale, paddingRatio) {
    const scaledWidth = Math.max(1, Math.round(width * scale));
    const scaledHeight = Math.max(1, Math.round(height * scale));
    const padding = Math.max(16, Math.round(Math.min(scaledWidth, scaledHeight) * paddingRatio));

    const canvas = document.createElement('canvas');
    canvas.width = scaledWidth + padding * 2;
    canvas.height = scaledHeight + padding * 2;

    const context = canvas.getContext('2d', { willReadFrequently: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(source, padding, padding, scaledWidth, scaledHeight);

    return canvas;
  }

  function registerResult(rawValue, source) {
    const value = String(rawValue || '').trim();
    if (!value) return;

    const url = normalizeWebUrl(value);
    const key = url || value;
    if (state.resultKeys.has(key)) return;

    state.resultKeys.add(key);
    state.results.push({
      value,
      url,
      source: String(source || 'page'),
      detectedAt: Date.now()
    });

    updateOverlay();
    chrome.runtime.sendMessage({ type: 'QR_COUNT', count: state.results.length }).catch(() => {});

    if (state.autoOpen && !state.openedFirst && url) {
      state.openedFirst = true;
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  function normalizeWebUrl(value) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
      return null;
    } catch (_) {
      if (/^(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(value)) {
        try {
          return new URL(`https://${value}`).href;
        } catch (_) {
          return null;
        }
      }
      return null;
    }
  }

  async function scanVisibleViewport(force = false) {
    if (!state.supported || document.visibilityState !== 'visible') return;
    if (state.screenshotScanned && !force) return;

    state.screenshotScanned = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' });
      if (!response?.ok || !response.dataUrl) return;
      const image = await loadImage(response.dataUrl);
      await decodeVisualSource(image, 'visible viewport');
    } catch (_) {
      // Screenshot scanning is a fallback only.
    }
  }

  function observeDynamicContent() {
    if (window.__qrLinkHunterObserver) return;

    let timer = null;
    const observer = new MutationObserver((mutations) => {
      if (!state.autoScan) return;

      const added = [];
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches?.('img, canvas')) added.push(node);
          collectScannableElements(node).forEach((element) => added.push(element));
        });
      }

      added.forEach(queueElement);

      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') scanVisibleViewport(true);
      }, RESCAN_DEBOUNCE_MS);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false
    });

    window.__qrLinkHunterObserver = observer;
  }

  function getSourceDimensions(source) {
    if (source instanceof HTMLImageElement) {
      return {
        width: source.naturalWidth || source.width,
        height: source.naturalHeight || source.height
      };
    }

    if (source instanceof HTMLCanvasElement) {
      return { width: source.width, height: source.height };
    }

    return null;
  }

  function waitForImage(image) {
    return new Promise((resolve) => {
      if (image.complete) return resolve();
      const done = () => resolve();
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
      window.setTimeout(done, 3000);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Unable to decode image.'));
      image.src = src;
    });
  }

  function updateOverlay() {
    if (!state.results.length) return;

    if (!state.overlay) state.overlay = createOverlay();
    const button = state.overlay.shadowRoot.querySelector('[data-qr-toggle]');
    const count = state.overlay.shadowRoot.querySelector('[data-qr-count]');
    const list = state.overlay.shadowRoot.querySelector('[data-qr-list]');

    button.hidden = false;
    count.textContent = String(state.results.length);
    list.replaceChildren(...state.results.map(renderOverlayResult));
  }

  function createOverlay() {
    const host = document.createElement('div');
    host.id = 'qr-link-hunter-root';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .toggle { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 10px 13px; background: #111827; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,.24); cursor: pointer; font: 600 13px/1 system-ui; }
        .toggle:hover { background: #1f2937; }
        .badge { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 999px; background: #2563eb; font-size: 11px; }
        .panel { width: min(360px, calc(100vw - 36px)); max-height: min(430px, calc(100vh - 90px)); overflow: auto; margin-bottom: 10px; padding: 10px; border: 1px solid rgba(148,163,184,.28); border-radius: 18px; background: rgba(255,255,255,.98); color: #0f172a; box-shadow: 0 20px 55px rgba(15,23,42,.22); }
        .panel[hidden] { display: none; }
        .heading { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
        .heading strong { font: 700 13px/1.2 system-ui; }
        .heading span { color: #64748b; font: 500 11px/1.2 system-ui; }
        .item { padding: 10px; border-radius: 12px; background: #f8fafc; }
        .item + .item { margin-top: 8px; }
        .link { display: block; overflow: hidden; color: #1d4ed8; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; font: 650 12px/1.4 system-ui; }
        .raw { margin-top: 4px; color: #475569; overflow-wrap: anywhere; font: 500 11px/1.4 system-ui; }
        .actions { display: flex; gap: 6px; margin-top: 8px; }
        .action { border: 0; border-radius: 9px; padding: 7px 9px; cursor: pointer; background: #e2e8f0; color: #0f172a; font: 650 11px/1 system-ui; }
        .action:hover { background: #cbd5e1; }
      </style>
      <div class="wrap">
        <div class="panel" data-qr-panel hidden>
          <div class="heading"><strong>QR links found</strong><span>QR Link Hunter</span></div>
          <div data-qr-list></div>
        </div>
        <button class="toggle" type="button" data-qr-toggle hidden>
          <span>QR found</span><span class="badge" data-qr-count>0</span>
        </button>
      </div>
    `;

    const toggle = shadow.querySelector('[data-qr-toggle]');
    const panel = shadow.querySelector('[data-qr-panel]');
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
    });

    document.documentElement.appendChild(host);
    return host;
  }

  function renderOverlayResult(result) {
    const item = document.createElement('div');
    item.className = 'item';

    if (result.url) {
      const link = document.createElement('a');
      link.className = 'link';
      link.href = result.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = result.url;
      item.appendChild(link);
    }

    const raw = document.createElement('div');
    raw.className = 'raw';
    raw.textContent = result.value;
    item.appendChild(raw);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const copy = document.createElement('button');
    copy.className = 'action';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(result.url || result.value);
      copy.textContent = 'Copied';
      window.setTimeout(() => (copy.textContent = 'Copy'), 900);
    });
    actions.appendChild(copy);

    if (result.url) {
      const open = document.createElement('button');
      open.className = 'action';
      open.type = 'button';
      open.textContent = 'Open';
      open.addEventListener('click', () => window.open(result.url, '_blank', 'noopener,noreferrer'));
      actions.appendChild(open);
    }

    item.appendChild(actions);
    return item;
  }
})();
