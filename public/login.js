const loginForm = document.querySelector('#login-form');

loginForm?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  event.preventDefault();
  loginForm.requestSubmit();
});
