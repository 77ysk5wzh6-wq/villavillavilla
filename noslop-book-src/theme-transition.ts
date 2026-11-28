const DURATION = 1100;
const COLORS = ['--background', '--ink', '--muted', '--counter', '--line', '--focus', '--control-hover',
  '--track', '--track-progress', '--thumb', '--switch-outline', '--switch-fill'];
type Color = [number, number, number, number];
type InkLayer = { target: number; started: number; field: Float32Array };
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const GRADIENTS = [[1, 0], [-1, 0], [0, 1], [0, -1],
  [.7071, .7071], [-.7071, .7071], [.7071, -.7071], [-.7071, -.7071]];

// Gradient Perlin noise with a quintic fade. Only a few lattice cells span the
// viewport, keeping the transition broad and fluid rather than grainy.
function perlin(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (gx: number, gy: number, dx: number, dy: number) => {
    let h = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const direction = (h ^ (h >>> 16)) & 7;
    return GRADIENTS[direction][0] * dx + GRADIENTS[direction][1] * dy;
  };
  return lerp(lerp(dot(ix, iy, fx, fy), dot(ix + 1, iy, fx - 1, fy), fade(fx)),
    lerp(dot(ix, iy + 1, fx, fy - 1), dot(ix + 1, iy + 1, fx - 1, fy - 1), fade(fx)), fade(fy));
}

export function createInkField(width: number, height: number, seed = 4189) {
  const field = new Float32Array(width * height), size = Math.min(width, height);
  let low = Infinity, high = -Infinity;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + .5) / size * .105 + 2.37, v = (y + .5) / size * .105 + 5.19;
    const value = perlin(u, v, seed) * .88 + perlin(u * 2.15 + 7.3, v * 2.15 - 1.9, seed + 73) * .12;
    field[y * width + x] = value;
    low = Math.min(low, value); high = Math.max(high, value);
  }
  for (let i = 0; i < field.length; i++) field[i] = .12 + (field[i] - low) / Math.max(.001, high - low) * .76;
  return field;
}

export function inkCoverage(progress: number, threshold: number) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const frontier = -.18 + 1.36 * smooth(progress);
  return smooth(clamp((frontier - threshold + .18) / .36));
}

function color(value: string): Color {
  if (value === 'transparent') return [0, 0, 0, 0];
  if (value.startsWith('#')) {
    const hex = value.length === 4 ? value.slice(1).split('').map(c => c + c).join('') : value.slice(1);
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  const values = value.match(/[\d.]+/g)!.map(Number);
  return [values[0], values[1], values[2], values[3] ?? 1];
}

export function attachThemeTransition(root: HTMLElement, canvas: HTMLCanvasElement) {
  const html = document.documentElement;
  const context = canvas.getContext('2d', { alpha: false });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ui = [...root.querySelectorAll<HTMLElement>('.reader-ui')];
  const palettes: Color[][] = [];
  const originalTheme = html.dataset.theme, originalTransition = html.style.getPropertyValue('transition');
  // Read the CSS palettes once, before painting, so CSS remains the source of
  // truth for both endpoint colors. Restore the initial theme in the same task.
  html.style.setProperty('transition', 'none');
  for (const theme of ['light', 'dark']) {
    html.dataset.theme = theme;
    const styles = getComputedStyle(html);
    palettes.push(COLORS.map(name => color(styles.getPropertyValue(name).trim())));
  }
  if (originalTheme === undefined) delete html.dataset.theme;
  else html.dataset.theme = originalTheme;
  getComputedStyle(html).getPropertyValue('--background');
  if (originalTransition) html.style.setProperty('transition', originalTransition);
  else html.style.removeProperty('transition');

  let target = originalTheme === 'dark' ? 1 : 0;
  let base = target;
  let width = 0, height = 0, frame = 0, running = false;
  let levels = new Float32Array();
  const layers: InkLayer[] = [];
  let pixels: ImageData;
  let seed = Math.floor(Math.random() * 0x7fffffff);
  const clearUI = () => {
    for (const node of ui) for (const name of COLORS) node.style.removeProperty(name);
    delete html.dataset.themeTransition;
  };
  const paint = () => {
    if (!context || !width || !height) return;
    const light = palettes[0][0], dark = palettes[1][0];
    for (let i = 0; i < levels.length; i++) {
      for (let channel = 0; channel < 3; channel++) pixels.data[i * 4 + channel] = lerp(light[channel], dark[channel], levels[i]);
      pixels.data[i * 4 + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    if (running) {
      const bounds = root.getBoundingClientRect();
      for (const node of ui) {
        const rect = node.getBoundingClientRect();
        const x = Math.max(0, Math.min(width - 1, Math.floor((rect.left + rect.width / 2 - bounds.left) / Math.max(1, bounds.width) * width)));
        const y = Math.max(0, Math.min(height - 1, Math.floor((rect.top + rect.height / 2 - bounds.top) / Math.max(1, bounds.height) * height)));
        const amount = levels[y * width + x];
        for (let i = 0; i < COLORS.length; i++) {
          const a = palettes[0][i], b = palettes[1][i];
          node.style.setProperty(COLORS[i], `rgba(${Math.round(lerp(a[0], b[0], amount))},${Math.round(lerp(a[1], b[1], amount))},${Math.round(lerp(a[2], b[2], amount))},${lerp(a[3], b[3], amount)})`);
        }
      }
    }
  };
  const finish = () => {
    cancelAnimationFrame(frame); frame = 0; running = false;
    layers.length = 0; base = target;
    levels.fill(base); paint(); clearUI();
  };
  const step = (now: number) => {
    frame = 0;
    // Every click adds a separate wash. Older washes keep their own clocks
    // and keep spreading underneath newer ones until they finish completely.
    while (layers.length && now - layers[0].started >= DURATION) base = layers.shift()!.target;
    if (!layers.length) { finish(); return; }
    levels.fill(base);
    for (const layer of layers) {
      const progress = clamp((now - layer.started) / DURATION);
      for (let i = 0; i < levels.length; i++)
        levels[i] = lerp(levels[i], layer.target, inkCoverage(progress, layer.field[i]));
    }
    paint();
    frame = requestAnimationFrame(step);
  };
  const resize = () => {
    if (!context) return;
    const bounds = root.getBoundingClientRect(), scale = Math.min(1, 192 / Math.max(1, bounds.width, bounds.height));
    const nextWidth = Math.max(1, Math.round(bounds.width * scale)), nextHeight = Math.max(1, Math.round(bounds.height * scale));
    if (width === nextWidth && height === nextHeight) return;
    const previous = levels, oldWidth = width, oldHeight = height;
    canvas.width = width = nextWidth; canvas.height = height = nextHeight;
    pixels = context.createImageData(width, height);
    const resample = (values: Float32Array) => {
      const resized = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        resized[y * width + x] = values.length ? values[Math.min(oldHeight - 1, Math.floor(y / height * oldHeight)) * oldWidth + Math.min(oldWidth - 1, Math.floor(x / width * oldWidth))] : base;
      return resized;
    };
    levels = resample(previous);
    for (const layer of layers) layer.field = resample(layer.field);
    paint();
  };
  const setDark = (dark: boolean, animate = true) => {
    target = dark ? 1 : 0;
    if (!context || !animate || reduced.matches) {
      html.dataset.theme = dark ? 'dark' : 'light'; finish(); return;
    }
    const nextSeed = Math.floor(Math.random() * 0x7fffffff);
    seed = nextSeed === seed ? (seed + 1) & 0x7fffffff : nextSeed;
    layers.push({ target, started: performance.now(), field: createInkField(width, height, seed) });
    running = true;
    paint();
    html.dataset.themeTransition = 'true';
    html.dataset.theme = dark ? 'dark' : 'light';
    if (!frame) frame = requestAnimationFrame(step);
  };
  const onReduced = () => { if (reduced.matches) finish(); };
  const observer = new ResizeObserver(resize);
  observer.observe(root); resize();
  reduced.addEventListener('change', onReduced);
  window.addEventListener('pagehide', finish);
  return {
    setDark,
    destroy() {
      finish(); observer.disconnect(); reduced.removeEventListener('change', onReduced);
      window.removeEventListener('pagehide', finish);
    },
  };
}
