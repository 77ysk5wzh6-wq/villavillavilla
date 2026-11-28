const assert = require('node:assert/strict');
const { attachSoundPlayer, DESKTOP_AUDIO_QUERY } = require('../.test-build/sound-player.cjs');

class Element extends EventTarget {
  dataset = {}; attributes = {}; value = '0'; disabled = true;
  style = { values: {}, setProperty(name, value) { this.values[name] = value; } };
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { document.activeElement = this; }
}
const root = new Element(), button = new Element(), panel = new Element(), seek = new Element();
root.querySelector = selector => ({ '[data-sound-toggle]': button, '[data-sound-panel]': panel, '[data-sound-seek]': seek })[selector];
global.document = { activeElement: null };
global.window = new EventTarget();
const desktop = new EventTarget(); desktop.matches = false;
window.matchMedia = query => { assert.equal(query, DESKTOP_AUDIO_QUERY); return desktop; };
let now = 0, serial = 0, rafSerial = 0;
const timers = new Map(), frames = new Map();
global.setTimeout = (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; };
global.clearTimeout = id => timers.delete(id);
global.requestAnimationFrame = fn => { const id = ++rafSerial; frames.set(id, fn); return id; };
global.cancelAnimationFrame = id => frames.delete(id);
const tick = ms => {
  const end = now + ms;
  while (timers.size) {
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (timer.at > end) break;
    now = timer.at; timers.delete(id); timer.fn();
  }
  now = end;
};
const contexts = [], sources = [];
global.AudioContext = class {
  currentTime = 0; destination = {}; closed = false;
  constructor() { contexts.push(this); }
  async resume() {}
  async close() { this.closed = true; }
  async decodeAudioData() { return { duration: 194.5 }; }
  createGain() {
    const events = [];
    return { gain: { value: 1, events, cancelScheduledValues() {},
      setValueAtTime(value, at) { events.push({ value, at }); },
      linearRampToValueAtTime(value, at) { events.push({ value, at }); } }, connect() {}, disconnect() {} };
  }
  createBufferSource() {
    const source = { connect(gain) { this.gain = gain; }, disconnect() {}, start(at, offset) { this.offset = offset; }, stop(at) { this.stopped = at; this.onended?.(); } };
    sources.push(source); return source;
  }
};
let downloads = 0, errors = 0;
const response = () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
global.fetch = async () => { downloads++; return response(); };
const flush = () => new Promise(resolve => setImmediate(resolve));
const click = async () => { button.dispatchEvent(new Event('click')); await flush(); };
const setDesktop = matches => { desktop.matches = matches; desktop.dispatchEvent(new Event('change')); };
const player = attachSoundPlayer(root, 'loop.mp3', () => errors++, () => {});

(async () => {
  await click();
  assert(root.hidden && contexts.length === 0 && downloads === 0, 'mobile must create no audio context or download');
  setDesktop(true);
  assert(!root.hidden && downloads === 0, 'desktop must also wait for an explicit play click');
  await click();
  assert.equal(root.dataset.state, 'playing');
  assert.equal(root.dataset.expanded, 'true');
  assert(!panel.inert && !seek.disabled);
  assert.equal(sources.at(-1).loop, true, 'the audio clock must loop without background JavaScript timers');
  assert.equal(sources.at(-1).loopEnd, 194.5);
  const fade = sources.at(-1).gain.gain.events;
  assert.equal(fade[0].value, 0, 'playback must start from silence');
  assert(fade.at(-1).at >= 1.5 && fade.at(-1).at <= 3, 'playback must ease in over seconds, not milliseconds');
  assert.equal(fade.at(-1).value, 1);
  assert(fade.filter(event => event.at <= .25).every(event => event.value < .1),
    'the beginning of the fade must rise gently');
  contexts[0].currentTime = 10;
  const [frameId, draw] = frames.entries().next().value; frames.delete(frameId); draw();
  assert.equal(Number(seek.value), 10, 'progress must follow the audio clock');
  seek.value = '190'; seek.dispatchEvent(new Event('input'));
  assert.equal(sources.at(-1).offset, 190, 'seeking must immediately start at the requested offset');
  assert(sources.at(-1).gain.gain.events.at(-1).at - contexts[0].currentTime < .1,
    'seeking must retain a short crossfade without another long fade-in');
  contexts[0].currentTime = 20;
  await click();
  assert.equal(Number(seek.value), 5.5, 'pause must preserve the correct offset after wrapping');
  assert.equal(root.dataset.state, 'paused');
  tick(1999); assert.equal(root.dataset.expanded, 'true');
  tick(1); assert.equal(root.dataset.expanded, 'false', 'collapse must start exactly two seconds after pause');
  assert(panel.inert && seek.tabIndex === -1);
  await click();
  assert.equal(downloads, 1, 'resuming must reuse the decoded track');
  assert.equal(sources.at(-1).offset, 5.5);
  await click(); tick(1000); await click(); tick(3000);
  assert.equal(root.dataset.expanded, 'true', 'resuming must cancel a pending collapse');
  await click();
  seek.dispatchEvent(new Event('pointerdown'));
  seek.value = '42'; seek.dispatchEvent(new Event('input'));
  tick(10000); assert.equal(root.dataset.expanded, 'true', 'a held seek gesture must not be collapsed');
  window.dispatchEvent(new Event('pointerup'));
  tick(2000); assert.equal(root.dataset.expanded, 'false');
  setDesktop(false);
  assert(root.hidden && contexts[0].closed && frames.size === 0, 'entering mobile mode must stop playback and release audio');
  setDesktop(true);
  let release;
  global.fetch = () => { downloads++; return new Promise(resolve => { release = () => resolve(response()); }); };
  await click(); assert.equal(root.dataset.state, 'loading');
  await click(); release(); await flush();
  assert.equal(root.dataset.state, 'paused', 'a cancelled download must never start late playback');
  assert.equal(errors, 0);
  global.fetch = async () => ({ ok: false });
  await click();
  assert.equal(errors, 1, 'download errors must leave a usable play button and report the error');
  assert.equal(root.dataset.expanded, 'false');
  global.fetch = async () => response();
  await click(); assert.equal(root.dataset.state, 'playing');
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(root.dataset.state, 'paused');
  assert.equal(root.dataset.expanded, 'false');
  player.destroy();
  assert.equal(timers.size, 0); assert.equal(frames.size, 0);
  await click(); assert.equal(root.dataset.state, 'paused');
  console.log('PASS: desktop-only lazy audio, clock-driven seamless looping/progress, seeking, pause/resume, exact two-second collapse, interrupted loads, errors, mobile changes, and cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
