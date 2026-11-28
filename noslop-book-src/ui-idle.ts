const IDLE_DELAY = 2000;

// Opacity timing lives in CSS: 1.5s to 30%, 0.2s to full. Only UI is dimmed; the book's
// viewport and input handlers stay unchanged throughout the transition.
export function attachIdleUI(root: HTMLElement) {
  const captured = { passive: true, capture: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pause = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const show = () => {
    pause();
    if (root.dataset.uiIdle !== 'false') root.dataset.uiIdle = 'false';
    if (!document.hidden) timer = setTimeout(() => {
      timer = undefined;
      root.dataset.uiIdle = 'true';
    }, IDLE_DELAY);
  };
  const onVisibility = () => document.hidden ? pause() : show();
  window.addEventListener('pointermove', show, captured);
  window.addEventListener('pointerdown', show, captured);
  window.addEventListener('wheel', show, { passive: true });
  window.addEventListener('pageshow', show);
  window.addEventListener('pagehide', pause);
  root.addEventListener('focusin', show);
  document.addEventListener('visibilitychange', onVisibility);
  show();
  return {
    show,
    destroy() {
      pause();
      window.removeEventListener('pointermove', show, captured);
      window.removeEventListener('pointerdown', show, captured);
      window.removeEventListener('wheel', show);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('pagehide', pause);
      root.removeEventListener('focusin', show);
      document.removeEventListener('visibilitychange', onVisibility);
      delete root.dataset.uiIdle;
    },
  };
}
