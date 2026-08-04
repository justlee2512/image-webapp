(() => {
  'use strict';

  const ui = window.ImageDriveUI || {};
  const showToast = ui.showToast || ((message) => window.alert(message));
  const queueToast = ui.queueToast || (() => {});
  const parseResponse = ui.parseResponse || (async (response) => response.json());
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

  document.querySelectorAll('[data-password-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordTarget);
      if (!input) return;
      const willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      button.textContent = willShow ? 'Ẩn' : 'Hiện';
      button.setAttribute('aria-label', willShow ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      button.setAttribute('aria-pressed', willShow ? 'true' : 'false');
    });
  });

  const password = document.querySelector('#register-password');
  const confirmPassword = document.querySelector('#register-password-confirm');
  const matchMessage = document.querySelector('#password-match');
  function updateMatch() {
    if (!password || !confirmPassword || !matchMessage) return;
    if (!confirmPassword.value) {
      matchMessage.textContent = '';
      confirmPassword.setCustomValidity('');
      return;
    }
    const matches = password.value === confirmPassword.value;
    matchMessage.textContent = matches ? 'Mật khẩu khớp.' : 'Mật khẩu nhập lại chưa khớp.';
    matchMessage.classList.toggle('ok', matches);
    matchMessage.classList.toggle('error', !matches);
    confirmPassword.setCustomValidity(matches ? '' : 'Mật khẩu nhập lại chưa khớp.');
  }
  password?.addEventListener('input', updateMatch);
  confirmPassword?.addEventListener('input', updateMatch);

  document.querySelectorAll('form[data-ajax-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;

      const submitter = event.submitter;
      const button = submitter || form.querySelector('button[type="submit"]');
      const originalText = button?.textContent || '';
      if (button) {
        button.disabled = true;
        button.textContent = 'Đang xử lý…';
      }

      try {
        const action = submitter?.getAttribute('formaction') || form.action;
        const method = (submitter?.getAttribute('formmethod') || form.method || 'POST').toUpperCase();
        const formData = new FormData(form);
        if (!formData.has('_csrf')) formData.set('_csrf', csrfToken);

        const response = await fetch(action, {
          method,
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': csrfToken,
            Accept: 'application/json'
          },
          credentials: 'same-origin',
          body: formData
        });
        const payload = await parseResponse(response);
        if (!response.ok || !payload.ok) {
          throw new Error(payload.message || 'Không thể hoàn thành thao tác.');
        }

        const redirect = payload.redirect || form.dataset.successRedirect;
        const shouldReload = form.dataset.successReload === 'true';
        if (redirect || shouldReload) {
          queueToast(payload.message || 'Thao tác thành công.', 'success');
          window.location.assign(redirect || window.location.href);
          return;
        }

        showToast(payload.message || 'Thao tác thành công.', 'success');
        form.reset();
      } catch (error) {
        showToast(error.message || 'Không thể hoàn thành thao tác.', 'error');
      } finally {
        if (button && document.contains(button)) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    });
  });
})();
