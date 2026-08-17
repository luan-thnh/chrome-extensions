# QR Link Hunter — Chrome Extension v0.3.0

A Manifest V3 Chrome/Chromium extension that automatically scans QR codes rendered on the current webpage and exposes decoded web links.

## What changed in v0.3

The scanner no longer depends on the operating system exposing the native `BarcodeDetector` API. A QR Model 2 decoder is bundled directly inside the extension as local JavaScript.

- If native `BarcodeDetector` is available, it is used as the fast path.
- If it is unavailable (common on some Linux/Chromium builds), the bundled local decoder takes over automatically.
- QR decoding is local; the QR payload is not sent to an external scanning service.
- The supplied borderless QR sample is handled by redrawing the image with a white quiet zone before decoding.

This makes the extension behavior independent of the desktop OS for normal Chrome/Chromium webpage scanning on Windows, macOS and Linux. Browser-protected pages are still subject to Chromium extension restrictions.

## What it scans

- `<img>` elements already loaded on the page.
- `<canvas>` elements.
- Dynamically inserted images/canvases via `MutationObserver`.
- One visible-tab screenshot fallback when the native engine is available.
- Cross-origin `<img>` sources through the Manifest V3 background service worker fetch fallback.
- QR images with very little/no quiet-zone margin.

## Install / update locally

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Remove the old QR Link Hunter version, or choose **Reload** after replacing its folder.
5. Click **Load unpacked** and select `qr-link-scanner-extension`.
6. Refresh the website that contains the QR code.
7. Keep **Auto scan** enabled or click **Scan now**.

The popup should now report `Local JS + error correction` on a Chromium build without native QR support, instead of `QR engine unavailable`.

## Settings

- **Auto scan**: enabled by default. Watches initial and dynamically added page images.
- **Auto open**: disabled by default. If enabled, opens only the first detected `http/https` QR link in a new tab.

## Compatibility notes

The bundled decoder is optimized for normal, clean QR images rendered as an image/canvas on a webpage. The native detector, when available, remains useful for more complex visual cases.

Chrome internal pages (`chrome://...`), the Chrome Web Store and other protected browser pages do not allow normal content-script injection, so no extension can scan them using this same mechanism.

## Security choices

- Only `http:` and `https:` QR values become clickable links.
- Non-web QR values are shown as raw text.
- Auto-open is opt-in and opens at most the first detected web URL per page.
- Remote image fetches are capped at 6 MB.

## Sample QR supplied with the task

The supplied QR image decodes to:

`https://ts.uda.edu.vn/t/1279413`


## v0.3 reliability update

- Adds Reed-Solomon error correction to the bundled QR decoder before payload parsing.
- Cleans zero-width/control characters and repairs a one-character-damaged `http`/`https` scheme when the QR clearly contains a web URL.
- Adds an arrow-up-right button in the top-right of every detected URL card; clicking it opens the decoded URL in a new tab.
- Keeps Copy as a separate action.
