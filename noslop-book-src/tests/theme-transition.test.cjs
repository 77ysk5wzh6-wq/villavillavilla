const assert = require('node:assert/strict');
const { createInkField, inkCoverage, attachThemeTransition } = require('../.test-build/theme-transition.cjs');

const field = createInkField(192, 128);
assert(field.every(value => value >= 0 && value <= 1));
const middle = field.map(value => inkCoverage(.5, value));
assert(middle.some(value => value < .05) && middle.some(value => value > .95),
  'some broad regions must still be in the old theme while others have changed');
let neighborDifference = 0;
for (let y = 0; y < 128; y++) for (let x = 1; x < 192; x++)
  neighborDifference += Math.abs(field[y * 192 + x] - field[y * 192 + x - 1]);
assert(neighborDifference / (128 * 191) < .025, 'the noise must have large smooth regions instead of pixel grain');
for (const threshold of [.12, .3, .5, .7, .88]) {
  assert.equal(inkCoverage(0, threshold), 0);
  assert.equal(inkCoverage(1, threshold), 1);
  let previous = 0;
  for (let step = 0; step <= 100; step++) {
    const value = inkCoverage(step / 100, threshold);
    assert(value >= previous && value <= 1); previous = value;
  }
}

class Style {
  values = new Map();
  setProperty(name, value) { this.values.set(name, value); }
  getPropertyValue(name) { return this.values.get(name) ?? ''; }
  removeProperty(name) { this.values.delete(name); }
}
const html = { dataset: {}, style: new Style() };
const nodes = [40, 1100].map(left => ({ style: new Style(),
  getBoundingClientRect: () => ({ left, top: 12, width: 60, height: 24 }) }));
const root = { width: 1200, height: 800, querySelectorAll: () => nodes,
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; } };
global.document = { documentElement: html };
global.window = new EventTarget();
const reduced = new EventTarget(); reduced.matches = false;
window.matchMedia = () => reduced;
global.getComputedStyle = () => ({ getPropertyValue: name => name === '--background'
  ? html.dataset.theme === 'dark' ? 'rgb(28, 28, 28)' : 'rgb(239, 239, 239)'
  : html.dataset.theme === 'dark' ? 'rgb(233, 233, 233)' : 'rgb(31, 35, 40)' });
let now = 0, serial = 0, resize, image;
const frames = new Map();
global.performance = { now: () => now };
global.requestAnimationFrame = fn => { const id = ++serial; frames.set(id, fn); return id; };
global.cancelAnimationFrame = id => frames.delete(id);
global.ResizeObserver = class { constructor(fn) { resize = fn; } observe() {} disconnect() {} };
const canvas = { getContext: () => ({ createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
  putImageData: pixels => { image = pixels.data.slice(); } }) };
const advance = elapsed => {
  now += elapsed;
  for (const [id, fn] of [...frames]) { frames.delete(id); fn(now); }
};
const uniform = channel => image.every((value, i) => value === (i % 4 === 3 ? 255 : channel));
const originalRandom = Math.random;
let randomIndex = 0;
Math.random = () => [.15, .15, .65, .9][randomIndex++ % 4];
const transition = attachThemeTransition(root, canvas);
assert(uniform(239), 'initial painting must match the selected theme exactly');
const initial = image.slice();
transition.setDark(true);
assert.deepEqual(image, initial, 'starting must preserve the current frame');
assert.equal(html.dataset.theme, 'dark');
assert(nodes.every(node => node.style.getPropertyValue('--ink')), 'UI colors must be matched to their local background');
advance(550);
assert(image.some((value, i) => i % 4 !== 3 && value < 50));
assert(image.some((value, i) => i % 4 !== 3 && value > 220));
const partial = image.slice();
transition.setDark(false);
assert.deepEqual(image, partial, 'adding another wash must preserve the visible frame');
assert.equal(frames.size, 1, 'overlapping washes must share one animation loop');
advance(110);
assert(image.every((value, i) => i % 4 === 3 || value <= partial[i]),
  'the earlier dark wash must continue spreading before the new light wash becomes visible');
assert(image.some((value, i) => i % 4 !== 3 && value < partial[i]),
  'a new click must not freeze the previous wash');
advance(440);
assert(image.some((value, i) => i % 4 !== 3 && value < 50));
assert(image.some((value, i) => i % 4 !== 3 && value > 220),
  'the new wash must already be visible while the earlier wash finishes underneath');
advance(550);
assert(uniform(239));
assert(nodes.every(node => node.style.values.size === 0));
assert.equal(html.dataset.themeTransition, undefined);
transition.setDark(true); advance(550);
assert.notDeepEqual(image, partial, 'each theme toggle must use a new noise pattern without a reload');
root.width = 600; root.height = 900; resize();
assert.equal(canvas.width, 128); assert.equal(canvas.height, 192);
advance(550); assert(uniform(28), 'resizing mid-transition must still settle at the exact endpoint');
transition.setDark(false); advance(250);
transition.setDark(true); advance(150);
transition.setDark(false);
assert.equal(frames.size, 1);
advance(1100);
assert(uniform(239) && frames.size === 0, 'rapid repeated clicks must finish at the last selected theme');
transition.setDark(true); advance(300);
transition.setDark(false); advance(100);
reduced.matches = true; reduced.dispatchEvent(new Event('change'));
transition.setDark(false);
assert(uniform(239) && frames.size === 0, 'reduced-motion mode must switch immediately');
reduced.matches = false;
transition.setDark(true); advance(500);
window.dispatchEvent(new Event('pagehide'));
assert(uniform(28) && frames.size === 0, 'leaving the page must settle and cancel pending animation');
transition.destroy();
Math.random = originalRandom;
console.log('PASS: independent overlapping ink washes, earlier motion continues underneath, fresh patterns, rapid toggles, exact endpoints, local UI colors, resize recovery, reduced motion, and cleanup.');
