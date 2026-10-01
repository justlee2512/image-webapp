(() => {
  const key = 'richard-drive-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  let animationTimer;
  try { preference = localStorage.getItem(key); } catch {}
  if (!['light', 'dark'].includes(preference)) preference = null;

  function apply(theme, animate = false) {
    clearTimeout(animationTimer);
    root.classList.remove('theme-changing');
    if (animate) {
      // Restart the short owl arrival even when the switch is clicked quickly.
      void root.offsetWidth;
      root.classList.add('theme-changing');
      animationTimer = setTimeout(() => root.classList.remove('theme-changing'), 900);
    }
    root.dataset.theme = theme;
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.hidden = false;
      button.setAttribute('aria-checked', String(theme === 'dark'));
      button.title = theme === 'dark' ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối';
      button.querySelector('.theme-label').textContent = theme === 'dark' ? 'Tối' : 'Sáng';
    });
  }
  apply(preference || (system.matches ? 'dark' : 'light'));
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(key, preference); } catch {}
        apply(preference, true);
      });
    });
  });
  system.addEventListener('change', () => {
    if (!preference) apply(system.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
    apply(preference || (system.matches ? 'dark' : 'light'));
  });
})();
