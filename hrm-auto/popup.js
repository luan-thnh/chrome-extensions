const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const HRM_TASK_URL = 'https://hrm.donga.edu.vn/social/home/congviecngay';
const WEEKDAY_LABELS = { 0: 'CN', 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7' };
const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (data) => chrome.storage.local.set(data);

let activeLogFilter = 'all';
let cachedLogs = [];
let scheduleRefreshTimer = null;

function clampNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function syncTimeValue() {
  const hourInput = $('#time-hour');
  const minuteInput = $('#time-minute');
  const timeHiddenInput = $('#time');
  if (!hourInput || !minuteInput || !timeHiddenInput) return;

  let hour = clampNumber(hourInput.value, 1, 12, 9);
  const minute = clampNumber(minuteInput.value, 0, 59, 0);
  const ampm = $('.ampm-btn.ampm-active')?.dataset.value || 'AM';

  hourInput.value = hour;
  minuteInput.value = String(minute).padStart(2, '0');
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  timeHiddenInput.value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  updateQuickTimeState();
  updateSchedulePreview();
}

function setAmpmActive(activeBtnId) {
  $$('.ampm-btn').forEach((btn) => btn.classList.toggle('ampm-active', btn.id === activeBtnId));
}

function setTimeInputs(time) {
  const [fullHourRaw, minuteRaw] = String(time || '09:00').split(':');
  const fullHour = clampNumber(fullHourRaw, 0, 23, 9);
  const minute = clampNumber(minuteRaw, 0, 59, 0);

  let displayHour = fullHour;
  let ampm = 'AM';
  if (fullHour >= 12) {
    ampm = 'PM';
    displayHour = fullHour === 12 ? 12 : fullHour - 12;
  } else if (fullHour === 0) {
    displayHour = 12;
  }

  $('#time-hour').value = displayHour;
  $('#time-minute').value = String(minute).padStart(2, '0');
  setAmpmActive(ampm === 'AM' ? 'ampm-am' : 'ampm-pm');
  syncTimeValue();
}

function setLoading(button, isLoading, loadingText) {
  if (!button) return;
  const textEl = button.querySelector('.btn-text');
  if (!button.dataset.defaultText && textEl) button.dataset.defaultText = textEl.textContent;
  button.disabled = isLoading;
  button.classList.toggle('is-loading', isLoading);
  if (textEl) textEl.textContent = isLoading ? loadingText : button.dataset.defaultText;
}

function showToast(message, type = 'info') {
  const root = $('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(7px) scale(.98)';
    setTimeout(() => toast.remove(), 180);
  }, 2400);
}

function formatLogTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  if (sameDay) return `${hh}:${mi}:${ss}`;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}`;
}

function formatLastRun(timestamp) {
  if (!timestamp) return 'Chưa có';
  const date = new Date(timestamp);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `Hôm nay · ${hh}:${mi}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Hôm qua · ${hh}:${mi}`;
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} · ${hh}:${mi}`;
}

function getStatusText(status) {
  return { success: 'Hoàn tất', failed: 'Có lỗi', pending: 'Đang chạy', idle: 'Chưa chạy' }[status] || 'Chưa chạy';
}

function getCheckedWeekdays() {
  return $$('input[name="weekday"]:checked').map((cb) => cb.value);
}

function buildScheduleSummary(time, weekdays, isAutoEnabled) {
  if (!isAutoEnabled) return 'Auto đang tắt';
  if (!time || !Array.isArray(weekdays) || weekdays.length === 0) return 'Chưa đủ lịch';
  const numericDays = weekdays.map(Number);
  let dayText = numericDays.length === 7 ? 'Mỗi ngày' : numericDays.length === 5 && [1,2,3,4,5].every((d) => numericDays.includes(d)) ? 'T2–T6' : weekdays.map((d) => WEEKDAY_LABELS[d]).filter(Boolean).join(', ');
  return `${time} · ${dayText}`;
}

function getNextRunDate(time, weekdays, isAutoEnabled) {
  if (!isAutoEnabled || !time || !Array.isArray(weekdays) || weekdays.length === 0) return null;
  const [hour, minute] = String(time).split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  const allowedDays = new Set(weekdays.map(String));
  const now = new Date();
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (!allowedDays.has(String(candidate.getDay()))) continue;
    if (candidate.getTime() <= now.getTime()) continue;
    return candidate;
  }
  return null;
}

function formatNextRun(date) {
  if (!date) return '—';
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `Hôm nay · ${hh}:${mi}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Ngày mai · ${hh}:${mi}`;
  const label = WEEKDAY_LABELS[date.getDay()];
  return `${label} ${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} · ${hh}:${mi}`;
}

function getLatestProgressLog(logs) {
  const recent = [...logs].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return recent.find((log) => log.type === 'pending' || log.type === 'info');
}

async function loadStatus() {
  const data = await storageGet(['lastRunStatus', 'lastRunTimestamp', 'time', 'weekdays', 'isAutoEnabled', 'isRunning', 'logs']);
  const normalizedStatus = data.isRunning ? 'pending' : data.lastRunStatus || 'idle';
  const statusCard = $('#status-container');
  const autoChip = $('#auto-state-chip');
  const runProgress = $('#run-progress');

  statusCard.dataset.status = normalizedStatus;
  $('#status-badge').textContent = getStatusText(normalizedStatus);
  $('#last-run-time').textContent = formatLastRun(data.lastRunTimestamp);
  $('#schedule-summary').textContent = buildScheduleSummary(data.time, data.weekdays, data.isAutoEnabled);
  $('#next-run-time').textContent = formatNextRun(getNextRunDate(data.time, data.weekdays, data.isAutoEnabled));

  autoChip.textContent = data.isAutoEnabled ? 'Auto bật' : 'Auto tắt';
  autoChip.className = `auto-chip ${data.isAutoEnabled ? 'auto-chip-enabled' : 'auto-chip-disabled'}`;

  if (data.isRunning) {
    const progressLog = getLatestProgressLog(Array.isArray(data.logs) ? data.logs : []);
    $('#run-progress-text').textContent = progressLog?.message || 'Đang xử lý trên HRM...';
    runProgress.classList.remove('hidden');
  } else {
    runProgress.classList.add('hidden');
  }
}

function createLogEmpty(text = 'Không có log phù hợp') {
  const empty = document.createElement('div');
  empty.className = 'log-empty';
  empty.innerHTML = '<span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M8 19V9"/><path d="M12 19V13"/><path d="M16 19V7"/><path d="M20 19V3"/></svg></span>';
  const strong = document.createElement('strong');
  strong.textContent = text;
  const sub = document.createElement('span');
  sub.textContent = cachedLogs.length ? 'Thử chọn bộ lọc khác.' : 'Log sẽ xuất hiện sau lần chạy đầu tiên.';
  empty.append(strong, sub);
  return empty;
}

function renderLogs() {
  const logsContainer = $('#logs-container');
  if (!logsContainer) return;
  logsContainer.innerHTML = '';

  const filtered = activeLogFilter === 'all' ? cachedLogs : cachedLogs.filter((log) => log.type === activeLogFilter);
  if (!filtered.length) {
    logsContainer.appendChild(createLogEmpty(cachedLogs.length ? 'Không có log phù hợp' : 'Chưa có hoạt động'));
    return;
  }

  [...filtered]
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .forEach((log) => {
      const item = document.createElement('article');
      item.className = `log-item log-${log.type || 'info'}`;

      const topline = document.createElement('div');
      topline.className = 'log-topline';
      const message = document.createElement('span');
      message.className = 'log-message';
      message.textContent = log.message || 'Hoạt động';
      const time = document.createElement('time');
      time.className = 'log-time';
      time.textContent = formatLogTime(log.timestamp);
      topline.append(message, time);
      item.appendChild(topline);

      if (log.detail) {
        const detail = document.createElement('span');
        detail.className = 'log-detail';
        detail.textContent = log.detail;
        item.appendChild(detail);
      }
      logsContainer.appendChild(item);
    });
}

async function loadLogs() {
  const data = await storageGet(['logs']);
  cachedLogs = Array.isArray(data.logs) ? data.logs : [];
  $('#log-count').textContent = String(Math.min(cachedLogs.length, 99));
  renderLogs();
}

async function clearLogs() {
  if (!cachedLogs.length) return showToast('Log đang trống.', 'info');
  if (!confirm('Xóa toàn bộ lịch sử hoạt động?')) return;
  await storageSet({ logs: [] });
  await loadLogs();
  showToast('Đã xóa lịch sử.', 'success');
}

async function copyLogs() {
  if (!cachedLogs.length) return showToast('Không có log để sao chép.', 'info');
  const text = [...cachedLogs]
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .map((log) => `[${formatLogTime(log.timestamp)}] ${String(log.type || 'info').toUpperCase()} — ${log.message || ''}${log.detail ? `\n${log.detail}` : ''}`)
    .join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Đã sao chép log.', 'success');
  } catch (_) {
    showToast('Chrome không cho phép sao chép lúc này.', 'error');
  }
}

function markInvalid(element, invalid) {
  if (element) element.classList.toggle('is-invalid', invalid);
}

function collectFormData() {
  syncTimeValue();
  return {
    username: $('#username')?.value.trim() || '',
    password: $('#password')?.value || '',
    task: $('#task')?.value.trim() || '',
    detail: $('#detail')?.value.trim() || '',
    time: $('#time')?.value || '09:00',
    weekdays: getCheckedWeekdays(),
  };
}

function validateForm(data) {
  const rules = [
    ['#username', !data.username], ['#password', !data.password], ['#task', !data.task], ['#detail', !data.detail],
    ['#time-hour', !$('#time-hour')?.value], ['#time-minute', !$('#time-minute')?.value],
  ];
  rules.forEach(([selector, invalid]) => markInvalid($(selector), invalid));
  if (rules.some(([, invalid]) => invalid)) return 'Vui lòng điền đủ Email, Password, Task và Detail.';
  if (!/^\S+@\S+\.\S+$/.test(data.username)) return 'Email HRM chưa đúng định dạng.';
  if (!data.weekdays.length) return 'Vui lòng chọn ít nhất 1 ngày chạy.';
  return '';
}

async function saveSettings({ enableAuto = true, silent = false } = {}) {
  const data = collectFormData();
  const validationError = validateForm(data);
  if (validationError) {
    showToast(validationError, 'error');
    return { success: false, error: validationError };
  }

  await storageSet({ ...data, isAutoEnabled: enableAuto });
  if (enableAuto) await chrome.alarms.create('checkTask', { periodInMinutes: 1 });
  await loadStatus();
  if (!silent) showToast(enableAuto ? 'Đã lưu và bật Auto.' : 'Đã lưu cấu hình.', 'success');
  return { success: true, data };
}

async function stopAuto() {
  const button = $('#cancel-auto');
  button.disabled = true;
  try {
    await chrome.alarms.clear('checkTask');
    await storageSet({ isAutoEnabled: false, isRunning: false, lastRunStatus: 'idle' });
    await loadStatus();
    showToast('Auto đã dừng, cấu hình vẫn được giữ.', 'success');
  } catch (error) {
    showToast(`Không thể dừng Auto: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function manualTrigger() {
  const button = $('#manual-trigger');
  setLoading(button, true, 'Đang mở...');
  try {
    const currentState = await storageGet(['isAutoEnabled']);
    const saved = await saveSettings({ enableAuto: Boolean(currentState.isAutoEnabled), silent: true });
    if (!saved.success) return;
    const response = await chrome.runtime.sendMessage({ type: 'MANUAL_TRIGGER' });
    if (response?.success) showToast('Đã mở HRM và điền thử, không tự bấm Lưu.', 'success');
    else showToast(response?.error || 'Không thể chạy thử.', 'error');
  } catch (error) {
    showToast(`Lỗi chạy thử: ${error.message}`, 'error');
  } finally {
    setLoading(button, false);
    await loadStatus();
  }
}

async function openHrm() {
  const tabs = await chrome.tabs.query({ url: 'https://hrm.donga.edu.vn/*' });
  const existing = tabs.find((tab) => tab.id && !tab.discarded);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => null);
  } else {
    await chrome.tabs.create({ url: HRM_TASK_URL, active: true });
  }
}

async function loadSavedSettings() {
  const data = await storageGet(['username', 'password', 'task', 'detail', 'time', 'weekdays']);
  if (data.username) $('#username').value = data.username;
  if (data.password) $('#password').value = data.password;
  if (data.task) $('#task').value = data.task;
  if (data.detail) $('#detail').value = data.detail;
  setTimeInputs(data.time || '09:00');

  if (Array.isArray(data.weekdays)) {
    $$('input[name="weekday"]').forEach((cb) => { cb.checked = data.weekdays.includes(cb.value); });
  }
  updateDetailCounter();
  updateSchedulePreview();
}

function updateDetailCounter() {
  const length = $('#detail')?.value.length || 0;
  $('#detail-counter').textContent = `${length.toLocaleString('vi-VN')} ký tự`;
}

async function updateSchedulePreview() {
  const time = $('#time')?.value || '09:00';
  const weekdays = getCheckedWeekdays();
  const data = await storageGet(['isAutoEnabled']);
  $('#schedule-summary').textContent = buildScheduleSummary(time, weekdays, data.isAutoEnabled);
  $('#next-run-time').textContent = formatNextRun(getNextRunDate(time, weekdays, data.isAutoEnabled));
}

function updateQuickTimeState() {
  const current = $('#time')?.value;
  $$('.quick-time').forEach((btn) => btn.classList.toggle('active', btn.dataset.time === current));
}

function applyDayPreset(preset) {
  const selected = preset === 'workdays' ? new Set(['1','2','3','4','5']) : preset === 'all' ? new Set(['0','1','2','3','4','5','6']) : new Set();
  $$('input[name="weekday"]').forEach((cb) => { cb.checked = selected.has(cb.value); });
  updateSchedulePreview();
}

function setupTabs() {
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      $$('.tab-btn').forEach((item) => item.classList.remove('tab-active'));
      $$('.tab-content').forEach((content) => content.classList.remove('tab-content-active'));
      btn.classList.add('tab-active');
      $(`#tab-${btn.dataset.tab}`)?.classList.add('tab-content-active');
      if (btn.dataset.tab === 'logs') await loadLogs();
    });
  });
}

function setupPasswordToggle() {
  $('#toggle-password')?.addEventListener('click', () => {
    const input = $('#password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#eye-open').classList.toggle('hidden', show);
    $('#eye-closed').classList.toggle('hidden', !show);
  });
}

function setupScheduleControls() {
  $$('.ampm-btn').forEach((btn) => btn.addEventListener('click', () => { setAmpmActive(btn.id); syncTimeValue(); }));
  ['#time-hour', '#time-minute'].forEach((selector) => {
    $(selector)?.addEventListener('input', syncTimeValue);
    $(selector)?.addEventListener('blur', syncTimeValue);
  });
  $$('input[name="weekday"]').forEach((cb) => cb.addEventListener('change', updateSchedulePreview));
  $$('.quick-time').forEach((btn) => btn.addEventListener('click', () => setTimeInputs(btn.dataset.time)));
  $$('[data-day-preset]').forEach((btn) => btn.addEventListener('click', () => applyDayPreset(btn.dataset.dayPreset)));
}

function setupLogControls() {
  $$('.log-filter').forEach((btn) => btn.addEventListener('click', () => {
    activeLogFilter = btn.dataset.filter;
    $$('.log-filter').forEach((item) => item.classList.toggle('active', item === btn));
    renderLogs();
  }));
  $('#copy-logs')?.addEventListener('click', copyLogs);
  $('#clear-logs')?.addEventListener('click', clearLogs);
}

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const statusKeys = ['lastRunStatus', 'lastRunTimestamp', 'isAutoEnabled', 'isRunning', 'time', 'weekdays'];
    if (statusKeys.some((key) => changes[key])) loadStatus();
    if (changes.logs) {
      loadLogs();
      loadStatus();
    }
  });
}

function setupKeyboardShortcut() {
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      $('#settings-form')?.requestSubmit();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupPasswordToggle();
  setupScheduleControls();
  setupLogControls();
  setupStorageListener();
  setupKeyboardShortcut();

  $('#detail')?.addEventListener('input', updateDetailCounter);
  $('#open-hrm')?.addEventListener('click', () => openHrm().catch((error) => showToast(error.message, 'error')));
  $('#manual-trigger')?.addEventListener('click', manualTrigger);
  $('#cancel-auto')?.addEventListener('click', stopAuto);

  $('#settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#save');
    setLoading(button, true, 'Đang lưu...');
    try { await saveSettings({ enableAuto: true }); }
    finally { setLoading(button, false); }
  });

  await loadSavedSettings();
  await Promise.all([loadStatus(), loadLogs()]);

  scheduleRefreshTimer = setInterval(() => loadStatus().catch(() => null), 30000);
  window.addEventListener('unload', () => clearInterval(scheduleRefreshTimer), { once: true });
});
