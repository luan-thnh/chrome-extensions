# QR Link Hunter — Chrome Extension MVP

A Manifest V3 Chrome extension that automatically scans QR codes rendered on a webpage and exposes decoded web links.

## What it scans

- `<img>` elements already loaded on the page.
- `<canvas>` elements.
- Dynamically inserted images/canvases via `MutationObserver`.
- One visible-tab screenshot fallback, so QR codes rendered through CSS/backgrounds can still be found when visible.
- Cross-origin `<img>` sources via a Manifest V3 background service worker fetch fallback.
- QR images with very little/no quiet-zone margin: the scanner redraws them with a white quiet zone before detection.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `qr-link-scanner-extension`.
5. Open a normal website containing a QR image.
6. When a QR is found, use either the floating **QR found** chip on the page or the extension popup.

## Settings

- **Auto scan**: enabled by default. Watches initial and dynamically added page images.
- **Auto open**: disabled by default. If enabled, opens only the first detected `http/https` QR link in a new tab.

## Important compatibility note

This MVP uses the browser-native `BarcodeDetector` API, which is still not available on every Chrome/OS combination. The extension detects that condition and reports it in the popup instead of silently failing.

For production-grade Linux support, bundle a local QR decoder (for example jsQR or ZXing/WASM) inside the extension package. Manifest V3 should not rely on remotely hosted executable JavaScript.

## Security choices

- Only `http:` and `https:` QR values become clickable links.
- Non-web QR values (Wi-Fi payloads, text, etc.) are shown as raw text only.
- Auto-open is opt-in and opens at most the first detected web URL per page.
- Remote image fetches are capped at 6 MB.

## Sample QR supplied with the task

The supplied QR image decodes to:

`https://ts.uda.edu.vn/t/1279413`

It has almost no white quiet-zone border, so the scanner includes a preprocessing step that adds padding before detection.
