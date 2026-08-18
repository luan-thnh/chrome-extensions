/**
 * HRM Auto Task - Background Service Worker
 * Stable MV3 scheduler + task runner.
 */

const HRM_LOGIN_URL = 'https://hrm.donga.edu.vn/nhan-vien/dang-nhap';
const HRM_HOST_MATCH = 'https://hrm.donga.edu.vn/*';
const ALARM_NAME = 'checkTask';
const RUNNING_TIMEOUT_MS = 10 * 60 * 1000;
const NAVIGATION_WATCH_TIMEOUT_MS = 90 * 1000;
const navigationWatchers = new Map();

function getLocalDateKey(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || JSON.stringify(error);
}

async function addLog(type, message, detail = '') {
  try {
    const data = await chrome.storage.local.get(['logs']);
    const logs = Array.isArray(data.logs) ? data.logs : [];

    logs.push({
      timestamp: Date.now(),
      type,
      message,
      detail,
    });

    while (logs.length > 80) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch (error) {
    console.error('[HRM] Add log error:', error);
  }
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  addLog('info', 'Extension đã sẵn sàng', 'Bộ hẹn giờ đã được khởi tạo.');
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  addLog('info', 'Chrome vừa khởi động', 'Bộ hẹn giờ đã được đăng ký lại.');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    const data = await chrome.storage.local.get([
      'username',
      'password',
      'task',
      'detail',
      'time',
      'weekdays',
      'lastRunDate',
      'lastRunStatus',
      'isAutoEnabled',
      'isRunning',
      'runningStartedAt',
    ]);

    if (!data.isAutoEnabled) return;
    if (!data.username || !data.password || !data.task || !data.detail || !data.time || !data.weekdays?.length) return;

    const now = new Date();
    const todayStr = getLocalDateKey(now);
    const todayDay = String(now.getDay());

    if (data.lastRunDate === todayStr && data.lastRunStatus === 'success') return;
    if (!data.weekdays.includes(todayDay)) return;

    const [targetHour, targetMinute] = String(data.time).split(':').map(Number);
    if (Number.isNaN(targetHour) || Number.isNaN(targetMinute)) return;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = targetHour * 60 + targetMinute;
    if (currentMinutes < targetMinutes) return;

    if (data.isRunning && Date.now() - Number(data.runningStartedAt || 0) < RUNNING_TIMEOUT_MS) {
      return;
    }

    await addLog('pending', 'Bắt đầu chạy tự động', `Lịch chạy: ${data.time} - ${now.toLocaleTimeString('vi-VN')}`);
    await executeTask(data, { isTestMode: false, source: 'auto' });
  } catch (error) {
    await chrome.storage.local.set({ lastRunStatus: 'failed', isRunning: false });
    addLog('failed', 'Lỗi kiểm tra lịch chạy', normalizeError(error));
  }
});

async function executeTask(data, options = {}) {
  const isTestMode = Boolean(options.isTestMode);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await chrome.storage.local.set({
    isRunning: true,
    runningStartedAt: Date.now(),
    activeRunId: runId,
    activeRunSource: options.source || (isTestMode ? 'manual-test' : 'auto'),
    isTestMode,
    lastRunStatus: 'pending',
    lastRunTimestamp: Date.now(),
  });

  try {
    const tabId = await getOrCreateHrmTab(isTestMode);
    removeNavigationWatcher(runId);
    const stopWatching = watchHrmNavigation(tabId, runId);
    const watcherTimer = setTimeout(() => {
      removeNavigationWatcher(runId);
    }, NAVIGATION_WATCH_TIMEOUT_MS);
    navigationWatchers.set(runId, { stop: stopWatching, timer: watcherTimer });

    await waitForTabComplete(tabId, 25000).catch(() => null);
    await injectContentScript(tabId, runId);

    return { success: true, tabId, runId };
  } catch (error) {
    const message = normalizeError(error);
    removeNavigationWatcher(runId);
    await chrome.storage.local.set({
      isRunning: false,
      lastRunStatus: 'failed',
      lastRunTimestamp: Date.now(),
      activeRunId: null,
      isTestMode: false,
    });
    await addLog('failed', 'Không thể bắt đầu task', message);
    throw error;
  }
}

async function getOrCreateHrmTab(shouldFocus) {
  const tabs = await chrome.tabs.query({ url: HRM_HOST_MATCH });
  const availableTabs = tabs.filter((tab) => tab.id && !tab.discarded);

  if (availableTabs.length > 0) {
    const tab = availableTabs[0];
    await addLog('info', 'Dùng tab HRM đang mở', 'Extension sẽ chạy lại trên tab hiện có.');
    if (shouldFocus) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
    }
    return tab.id;
  }

  await addLog('info', 'Mở tab HRM mới', shouldFocus ? 'Tab test sẽ được mở để bạn kiểm tra.' : 'Tab chạy tự động được mở ở nền.');
  const newTab = await chrome.tabs.create({ url: HRM_LOGIN_URL, active: shouldFocus });
  return newTab.id;
}

function watchHrmNavigation(targetTabId, runId) {
  let lastInjectedUrl = '';
  let lastInjectedAt = 0;

  const listener = (tabId, info, tab) => {
    if (tabId !== targetTabId) return;
    if (info.status !== 'complete') return;
    if (!tab?.url || !tab.url.includes('hrm.donga.edu.vn')) return;

    const now = Date.now();
    if (lastInjectedUrl === tab.url && now - lastInjectedAt < 1500) return;
    lastInjectedUrl = tab.url;
    lastInjectedAt = now;

    injectContentScript(tabId, runId).catch((error) => {
      console.warn('[HRM] Script injection after navigation failed:', error);
      addLog('failed', 'Inject script sau chuyển trang thất bại', normalizeError(error));
    });
  };

  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}


function removeNavigationWatcher(runId) {
  const watcher = navigationWatchers.get(runId);
  if (!watcher) return;
  try {
    watcher.stop?.();
  } catch (error) {
    console.warn('[HRM] Could not remove navigation watcher:', error);
  }
  if (watcher.timer) clearTimeout(watcher.timer);
  navigationWatchers.delete(runId);
}

function waitForTabComplete(tabId, timeout = 20000) {
  return new Promise(async (resolve, reject) => {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (currentTab?.status === 'complete') {
      resolve(currentTab);
      return;
    }

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab HRM tải quá lâu.'));
    }, timeout);

    const listener = (updatedTabId, info, tab) => {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectContentScript(tabId, runId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => {
      window.__HRM_FORCE_RUN_ID__ = id;
      window.__HRM_CONTENT_RUNNING__ = false;
    },
    args: [runId],
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'MANUAL_TRIGGER') {
    handleManualTrigger(sendResponse);
    return true;
  }

  if (message?.type === 'TASK_PROGRESS') {
    addLog(message.logType || 'info', message.message || 'Đang xử lý', message.detail || '')
      .then(() => sendResponse?.({ success: true }))
      .catch((error) => sendResponse?.({ success: false, error: normalizeError(error) }));
    return true;
  }

  if (message?.type === 'TASK_COMPLETE') {
    handleTaskComplete(message, sender)
      .then(() => sendResponse?.({ success: true }))
      .catch((error) => sendResponse?.({ success: false, error: normalizeError(error) }));
    return true;
  }

  return false;
});

async function handleManualTrigger(sendResponse) {
  try {
    const data = await chrome.storage.local.get(['username', 'password', 'task', 'detail', 'isRunning', 'runningStartedAt']);

    if (!data.username || !data.password || !data.task || !data.detail) {
      await addLog('failed', 'Chạy thử thất bại', 'Thiếu email, password, task hoặc detail.');
      sendResponse({ success: false, error: 'Vui lòng điền đầy đủ Email, Password, Task và Detail trước khi chạy thử.' });
      return;
    }

    if (data.isRunning && Date.now() - Number(data.runningStartedAt || 0) < RUNNING_TIMEOUT_MS) {
      sendResponse({ success: false, error: 'Một task khác đang chạy. Vui lòng đợi hoàn tất rồi thử lại.' });
      return;
    }

    await chrome.storage.local.remove(['lastRunDate']);
    await addLog('pending', 'Bắt đầu chạy thử', 'Form sẽ được điền nhưng không tự bấm Lưu.');
    const result = await executeTask(data, { isTestMode: true, source: 'manual-test' });
    sendResponse({ success: true, tabId: result.tabId });
  } catch (error) {
    const message = normalizeError(error);
    await addLog('failed', 'Chạy thử bị lỗi', message);
    sendResponse({ success: false, error: message });
  }
}

async function handleTaskComplete(message) {
  const current = await chrome.storage.local.get(['activeRunId']);
  if (message.runId && current.activeRunId && message.runId !== current.activeRunId) {
    await addLog('info', 'Bỏ qua phản hồi từ phiên cũ', `Run ID: ${message.runId}`);
    return;
  }

  if (message.runId) removeNavigationWatcher(message.runId);

  const success = Boolean(message.success);
  const isTestMode = Boolean(message.isTestMode);
  const nextState = {
    isRunning: false,
    lastRunStatus: success ? 'success' : 'failed',
    lastRunTimestamp: Date.now(),
    activeRunId: null,
    activeRunSource: null,
    isTestMode: false,
  };

  if (success && !isTestMode) {
    nextState.lastRunDate = getLocalDateKey();
  }

  await chrome.storage.local.set(nextState);

  const title = success
    ? isTestMode
      ? 'Chạy thử hoàn tất'
      : 'Task tự động hoàn tất'
    : 'Task thất bại';

  await addLog(success ? 'success' : 'failed', title, message.message || '');
}
