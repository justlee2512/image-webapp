const password = document.querySelector('#register-password');
const passwordConfirm = document.querySelector('#register-password-confirm');
const toggle = document.querySelector('[data-password-toggle]');
const matchMessage = document.querySelector('#password-match');

function validatePasswordMatch() {
  if (!password || !passwordConfirm) return;
  const matches = !passwordConfirm.value || password.value === passwordConfirm.value;
  passwordConfirm.setCustomValidity(matches ? '' : 'Hai mật khẩu không trùng khớp.');
  if (matchMessage) {
    matchMessage.textContent = passwordConfirm.value ? (matches ? '✓ Mật khẩu trùng khớp' : 'Mật khẩu chưa trùng khớp') : '';
    matchMessage.classList.toggle('matches', matches && Boolean(passwordConfirm.value));
    matchMessage.classList.toggle('mismatch', !matches);
  }
}

toggle?.addEventListener('click', () => {
  const showing = password.type === 'text';
  [password, passwordConfirm].forEach((input) => { if (input) input.type = showing ? 'password' : 'text'; });
  toggle.textContent = showing ? 'Hiện' : 'Ẩn';
  toggle.setAttribute('aria-label', showing ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
  toggle.setAttribute('aria-pressed', String(!showing));
  password.focus();
});

password?.addEventListener('input', validatePasswordMatch);
passwordConfirm?.addEventListener('input', validatePasswordMatch);
