(() => {
  'use strict';

  const STORAGE_KEY = 'image-drive.pending-toast';

  const VERSION_KEY = 'image-drive.frontend-version';

  function clearLegacyFrontendCaches() {
    const currentVersion = document.querySelector('meta[name="asset-version"]')?.content || '';
    if (!currentVersion) return;

    let previousVersion = '';
    try {
      previousVersion = localStorage.getItem(VERSION_KEY) || '';
      localStorage.setItem(VERSION_KEY, currentVersion);
    } catch (_error) {
      return;
    }

    if (!previousVersion || previousVersion === currentVersion) return;

    // This clears Cache Storage and old service workers. The HTTP responses for
    // HTML/CSS/JS also use no-store, which handles the normal browser cache.
    if ('caches' in window) {
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {});
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => {});
    }
  }

  function getStack() {
    return document.querySelector('#toast-stack');
  }

  function showToast(message, type = 'error', duration = 3800) {
    const text = String(message || '').trim();
    if (!text) return;

    const stack = getStack();
    if (!stack) {
      window.alert(text);
      return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'success' ? 'success' : 'error'}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'success' ? '✓' : '!';

    const content = document.createElement('span');
    content.className = 'toast-message';
    content.textContent = text;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Đóng thông báo');
    close.textContent = '×';

    toast.append(icon, content, close);
    stack.appendChild(toast);

    let removeTimer;
    let hideTimer;
    const dismiss = () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
      toast.classList.add('is-hiding');
      removeTimer = window.setTimeout(() => toast.remove(), 280);
    };

    close.addEventListener('click', dismiss);
    window.requestAnimationFrame(() => toast.classList.add('is-visible'));
    hideTimer = window.setTimeout(dismiss, Math.max(1800, Number(duration) || 3800));
  }

  function queueToast(message, type = 'success') {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ message, type }));
    } catch (_error) {
      // Storage may be disabled; the destination page will simply omit the toast.
    }
  }

  function consumeQueuedToast() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      sessionStorage.removeItem(STORAGE_KEY);
      const payload = JSON.parse(raw);
      showToast(payload.message, payload.type);
    } catch (_error) {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (_ignored) {}
    }
  }

  function showServerToasts() {
    document.querySelectorAll('[data-toast-message]').forEach((node) => {
      showToast(node.dataset.toastMessage, node.dataset.toastType || 'error');
      node.remove();
    });
  }

  async function parseResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json().catch(() => ({ ok: false, message: 'Phản hồi từ máy chủ không hợp lệ.' }));
    }
    const text = await response.text().catch(() => '');
    return { ok: response.ok, message: text || (response.ok ? 'Thao tác thành công.' : 'Không thể hoàn thành thao tác.') };
  }

  window.ImageDriveUI = Object.freeze({
    showToast,
    queueToast,
    parseResponse
  });

  document.addEventListener('DOMContentLoaded', () => {
    clearLegacyFrontendCaches();
    consumeQueuedToast();
    showServerToasts();
  }, { once: true });
})();
