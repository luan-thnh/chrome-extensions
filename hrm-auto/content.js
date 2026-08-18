/**
 * HRM Auto Task - Content Script
 * Re-runnable state machine: LOGIN -> NAVIGATE -> FILL_FORM -> COMPLETE.
 */

(async function () {
  'use strict';

  const runId = window.__HRM_FORCE_RUN_ID__ || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (window.__HRM_CONTENT_RUNNING__) {
    console.log('[HRM Content] Another run is already in progress, skipping duplicate injection.');
    return;
  }

  window.__HRM_CONTENT_RUNNING__ = true;
  window.__HRM_CONTENT_LAST_RUN_ID__ = runId;

  const currentUrl = window.location.href;
  console.log('[HRM Content] Started:', runId, currentUrl);

  try {
    const data = await chrome.storage.local.get(['username', 'password', 'task', 'detail', 'isTestMode', 'lastRunDate', 'lastRunStatus']);
    window.__HRM_LAST_TEST_MODE__ = Boolean(data.isTestMode);

    if (!data.isTestMode && data.lastRunDate === getLocalDateKey() && data.lastRunStatus === 'success') {
      console.log('[HRM Content] Auto task already completed today, skipping.');
      return;
    }

    if (currentUrl.includes('/nhan-vien/dang-nhap')) {
      await handleLoginPage(data);
      return;
    }

    if (currentUrl.includes('/social/home/congviecngay')) {
      await handleTaskPage(data);
      return;
    }

    if (currentUrl.includes('hrm.donga.edu.vn')) {
      progress('Điều hướng đến trang công việc', currentUrl);
      window.location.assign('https://hrm.donga.edu.vn/social/home/congviecngay');
      return;
    }
  } catch (error) {
    console.error('[HRM Content] Error:', error);
    complete(false, normalizeError(error));
  } finally {
    window.__HRM_CONTENT_RUNNING__ = false;
  }

  async function handleLoginPage(data) {
    progress('Đang xử lý trang đăng nhập');

    if (!data.username || !data.password) {
      complete(false, 'Thiếu email hoặc password.');
      return;
    }

    const usernameInput = await waitForAnySelector(['#username', 'input[name="username"]', 'input[type="email"]', 'input[name="email"]'], 12000);
    const passwordInput = await waitForAnySelector(['#password', 'input[name="password"]', 'input[type="password"]'], 12000);
    const submitBtn = findClickable([document.querySelector('#form button'), ...document.querySelectorAll('button, input[type="submit"]')], ['đăng nhập', 'login', 'sign in']) || document.querySelector('#form button');

    if (!usernameInput || !passwordInput || !submitBtn) {
      complete(false, 'Không tìm thấy form đăng nhập HRM.');
      return;
    }

    setNativeValue(usernameInput, data.username);
    setNativeValue(passwordInput, data.password);
    await sleep(250);

    progress('Đã điền thông tin đăng nhập', 'Đang bấm đăng nhập...');
    clickElement(submitBtn);
  }

  async function handleTaskPage(data) {
    progress('Đang xử lý trang công việc ngày');

    if (!data.task || !data.detail) {
      complete(false, 'Thiếu Task hoặc Detail.');
      return;
    }

    await waitForDocumentReady();
    await sleep(500);

    let formBtn = document.querySelector('#bscv div button');
    if (!isVisible(formBtn)) {
      const candidates = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')];
      formBtn = findClickable(candidates, ['thêm', 'thêm mới', 'bổ sung', 'tạo mới', 'công việc', '+']);
    }

    if (!formBtn) {
      complete(false, 'Không tìm thấy nút mở form công việc.');
      return;
    }

    clickElement(formBtn);
    progress('Đã mở form công việc');

    const taskInput = await waitForAnySelector(['#congviec', 'input[name="congviec"]', 'input[placeholder*="công việc" i]'], 12000);
    const timeInput = await waitForAnySelector(['#thoigian', 'input[name="thoigian"]', 'input[placeholder*="ngày" i]'], 12000);

    if (!taskInput || !timeInput) {
      complete(false, 'Không tìm thấy ô nhập công việc hoặc ngày.');
      return;
    }

    setNativeValue(taskInput, data.task);
    setNativeValue(timeInput, getDisplayDate());

    const editorFilled = await fillEditorContent(data.detail);
    if (!editorFilled) {
      complete(false, 'Không tìm thấy ô nhập chi tiết công việc.');
      return;
    }

    await sleep(800);
    progress('Đã điền xong form', data.isTestMode ? 'Chế độ test: không tự bấm Lưu.' : 'Chuẩn bị bấm Lưu...');

    if (data.isTestMode) {
      complete(true, 'Form đã được điền ở chế độ test, chưa bấm Lưu.');
      return;
    }

    const saveBtn = findSaveButton();
    if (!saveBtn) {
      complete(false, 'Không tìm thấy nút Lưu trong form.');
      return;
    }

    clickElement(saveBtn);
    await sleep(1200);
    complete(true, 'Đã bấm Lưu form công việc.');
  }

  async function fillEditorContent(content) {
    progress('Đang điền chi tiết công việc');
    const htmlContent = textToSafeHtml(content);

    if (window.tinymce?.activeEditor) {
      try {
        window.tinymce.activeEditor.setContent(htmlContent);
        window.tinymce.activeEditor.save();
        window.tinymce.activeEditor.fire('change');
        return true;
      } catch (error) {
        console.warn('[HRM Content] TinyMCE active editor failed:', error);
      }
    }

    const iframes = [...document.querySelectorAll('iframe')];
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        const body = iframeDoc?.querySelector('body');
        if (body && isEditableContainer(body)) {
          body.focus();
          body.innerHTML = htmlContent;
          dispatchInputEvents(body);
          return true;
        }
      } catch (error) {
        console.warn('[HRM Content] Could not access iframe editor:', error);
      }
    }

    const editableDiv = [...document.querySelectorAll('[contenteditable="true"], .ck-editor__editable, .note-editable')].find(isVisible);
    if (editableDiv) {
      editableDiv.focus();
      editableDiv.innerHTML = htmlContent;
      dispatchInputEvents(editableDiv);
      return true;
    }

    const textarea = [...document.querySelectorAll('#chitiet, textarea[name="chitiet"], textarea')].find(isVisible);
    if (textarea) {
      setNativeValue(textarea, content);
      return true;
    }

    return false;
  }

  function findSaveButton() {
    const modal = [...document.querySelectorAll('.modal.show, .modal, form, body')].find((el) => el && isVisible(el)) || document.body;
    const candidates = [...modal.querySelectorAll('button, input[type="submit"], input[type="button"], a')].filter(isVisible);
    return findClickable(candidates, ['lưu', 'save', 'hoàn thành', 'cập nhật', 'submit']) || candidates.find((el) => el.type === 'submit');
  }

  function findClickable(elements, keywords) {
    return elements.find((el) => {
      if (!el || !isVisible(el) || el.disabled) return false;
      const text = getElementText(el).toLowerCase();
      return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
    });
  }

  function getElementText(el) {
    return [el.innerText, el.textContent, el.value, el.getAttribute?.('title'), el.getAttribute?.('aria-label')]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function setNativeValue(element, value) {
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    element.focus?.();

    const prototype = Object.getPrototypeOf(element);
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    const ownSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;

    if (valueSetter && ownSetter !== valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }

    dispatchInputEvents(element);
  }

  function dispatchInputEvents(element) {
    ['input', 'change', 'keyup', 'blur'].forEach((type) => {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  function clickElement(element) {
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    element.focus?.();
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  function waitForAnySelector(selectors, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const find = () => selectors.map((selector) => document.querySelector(selector)).find(isVisible);
      const initial = find();
      if (initial) {
        resolve(initial);
        return;
      }

      const observer = new MutationObserver(() => {
        const found = find();
        if (found) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(found);
        }
      });

      observer.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Không tìm thấy selector: ${selectors.join(', ')}`));
      }, timeout);
    });
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }

  function isEditableContainer(element) {
    return element.isContentEditable || element.getAttribute('contenteditable') === 'true' || element.tagName === 'BODY';
  }

  async function waitForDocumentReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') return;
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  function getDisplayDate(date = new Date()) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function getLocalDateKey(date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function textToSafeHtml(text) {
    const escaped = String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    return escaped
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function progress(message, detail = '') {
    try {
      chrome.runtime.sendMessage({ type: 'TASK_PROGRESS', logType: 'info', message, detail, runId });
    } catch (error) {
      console.warn('[HRM Content] Progress message failed:', error);
    }
  }

  function complete(success, message) {
    try {
      chrome.runtime.sendMessage({
        type: 'TASK_COMPLETE',
        success,
        message,
        isTestMode: Boolean(window.__HRM_LAST_TEST_MODE__),
        runId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.warn('[HRM Content] Complete message failed:', error);
    }
  }

  function normalizeError(error) {
    if (!error) return 'Unknown error';
    return error.message || String(error);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
