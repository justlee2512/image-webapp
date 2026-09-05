(() => {
  let expired = false;
  let timer;
  let checking = false;

  function show() {
    if (expired) return;
    expired = true;
    window.clearTimeout(timer);
    const dialog = document.createElement('dialog');
    dialog.className = 'session-expiry-card';
    dialog.setAttribute('aria-labelledby', 'session-expiry-title');
    dialog.setAttribute('aria-describedby', 'session-expiry-message');
    const title = document.createElement('h2');
    title.id = 'session-expiry-title';
    title.textContent = 'Phiên đăng nhập đã hết hạn';
    const message = document.createElement('p');
    message.id = 'session-expiry-message';
    message.textContent = 'Vui lòng nhấn Continue để quay về trang đăng nhập.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button primary wide';
    button.textContent = 'Continue';
    button.addEventListener('click', () => window.location.assign('/login'));
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.append(title, message, button);
    document.body.appendChild(dialog);
    dialog.showModal();
    button.focus();
  }

  async function check() {
    if (expired || checking) return;
    window.clearTimeout(timer);
    checking = true;
    let delay = 30000;
    try {
      const response = await fetch('/session-status', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) {
        show();
        return;
      }
      if (response.ok) {
        const status = await response.json();
        if (Number.isFinite(status.remainingMs)) delay = Math.max(1000, Math.min(delay, status.remainingMs));
      }
    } catch {
      // A network failure does not mean the session expired. Retry without interrupting the user.
    } finally {
      checking = false;
      if (!expired) timer = window.setTimeout(check, delay);
    }
  }

  window.sessionExpiry = { show, isExpired: () => expired };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('pageshow', check);
  check();
})();
