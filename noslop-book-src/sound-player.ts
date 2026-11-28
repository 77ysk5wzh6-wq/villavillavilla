export const DESKTOP_AUDIO_QUERY = '(min-width: 769px) and (hover: hover) and (pointer: fine)';
const COLLAPSE_DELAY = 2000;
const PLAY_FADE_IN = 2;
const SEEK_FADE_IN = .06;
type Voice = { source: AudioBufferSourceNode; gain: GainNode; offset: number; started: number };

export function attachSoundPlayer(root: HTMLElement, src: string, onError: () => void, onActivity: () => void) {
  const button = root.querySelector<HTMLButtonElement>('[data-sound-toggle]')!;
  const panel = root.querySelector<HTMLElement>('[data-sound-panel]')!;
  const seek = root.querySelector<HTMLInputElement>('[data-sound-seek]')!;
  const desktop = window.matchMedia(DESKTOP_AUDIO_QUERY);
  let context: AudioContext | null = null;
  let buffer: AudioBuffer | null = null;
  let voice: Voice | null = null;
  let loading: AbortController | null = null;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0, generation = 0, offset = 0;
  let requested = false, disposed = false, scrubbing = false;

  const clearCollapse = () => {
    if (collapseTimer !== undefined) clearTimeout(collapseTimer);
    collapseTimer = undefined;
  };
  const expand = (expanded: boolean) => {
    root.dataset.expanded = String(expanded);
    button.setAttribute('aria-expanded', String(expanded));
    panel.inert = !expanded;
    seek.tabIndex = expanded ? 0 : -1;
    if (!expanded && document.activeElement === seek) button.focus({ preventScroll: true });
  };
  const setState = (state: 'paused' | 'loading' | 'playing') => {
    root.dataset.state = state;
    const playing = state !== 'paused';
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', playing ? 'Pause sound' : 'Play sound');
    button.title = playing ? 'Pause sound' : 'Play sound';
    root.setAttribute('aria-busy', String(state === 'loading'));
  };
  const position = () => voice && context && buffer
    ? (voice.offset + context.currentTime - voice.started) % buffer.duration : offset;
  const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const paintProgress = () => {
    const current = position(), duration = buffer?.duration ?? 0;
    seek.value = String(current);
    seek.style.setProperty('--progress', `${duration ? current / duration * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `${timeLabel(current)} / ${timeLabel(duration)}`);
  };
  const tick = () => {
    paintProgress();
    if (requested && voice) frame = requestAnimationFrame(tick);
  };
  const silence = (old: Voice) => {
    const now = context!.currentTime;
    const currentGain = old.gain.gain.value;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(currentGain, now);
    old.gain.gain.linearRampToValueAtTime(0, now + .035);
    old.source.stop(now + .04);
  };
  const startVoice = (at: number) => {
    const audio = context!, decoded = buffer!, now = audio.currentTime;
    const fadeIn = voice ? SEEK_FADE_IN : PLAY_FADE_IN;
    if (voice) silence(voice);
    const source = audio.createBufferSource(), gain = audio.createGain();
    source.buffer = decoded;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = decoded.duration;
    source.connect(gain); gain.connect(audio.destination);
    gain.gain.setValueAtTime(0, now);
    if (fadeIn === PLAY_FADE_IN) {
      // Smoothstep starts and ends gently. Audio-clock ramps keep this fade
      // smooth even when the page is busy or animation frames are suspended.
      for (let step = 1; step <= 32; step++) {
        const t = step / 32;
        gain.gain.linearRampToValueAtTime(t * t * (3 - 2 * t), now + fadeIn * t);
      }
    } else gain.gain.linearRampToValueAtTime(1, now + fadeIn);
    const next = { source, gain, offset: at % decoded.duration, started: now };
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start(now, next.offset);
    voice = next;
  };
  const scheduleCollapse = () => {
    clearCollapse();
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined;
      if (!requested) expand(false);
    }, COLLAPSE_DELAY);
  };
  const pause = (immediately = false) => {
    requested = false; scrubbing = false; generation++;
    loading?.abort(); loading = null;
    if (voice) { offset = position(); silence(voice); voice = null; }
    cancelAnimationFrame(frame); frame = 0;
    setState('paused'); paintProgress();
    clearCollapse();
    if (immediately) expand(false);
    else scheduleCollapse();
  };
  const toggle = async () => {
    if (disposed || !desktop.matches) return;
    onActivity();
    if (requested) { pause(); return; }
    requested = true;
    clearCollapse(); expand(true); setState('loading');
    const current = ++generation;
    try {
      // Create/resume in the actual click handler; no audio or network work on mobile.
      context ??= new AudioContext();
      const audio = context;
      await audio.resume();
      if (disposed || !requested || current !== generation || !desktop.matches) return;
      if (!buffer) {
        const controller = new AbortController();
        loading = controller;
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error('Audio download failed');
        const decoded = await audio.decodeAudioData(await response.arrayBuffer());
        if (controller.signal.aborted || current !== generation || context !== audio) return;
        buffer = decoded; loading = null;
        seek.max = String(decoded.duration);
        seek.disabled = false;
      }
      if (disposed || !requested || !desktop.matches || current !== generation) return;
      startVoice(offset);
      setState('playing'); tick();
    } catch {
      if (disposed || current !== generation) return;
      pause(true); onError();
    }
  };
  const onSeek = () => {
    if (!buffer || !desktop.matches) return;
    onActivity();
    offset = Math.max(0, Math.min(buffer.duration - .001, Number(seek.value) || 0));
    if (voice && requested) startVoice(offset);
    else if (!scrubbing) scheduleCollapse();
    paintProgress();
  };
  const onSeekDown = () => { scrubbing = true; clearCollapse(); onActivity(); };
  const onSeekUp = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (!requested && desktop.matches) scheduleCollapse();
  };
  const onPageHide = () => pause(true);
  const syncDesktop = () => {
    root.hidden = !desktop.matches;
    if (!desktop.matches) {
      pause(true);
      const previousContext = context;
      context = null; buffer = null;
      seek.disabled = true;
      void previousContext?.close();
    }
  };
  button.addEventListener('click', toggle);
  seek.addEventListener('input', onSeek);
  seek.addEventListener('pointerdown', onSeekDown);
  window.addEventListener('pointerup', onSeekUp);
  window.addEventListener('pointercancel', onSeekUp);
  window.addEventListener('pagehide', onPageHide);
  desktop.addEventListener('change', syncDesktop);
  expand(false); setState('paused'); syncDesktop();

  return {
    pause,
    destroy() {
      disposed = true; pause(true);
      button.removeEventListener('click', toggle);
      seek.removeEventListener('input', onSeek);
      seek.removeEventListener('pointerdown', onSeekDown);
      window.removeEventListener('pointerup', onSeekUp);
      window.removeEventListener('pointercancel', onSeekUp);
      window.removeEventListener('pagehide', onPageHide);
      desktop.removeEventListener('change', syncDesktop);
      void context?.close(); context = null; buffer = null;
    },
  };
}
