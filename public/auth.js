(() => {
  'use strict';

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

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm || 'Bạn có chắc muốn thực hiện thao tác này?')) event.preventDefault();
    });
  });

  document.querySelectorAll('form[data-busy-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!form.checkValidity()) return;
      const button = event.submitter || form.querySelector('button[type="submit"]');
      if (!button) return;
      button.disabled = true;
      button.dataset.originalText = button.textContent;
      button.textContent = 'Đang xử lý…';
    });
  });
})();
