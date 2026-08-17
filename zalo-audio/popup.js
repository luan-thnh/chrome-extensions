const statusElement = document.getElementById("status");
const openPanelButton = document.getElementById("openPanel");
const quickScanButton = document.getElementById("quickScan");

function setStatus(message, type = "info") {
  statusElement.textContent = message;
  statusElement.dataset.type = type;
}

async function getZaloTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("Không xác định được tab hiện tại.");
  }

  if (!tab.url?.startsWith("https://chat.zalo.me/")) {
    throw new Error("Hãy mở đúng tab https://chat.zalo.me/ rồi thử lại.");
  }

  return tab;
}

async function ensurePageController(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page-controller.js"],
    world: "MAIN"
  });
}

async function callPageController(tabId, method) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [method],
    func: async (methodName) => {
      const controller = window.__ZALO_AUDIO_ZIP_EXTENSION__;

      if (!controller || typeof controller[methodName] !== "function") {
        throw new Error("Bộ điều khiển trên trang chưa sẵn sàng.");
      }

      return await controller[methodName]();
    }
  });

  return results?.[0]?.result;
}

async function run(button, task) {
  button.disabled = true;

  try {
    await task();
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "Có lỗi không xác định.", "error");
  } finally {
    button.disabled = false;
  }
}

openPanelButton.addEventListener("click", () => {
  run(openPanelButton, async () => {
    setStatus("Đang mở bảng điều khiển trên Zalo...");
    const tab = await getZaloTab();
    await ensurePageController(tab.id);
    const result = await callPageController(tab.id, "showPanel");
    setStatus(
      `Đã mở bảng. Hiện thu thập ${result?.count ?? 0} audio.`,
      "success"
    );
  });
});

quickScanButton.addEventListener("click", () => {
  run(quickScanButton, async () => {
    setStatus("Đang quét các audio đang hiển thị...");
    const tab = await getZaloTab();
    await ensurePageController(tab.id);
    const result = await callPageController(tab.id, "scan");
    setStatus(
      `Tìm thêm ${result?.added ?? 0}; tổng cộng ${result?.count ?? 0} audio.`,
      "success"
    );
  });
});
