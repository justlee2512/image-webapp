(() => {
  const key = 'richard-drive-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let starTimer;
  let flightAnimations = [];
  let starAnimations = [];
  let preference;
  let animationTimer;
  try { preference = localStorage.getItem(key); } catch {}
  if (!['light', 'dark'].includes(preference)) preference = null;

  function stopFlight() {
    flightAnimations.forEach((animation) => animation.cancel());
    flightAnimations = [];
  }

  function animateOwl(theme) {
    stopFlight();
    const owl = document.querySelector('.scene-owl-flight');
    if (!owl || reducedMotion.matches || document.hidden || document.body.classList.contains('woodland-drive')) return;
    const arriving = theme === 'dark';
    const duration = arriving ? 3400 : 2500;
    const delay = arriving ? 450 : 0;
    const points = arriving
      ? [[380, -220], [240, -260], [35, -100], [0, 0]]
      : [[0, 0], [35, -75], [220, -210], [460, -360]];
    const frames = Array.from({ length: 81 }, (_, i) => {
      const progress = i / 80;
      // Ease into landing; departure starts with a brief crouch and accelerates.
      const t = arriving ? 1 - (1 - progress) ** 1.65 : Math.max(0, (progress - .1) / .9) ** 1.3;
      const coordinate = (axis) => (1-t)**3 * points[0][axis] + 3*(1-t)**2*t*points[1][axis] + 3*(1-t)*t*t*points[2][axis] + t**3*points[3][axis];
      const x = coordinate(0);
      const crouch = !arriving && progress < .1 ? Math.sin(progress * 10 * Math.PI) * 6 : 0;
      const y = coordinate(1) + crouch + Math.sin(progress * Math.PI * 12) * 1.5 * Math.sin(progress * Math.PI);
      const bank = Math.sin(progress * Math.PI) * (arriving ? -8 : 12);
      const scale = arriving ? .65 + .35 * t : 1 - .5 * t;
      const opacity = arriving ? Math.min(1, progress * 7) : Math.min(1, (1-progress) * 7);
      return { offset: progress, opacity, transform: `translate(${x}px, ${y}px) rotate(${bank}deg) scale(${scale})` };
    });
    const movement = owl.animate(frames, { duration, delay, fill: 'both', easing: 'linear' });
    flightAnimations.push(movement);
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
      const wing = owl.querySelector(`.owl-wing-${side}`);
      if (!wing) continue;
      flightAnimations.push(wing.animate([
        { transform: `rotate(${sign * 20}deg) scaleY(.85)` },
        { transform: `rotate(${sign * -32}deg) scaleY(1)` },
        { transform: `rotate(${sign * 20}deg) scaleY(.85)` }
      ], { duration: arriving ? 425 : 350, iterations: arriving ? 8 : 7, delay, easing: 'ease-in-out' }));
      flightAnimations.push(wing.animate([
        { opacity: 0, offset: 0 }, { opacity: 1, offset: .08 },
        { opacity: 1, offset: .82 }, { opacity: 0, offset: 1 }
      ], { duration, delay, fill: 'both' }));
    }
  }

  function updateStars() {
    clearTimeout(starTimer);
    starAnimations.forEach((animation) => animation.cancel());
    starAnimations = [];
    const stars = [...document.querySelectorAll('.scene-star')];
    if (!stars.length || root.dataset.theme !== 'dark' || reducedMotion.matches || document.hidden) return;
    function sparkle() {
      starAnimations = starAnimations.filter((item) => item.playState !== 'finished');
      const available = stars.filter((star) => !star.getAnimations().length);
      const count = Math.min(10, available.length);
      for (let i = 0; i < count; i++) {
        const index = Math.floor(Math.random() * available.length);
        const [star] = available.splice(index, 1);
        const animation = star.animate([
          { opacity: .38, transform: 'scale(1)', filter: 'drop-shadow(0 0 0px #fff3c9)' },
          { opacity: 1, transform: 'scale(1.65)', filter: 'drop-shadow(0 0 5px #fff3c9)', offset: .2 },
          { opacity: .75, transform: 'scale(1.25)', filter: 'drop-shadow(0 0 3px #fff3c9)', offset: .6 },
          { opacity: .38, transform: 'scale(1)', filter: 'drop-shadow(0 0 0px #fff3c9)' }
        ], { duration: 2600 + Math.random() * 1000, easing: 'ease-in-out' });
        starAnimations.push(animation);
      }
      starTimer = setTimeout(sparkle, 1000 + Math.random() * 300);
    }
    sparkle();
  }

  function apply(theme, animate = false) {
    clearTimeout(animationTimer);
    stopFlight();
    root.classList.remove('theme-changing');
    if (animate) {
      // Restart the scene safely when the switch is clicked again mid-transition.
      void root.offsetWidth;
      root.classList.add('theme-changing');
      animationTimer = setTimeout(() => root.classList.remove('theme-changing'), 4500);
    }
    root.dataset.theme = theme;
    if (animate) animateOwl(theme);
    updateStars();
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.hidden = false;
      button.setAttribute('aria-checked', String(theme === 'dark'));
      button.title = theme === 'dark' ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối';
      button.querySelector('.theme-label').textContent = theme === 'dark' ? 'Tối' : 'Sáng';
    });
  }
  apply(preference || root.dataset.defaultTheme || (system.matches ? 'dark' : 'light'));
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
  reducedMotion.addEventListener('change', () => { stopFlight(); updateStars(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopFlight();
    updateStars();
  });
  system.addEventListener('change', () => {
    if (!preference && !root.dataset.defaultTheme) apply(system.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
    apply(preference || root.dataset.defaultTheme || (system.matches ? 'dark' : 'light'));
  });
})();
