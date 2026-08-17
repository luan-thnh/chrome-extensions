const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'FETCH_IMAGE') {
    fetchImage(message.url, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    captureVisible(sender)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'QR_COUNT') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      const count = Number(message.count) || 0;
      chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : '' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    }
  }
});

async function fetchImage(rawUrl, sender) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 10000) {
    throw new Error('Invalid image URL.');
  }

  const url = new URL(rawUrl, sender.tab?.url || undefined);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https image URLs can be fetched by the background worker.');
  }

  const response = await fetch(url.href, {
    method: 'GET',
    credentials: 'include',
    cache: 'force-cache',
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`Image fetch failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) {
    throw new Error('Remote resource is not an image.');
  }

  const declaredLength = Number(response.headers.get('content-length')) || 0;
  if (declaredLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error('Image is larger than the extension scan limit.');
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error('Image is larger than the extension scan limit.');
  }

  return {
    dataUrl: `${contentTypeToDataPrefix(contentType)}${arrayBufferToBase64(buffer)}`
  };
}

function contentTypeToDataPrefix(contentType) {
  return `data:${contentType};base64,`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function captureVisible(sender) {
  const tab = sender.tab;
  if (!tab || typeof tab.windowId !== 'number') {
    throw new Error('Unable to determine the current tab.');
  }

  return chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png'
  });
}
