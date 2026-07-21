(() => {
  "use strict";

  const GLOBAL_KEY = "__ZALO_AUDIO_ZIP_EXTENSION__";
  const SCRIPT_VERSION = "1.1.0";

  const existingController = window[GLOBAL_KEY];

  if (existingController?.version === SCRIPT_VERSION) {
    existingController.showPanel();
    return;
  }

  if (existingController?.destroy) {
    existingController.destroy();
  }

  const state = {
    items: new Map(),
    root: null,
    shadow: null,
    busy: false,
    previewItemId: null
  };

  const encoder = new TextEncoder();
  const crcTable = createCrcTable();

  function createCrcTable() {
    const table = new Uint32Array(256);

    for (let index = 0; index < 256; index++) {
      let value = index;

      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }

      table[index] = value >>> 0;
    }

    return table;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;

    for (const byte of bytes) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function getDosDateTime(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);
    const dosDate =
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();

    return { dosTime, dosDate };
  }

  function buildZip(files, onProgress) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const { dosTime, dosDate } = getDosDateTime();

    files.forEach((file, index) => {
      const nameBytes = encoder.encode(file.name);
      const data = file.data;
      const checksum = crc32(data);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);

      writeUint32(localView, 0, 0x04034b50);
      writeUint16(localView, 4, 20);
      writeUint16(localView, 6, 0x0800);
      writeUint16(localView, 8, 0);
      writeUint16(localView, 10, dosTime);
      writeUint16(localView, 12, dosDate);
      writeUint32(localView, 14, checksum);
      writeUint32(localView, 18, data.length);
      writeUint32(localView, 22, data.length);
      writeUint16(localView, 26, nameBytes.length);
      writeUint16(localView, 28, 0);
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);

      writeUint32(centralView, 0, 0x02014b50);
      writeUint16(centralView, 4, 20);
      writeUint16(centralView, 6, 20);
      writeUint16(centralView, 8, 0x0800);
      writeUint16(centralView, 10, 0);
      writeUint16(centralView, 12, dosTime);
      writeUint16(centralView, 14, dosDate);
      writeUint32(centralView, 16, checksum);
      writeUint32(centralView, 20, data.length);
      writeUint32(centralView, 24, data.length);
      writeUint16(centralView, 28, nameBytes.length);
      writeUint16(centralView, 30, 0);
      writeUint16(centralView, 32, 0);
      writeUint16(centralView, 34, 0);
      writeUint16(centralView, 36, 0);
      writeUint32(centralView, 38, 0);
      writeUint32(centralView, 42, localOffset);
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);
      localOffset += localHeader.length + data.length;
      onProgress?.(index + 1, files.length);
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);

    writeUint32(endView, 0, 0x06054b50);
    writeUint16(endView, 4, 0);
    writeUint16(endView, 6, 0);
    writeUint16(endView, 8, files.length);
    writeUint16(endView, 10, files.length);
    writeUint32(endView, 12, centralSize);
    writeUint32(endView, 16, localOffset);
    writeUint16(endView, 20, 0);

    return new Blob([...localParts, ...centralParts, end], {
      type: "application/zip"
    });
  }

  function isZaloBlobUrl(value) {
    return (
      typeof value === "string" &&
      value.startsWith("blob:https://chat.zalo.me/")
    );
  }

  function getDuration(element) {
    const container =
      element.closest?.(".voice-message") ||
      element.closest?.('[id^="voice-mCntr_"]') ||
      element.closest?.(".chat-message") ||
      element.parentElement;

    return (
      container
        ?.querySelector?.(".voice-message-normal__meta-duration")
        ?.textContent?.trim() || ""
    );
  }

  function getMessageId(element) {
    return element.closest?.(".chat-message")?.id || "";
  }

  function addCandidate(url, element) {
    if (!isZaloBlobUrl(url) || state.items.has(url)) {
      return false;
    }

    state.items.set(url, {
      id: globalThis.crypto?.randomUUID?.() || `audio-${Date.now()}-${state.items.size}`,
      url,
      duration: getDuration(element),
      messageId: getMessageId(element),
      discoveredAt: new Date().toISOString(),
      selected: true
    });

    return true;
  }

  function scanDocument() {
    const selector = [
      '.voice-message-normal[id^="blob:https://chat.zalo.me/"]',
      '[id^="blob:https://chat.zalo.me/"]',
      'audio[src^="blob:https://chat.zalo.me/"]',
      'source[src^="blob:https://chat.zalo.me/"]',
      '[data-src^="blob:https://chat.zalo.me/"]'
    ].join(",");

    let added = 0;

    document.querySelectorAll(selector).forEach((element) => {
      const values = [
        element.id,
        element.getAttribute?.("src"),
        element.getAttribute?.("data-src")
      ];

      values.forEach((value) => {
        if (addCandidate(value, element)) {
          added++;
        }
      });
    });

    return added;
  }

  function sanitizePart(value) {
    return String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );

    const value = bytes / 1024 ** index;
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  }

  function detectExtension(blob, bytes) {
    const mime = String(blob.type || "")
      .toLowerCase()
      .split(";")[0]
      .trim();

    const mimeMap = {
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/mp4": "m4a",
      "audio/x-m4a": "m4a",
      "audio/aac": "aac",
      "audio/ogg": "ogg",
      "application/ogg": "ogg",
      "audio/opus": "opus",
      "audio/webm": "webm",
      "video/webm": "webm",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/amr": "amr"
    };

    if (mimeMap[mime]) {
      return mimeMap[mime];
    }

    if (bytes.length >= 12) {
      const ascii4 = String.fromCharCode(...bytes.slice(0, 4));
      const ascii8 = String.fromCharCode(...bytes.slice(4, 12));

      if (ascii4 === "OggS") return "ogg";
      if (ascii4 === "RIFF") return "wav";
      if (ascii4 === "\u001aE\u00df\u00a3") return "webm";
      if (ascii8.includes("ftyp")) return "m4a";
      if (ascii4.startsWith("ID3")) return "mp3";
    }

    if (bytes.length >= 6) {
      const firstSix = String.fromCharCode(...bytes.slice(0, 6));
      if (firstSix === "#!AMR\n") return "amr";
    }

    if (
      bytes.length >= 2 &&
      bytes[0] === 0xff &&
      (bytes[1] & 0xf0) === 0xf0
    ) {
      return "aac";
    }

    return "bin";
  }

  function buildFileName(index, item, extension) {
    const order = String(index + 1).padStart(3, "0");
    const duration = sanitizePart(item.duration);
    return `zalo_audio_${order}${duration ? `_${duration}` : ""}.${extension}`;
  }

  function getUi() {
    if (!state.shadow) return {};

    return {
      count: state.shadow.querySelector("[data-count]"),
      selectedCount: state.shadow.querySelector("[data-selected-count]"),
      status: state.shadow.querySelector("[data-status]"),
      list: state.shadow.querySelector("[data-list]"),
      scanButton: state.shadow.querySelector("[data-scan]"),
      downloadButton: state.shadow.querySelector("[data-download]"),
      clearButton: state.shadow.querySelector("[data-clear]"),
      selectAllButton: state.shadow.querySelector("[data-select-all]"),
      selectNoneButton: state.shadow.querySelector("[data-select-none]"),
      previewShell: state.shadow.querySelector("[data-preview-shell]"),
      previewTitle: state.shadow.querySelector("[data-preview-title]"),
      previewMeta: state.shadow.querySelector("[data-preview-meta]"),
      previewAudio: state.shadow.querySelector("[data-preview-audio]")
    };
  }

  function getItems() {
    return [...state.items.values()];
  }

  function getSelectedItems() {
    return getItems().filter((item) => item.selected);
  }

  function getItemById(id) {
    return getItems().find((item) => item.id === id) || null;
  }

  function setStatus(message, type = "info") {
    const { status } = getUi();
    if (!status) return;

    status.textContent = message;
    status.dataset.type = type;
  }

  function setBusy(value) {
    state.busy = value;
    const {
      scanButton,
      downloadButton,
      clearButton,
      selectAllButton,
      selectNoneButton,
      list
    } = getUi();

    [
      scanButton,
      downloadButton,
      clearButton,
      selectAllButton,
      selectNoneButton
    ].forEach((button) => {
      if (button) button.disabled = value;
    });

    list?.querySelectorAll("input, button").forEach((control) => {
      control.disabled = value;
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function stopPreview({ reset = false } = {}) {
    const { previewAudio, previewShell } = getUi();

    if (previewAudio) {
      previewAudio.pause();

      if (reset) {
        previewAudio.removeAttribute("src");
        previewAudio.load();
      }
    }

    if (reset) {
      state.previewItemId = null;
      if (previewShell) previewShell.hidden = true;
    }

    render();
  }

  async function previewItem(itemId) {
    if (state.busy) return;

    const item = getItemById(itemId);
    const {
      previewAudio,
      previewShell,
      previewTitle,
      previewMeta
    } = getUi();

    if (!item || !previewAudio || !previewShell) {
      return;
    }

    if (state.previewItemId === itemId && !previewAudio.paused) {
      previewAudio.pause();
      render();
      return;
    }

    const itemNumber = getItems().findIndex((candidate) => candidate.id === itemId) + 1;

    try {
      if (state.previewItemId !== itemId || previewAudio.src !== item.url) {
        previewAudio.pause();
        previewAudio.src = item.url;
        previewAudio.load();
      }

      state.previewItemId = itemId;
      previewShell.hidden = false;
      previewTitle.textContent = `Audio ${itemNumber}`;
      previewMeta.textContent = item.duration
        ? `Thời lượng ${item.duration}`
        : "Nghe thử trước khi chọn tải";

      await previewAudio.play();
      setStatus(`Đang phát thử Audio ${itemNumber}.`, "success");
      render();
    } catch (error) {
      console.error("[Zalo Audio Preview]", error);
      setStatus(
        "Không phát được audio này. Blob có thể đã hết hiệu lực; hãy bấm phát trên Zalo rồi quét lại.",
        "error"
      );
      render();
    }
  }

  function render() {
    const { count, selectedCount, list, downloadButton } = getUi();
    const items = getItems();
    const selectedItems = getSelectedItems();

    if (count) count.textContent = String(items.length);
    if (selectedCount) selectedCount.textContent = String(selectedItems.length);

    if (downloadButton) {
      downloadButton.textContent = selectedItems.length
        ? `Tải ZIP (${selectedItems.length})`
        : "Tải ZIP";
    }

    if (!list) return;

    if (!items.length) {
      list.innerHTML = '<div class="empty">Chưa thu thập audio nào.</div>';
      return;
    }

    list.innerHTML = items
      .map((item, index) => {
        const isPlaying = state.previewItemId === item.id &&
          !getUi().previewAudio?.paused;

        return `
          <article class="audio-item ${item.selected ? "is-selected" : ""}">
            <label class="pick" title="Chọn audio này để tải">
              <input
                type="checkbox"
                data-item-check
                data-item-id="${escapeHtml(item.id)}"
                ${item.selected ? "checked" : ""}
              />
              <span class="pick-box"></span>
            </label>

            <button
              class="preview-button ${isPlaying ? "is-playing" : ""}"
              type="button"
              data-preview
              data-item-id="${escapeHtml(item.id)}"
              title="${isPlaying ? "Tạm dừng" : "Nghe thử"}"
            >
              ${isPlaying ? "Ⅱ" : "▶"}
            </button>

            <div class="audio-info">
              <strong>Audio ${index + 1}</strong>
              <small>${escapeHtml(item.duration || "Không rõ thời lượng")}</small>
            </div>

            <span class="picked-label">${item.selected ? "Đã chọn" : "Bỏ qua"}</span>
          </article>
        `;
      })
      .join("");
  }

  function selectAll(value) {
    if (state.busy) return;

    state.items.forEach((item) => {
      item.selected = value;
    });

    render();
    setStatus(
      value
        ? `Đã chọn toàn bộ ${state.items.size} audio.`
        : "Đã bỏ chọn toàn bộ audio."
    );
  }

  function createPanel() {
    if (state.root?.isConnected) return;

    const root = document.createElement("div");
    root.id = "zalo-audio-zip-extension-root";
    const shadow = root.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        button, input { font: inherit; }
        .panel {
          position: fixed;
          top: 18px;
          right: 18px;
          z-index: 2147483647;
          width: min(430px, calc(100vw - 36px));
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 18px;
          color: #f8fafc;
          background: rgba(16, 24, 40, .97);
          box-shadow: 0 18px 55px rgba(0,0,0,.42);
          backdrop-filter: blur(18px);
          font-family: Inter, ui-sans-serif, system-ui, -apple-system,
            BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 15px 16px 12px;
        }
        .title { display: flex; align-items: center; gap: 10px; }
        .mark {
          display: grid;
          place-items: center;
          width: 38px;
          height: 38px;
          border-radius: 12px;
          color: #fff;
          background: linear-gradient(145deg, #2c8dff, #1263dd);
          box-shadow: 0 8px 20px rgba(22,119,255,.3);
          font-size: 18px;
        }
        h2 { margin: 0; font-size: 14px; line-height: 1.2; }
        .subtitle { margin-top: 3px; color: #98a2b3; font-size: 10px; }
        .close {
          width: 30px;
          height: 30px;
          padding: 0;
          border: 0;
          border-radius: 9px;
          cursor: pointer;
          color: #cbd5e1;
          background: rgba(255,255,255,.07);
          font-size: 17px;
        }
        .top-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin: 0 16px;
        }
        .summary {
          padding: 11px 12px;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 12px;
          background: rgba(255,255,255,.045);
        }
        .summary strong { display: block; font-size: 22px; line-height: 1; }
        .summary span { display: block; margin-top: 5px; color: #aeb8c8; font-size: 10px; }
        .summary.selected strong { color: #69adff; }
        .status {
          min-height: 34px;
          margin: 10px 16px 0;
          padding: 9px 10px;
          border-radius: 10px;
          color: #b9d4ff;
          background: rgba(22,119,255,.12);
          font-size: 11px;
          line-height: 1.45;
        }
        .status[data-type="success"] {
          color: #a7f3d0;
          background: rgba(16,185,129,.12);
        }
        .status[data-type="error"] {
          color: #fecaca;
          background: rgba(239,68,68,.13);
        }
        .actions {
          display: grid;
          grid-template-columns: 1fr 1.25fr;
          gap: 8px;
          padding: 11px 16px 0;
        }
        button.action {
          min-height: 38px;
          border: 0;
          border-radius: 10px;
          cursor: pointer;
          color: #fff;
          font-size: 11px;
          font-weight: 750;
        }
        button:disabled { cursor: wait !important; opacity: .5; }
        .scan { background: #344054; }
        .download {
          background: #1677ff;
          box-shadow: 0 8px 20px rgba(22,119,255,.23);
        }
        .selection-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 16px 0;
        }
        .selection-label { color: #98a2b3; font-size: 10px; }
        .selection-buttons { display: flex; gap: 5px; }
        .mini {
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 8px;
          padding: 6px 8px;
          cursor: pointer;
          color: #cbd5e1;
          background: rgba(255,255,255,.055);
          font-size: 9px;
        }
        .list {
          display: grid;
          gap: 7px;
          max-height: 260px;
          margin: 9px 16px 0;
          overflow: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
        .audio-item {
          display: grid;
          grid-template-columns: 24px 34px minmax(0, 1fr) auto;
          align-items: center;
          gap: 9px;
          min-height: 54px;
          padding: 8px 10px;
          border: 1px solid transparent;
          border-radius: 11px;
          background: rgba(255,255,255,.045);
          transition: border-color .15s ease, background .15s ease;
        }
        .audio-item.is-selected {
          border-color: rgba(72,160,255,.25);
          background: rgba(22,119,255,.08);
        }
        .pick { position: relative; display: grid; place-items: center; cursor: pointer; }
        .pick input {
          position: absolute;
          width: 1px;
          height: 1px;
          opacity: 0;
          pointer-events: none;
        }
        .pick-box {
          display: grid;
          place-items: center;
          width: 18px;
          height: 18px;
          border: 1px solid rgba(255,255,255,.23);
          border-radius: 6px;
          background: rgba(255,255,255,.04);
        }
        .pick input:checked + .pick-box {
          border-color: #3190ff;
          background: #1677ff;
        }
        .pick input:checked + .pick-box::after {
          content: "✓";
          color: #fff;
          font-size: 11px;
          font-weight: 800;
        }
        .preview-button {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          padding: 0 0 0 2px;
          border: 0;
          border-radius: 999px;
          cursor: pointer;
          color: #dbeafe;
          background: rgba(72,160,255,.16);
          font-size: 12px;
        }
        .preview-button.is-playing {
          padding-left: 0;
          color: #fff;
          background: #1677ff;
          box-shadow: 0 0 0 5px rgba(22,119,255,.12);
        }
        .audio-info { min-width: 0; display: grid; gap: 3px; }
        .audio-info strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
        .audio-info small { color: #98a2b3; font-size: 9px; }
        .picked-label {
          color: #7f8a9d;
          font-size: 8px;
          white-space: nowrap;
        }
        .audio-item.is-selected .picked-label { color: #76b5ff; }
        .empty {
          padding: 14px;
          border: 1px dashed rgba(255,255,255,.12);
          border-radius: 10px;
          color: #98a2b3;
          text-align: center;
          font-size: 10px;
        }
        .preview-shell {
          margin: 10px 16px 0;
          padding: 10px 11px;
          border: 1px solid rgba(72,160,255,.22);
          border-radius: 12px;
          background: rgba(22,119,255,.08);
        }
        .preview-shell[hidden] { display: none; }
        .preview-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 7px;
        }
        .preview-head strong { font-size: 10px; }
        .preview-head span { color: #98a2b3; font-size: 9px; }
        audio { display: block; width: 100%; height: 32px; }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 11px 16px 15px;
        }
        .tip {
          max-width: 300px;
          color: #7f8a9d;
          font-size: 9px;
          line-height: 1.45;
        }
        .clear {
          border: 0;
          cursor: pointer;
          color: #aab4c5;
          background: transparent;
          font-size: 9px;
          text-decoration: underline;
          white-space: nowrap;
        }
      </style>

      <section class="panel" role="dialog" aria-label="Zalo Audio ZIP Exporter">
        <header class="header">
          <div class="title">
            <div class="mark">♫</div>
            <div>
              <h2>Zalo Audio ZIP Exporter</h2>
              <div class="subtitle">Nghe thử, chọn file và tải ZIP</div>
            </div>
          </div>
          <button class="close" data-close title="Đóng">×</button>
        </header>

        <div class="top-grid">
          <div class="summary">
            <strong data-count>0</strong>
            <span>audio đã thu thập</span>
          </div>
          <div class="summary selected">
            <strong data-selected-count>0</strong>
            <span>audio được chọn</span>
          </div>
        </div>

        <div class="status" data-status data-type="info">
          Cuộn qua tin nhắn thoại rồi bấm Quét audio.
        </div>

        <div class="actions">
          <button class="action scan" data-scan>Quét audio</button>
          <button class="action download" data-download>Tải ZIP</button>
        </div>

        <div class="selection-tools">
          <span class="selection-label">Tick những file cần tải</span>
          <div class="selection-buttons">
            <button class="mini" data-select-all>Chọn tất cả</button>
            <button class="mini" data-select-none>Bỏ chọn</button>
          </div>
        </div>

        <div class="list" data-list></div>

        <div class="preview-shell" data-preview-shell hidden>
          <div class="preview-head">
            <strong data-preview-title>Audio</strong>
            <span data-preview-meta>Nghe thử trước khi tải</span>
          </div>
          <audio data-preview-audio controls preload="metadata"></audio>
        </div>

        <footer class="footer">
          <div class="tip">
            Bấm ▶ để nghe thử. ZIP chỉ chứa các audio đang được tick.
          </div>
          <button class="clear" data-clear>Xóa danh sách</button>
        </footer>
      </section>
    `;

    shadow.querySelector("[data-close]").addEventListener("click", () => {
      root.style.display = "none";
    });

    shadow.querySelector("[data-scan]").addEventListener("click", scan);
    shadow.querySelector("[data-download]").addEventListener("click", downloadZip);
    shadow.querySelector("[data-select-all]").addEventListener("click", () => selectAll(true));
    shadow.querySelector("[data-select-none]").addEventListener("click", () => selectAll(false));

    shadow.querySelector("[data-list]").addEventListener("change", (event) => {
      const checkbox = event.target.closest?.("[data-item-check]");
      if (!checkbox || state.busy) return;

      const item = getItemById(checkbox.dataset.itemId);
      if (!item) return;

      item.selected = checkbox.checked;
      render();
    });

    shadow.querySelector("[data-list]").addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-preview]");
      if (!button) return;
      previewItem(button.dataset.itemId);
    });

    const previewAudio = shadow.querySelector("[data-preview-audio]");
    previewAudio.addEventListener("play", render);
    previewAudio.addEventListener("pause", render);
    previewAudio.addEventListener("ended", render);
    previewAudio.addEventListener("error", () => {
      setStatus(
        "Audio preview không còn hiệu lực. Hãy phát audio trên Zalo rồi quét lại.",
        "error"
      );
      render();
    });

    shadow.querySelector("[data-clear]").addEventListener("click", () => {
      if (state.busy) return;
      stopPreview({ reset: true });
      state.items.clear();
      render();
      setStatus("Đã xóa danh sách đã thu thập.");
    });

    document.documentElement.appendChild(root);
    state.root = root;
    state.shadow = shadow;
    render();
  }

  function showPanel() {
    createPanel();
    state.root.style.display = "block";
    const added = scanDocument();
    render();

    if (added > 0) {
      setStatus(`Tự động tìm thêm ${added} audio.`, "success");
    }

    return {
      count: state.items.size,
      selected: getSelectedItems().length,
      added
    };
  }

  function scan() {
    createPanel();
    const added = scanDocument();
    render();

    if (added > 0) {
      setStatus(
        `Tìm thêm ${added} audio; tổng cộng ${state.items.size}. Audio mới đã được chọn sẵn.`,
        "success"
      );
    } else {
      setStatus(
        `Không có audio mới. Tổng hiện tại: ${state.items.size}. Hãy cuộn thêm rồi quét lại.`
      );
    }

    return {
      added,
      count: state.items.size,
      selected: getSelectedItems().length
    };
  }

  async function downloadZip() {
    if (state.busy) return { ok: false, reason: "busy" };

    scanDocument();
    render();

    const allItems = getItems();
    const items = getSelectedItems();

    if (!allItems.length) {
      setStatus(
        "Chưa tìm thấy audio. Hãy bấm phát hoặc cuộn qua tin nhắn thoại rồi quét lại.",
        "error"
      );
      return { ok: false, reason: "empty" };
    }

    if (!items.length) {
      setStatus("Bạn chưa chọn file nào để tải.", "error");
      return { ok: false, reason: "none-selected" };
    }

    setBusy(true);
    const files = [];
    const successes = [];
    const failures = [];

    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        setStatus(`Đang đọc audio đã chọn ${index + 1}/${items.length}...`);

        try {
          const response = await fetch(item.url);

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const blob = await response.blob();
          if (!blob.size) throw new Error("File audio rỗng");

          const bytes = new Uint8Array(await blob.arrayBuffer());
          const extension = detectExtension(blob, bytes);
          const name = buildFileName(index, item, extension);

          files.push({ name: `zalo-audio/${name}`, data: bytes });
          successes.push({
            name,
            duration: item.duration,
            mime: blob.type || "unknown",
            size: blob.size,
            source: item.url
          });
        } catch (error) {
          failures.push({
            index: index + 1,
            source: item.url,
            error: error?.message || String(error)
          });
        }
      }

      if (!successes.length) {
        setStatus(
          "Không đọc được blob đã chọn. Hãy bấm phát audio trên Zalo, quét lại và tải ngay.",
          "error"
        );
        return { ok: false, reason: "unreadable", failures };
      }

      const manifest = {
        exportedAt: new Date().toISOString(),
        page: location.href,
        totalFound: allItems.length,
        totalSelected: items.length,
        totalDownloaded: successes.length,
        totalFailed: failures.length,
        files: successes.map((file) => ({
          ...file,
          sizeFormatted: formatBytes(file.size)
        })),
        failures
      };

      files.push({
        name: "manifest.json",
        data: encoder.encode(JSON.stringify(manifest, null, 2))
      });

      if (failures.length) {
        const errorText = failures
          .map(
            (failure) =>
              `Audio ${failure.index}\nURL: ${failure.source}\nLỗi: ${failure.error}\n`
          )
          .join("\n");

        files.push({
          name: "download-errors.txt",
          data: encoder.encode(errorText)
        });
      }

      setStatus("Đang đóng gói các file đã chọn...");

      const zipBlob = buildZip(files, (done, total) => {
        setStatus(`Đang đóng gói ZIP ${done}/${total}...`);
      });

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      const fileName = `zalo-audio-selected_${timestamp}.zip`;
      const downloadUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");

      link.href = downloadUrl;
      link.download = fileName;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);

      setStatus(
        `Hoàn tất ${successes.length}/${items.length} audio đã chọn — ${formatBytes(zipBlob.size)}.`,
        "success"
      );

      return {
        ok: true,
        fileName,
        downloaded: successes.length,
        selected: items.length,
        failed: failures.length,
        size: zipBlob.size
      };
    } catch (error) {
      console.error("[Zalo Audio ZIP Exporter]", error);
      setStatus(error?.message || "Không thể tạo file ZIP.", "error");
      return { ok: false, reason: "exception", error: error?.message };
    } finally {
      setBusy(false);
      render();
    }
  }

  function destroy() {
    stopPreview({ reset: true });
    state.root?.remove();
    state.root = null;
    state.shadow = null;
    state.items.clear();
    delete window[GLOBAL_KEY];
    return true;
  }

  window[GLOBAL_KEY] = {
    version: SCRIPT_VERSION,
    showPanel,
    scan,
    downloadZip,
    destroy,
    getCount: () => state.items.size,
    getSelectedCount: () => getSelectedItems().length
  };

  showPanel();
})();
