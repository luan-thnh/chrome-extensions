const autoScanInput = document.querySelector('#autoScan');
const autoOpenInput = document.querySelector('#autoOpen');
const scanButton = document.querySelector('#scanButton');
const statusText = document.querySelector('#statusText');
const resultsContainer = document.querySelector('#results');

initializePopup();

async function initializePopup() {
  const settings = await chrome.storage.local.get({ autoScan: true, autoOpen: false });
  autoScanInput.checked = settings.autoScan !== false;
  autoOpenInput.checked = settings.autoOpen === true;

  autoScanInput.addEventListener('change', () => {
    chrome.storage.local.set({ autoScan: autoScanInput.checked });
  });

  autoOpenInput.addEventListener('change', () => {
    chrome.storage.local.set({ autoOpen: autoOpenInput.checked });
  });

  scanButton.addEventListener('click', scanNow);
  await refreshResults();
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function refreshResults() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    renderUnavailable('No active webpage.');
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_RESULTS' });
    if (!response?.supported) {
      renderUnsupported();
      return;
    }

    const results = Array.isArray(response.results) ? response.results : [];
    const engineLabel = response.engine && response.engine !== 'none' ? ` · ${response.engine}` : '';
    statusText.textContent = results.length
      ? `${results.length} QR code${results.length === 1 ? '' : 's'} found${engineLabel}`
      : (response.scanning ? `Scanning…${engineLabel}` : `No QR found yet${engineLabel}`);
    renderResults(results);
  } catch (_) {
    renderUnavailable('This page cannot be scanned.');
  }
}

async function scanNow() {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  scanButton.disabled = true;
  scanButton.textContent = 'Scanning…';
  statusText.textContent = 'Scanning current page…';

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' });
    await wait(450);
    await refreshResults();
  } catch (_) {
    renderUnavailable('This page cannot be scanned.');
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = 'Scan now';
  }
}

function renderResults(results) {
  resultsContainer.replaceChildren();

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No QR code detected yet. Keep Auto scan on, or click “Scan now” after the QR image appears.';
    resultsContainer.appendChild(empty);
    return;
  }

  results.forEach((result) => resultsContainer.appendChild(createResultCard(result)));
}

function createResultCard(result) {
  const card = document.createElement('article');
  card.className = 'result-card';

  if (result.url) {
    const link = document.createElement('a');
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = result.url;
    card.appendChild(link);
  }

  const raw = document.createElement('div');
  raw.className = 'raw';
  raw.textContent = result.url ? `QR value: ${result.value}` : result.value;
  card.appendChild(raw);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const copy = document.createElement('button');
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
    open.type = 'button';
    open.textContent = 'Open link';
    open.addEventListener('click', () => chrome.tabs.create({ url: result.url }));
    actions.appendChild(open);
  }

  card.appendChild(actions);
  return card;
}

function renderUnsupported() {
  statusText.textContent = 'QR engine unavailable';
  resultsContainer.innerHTML = '<div class="empty unsupported">No QR engine could be initialized. Reload the extension from chrome://extensions. Version 0.2 includes a bundled local JavaScript decoder and should not require native BarcodeDetector support.</div>';
}

function renderUnavailable(message) {
  statusText.textContent = message;
  resultsContainer.innerHTML = `<div class="empty">${escapeHtml(message)} Chrome internal pages (chrome://), the Web Store, and some protected pages cannot run content scripts.</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
