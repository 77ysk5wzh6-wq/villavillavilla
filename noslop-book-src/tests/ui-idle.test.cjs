const assert = require('node:assert/strict');
const { attachIdleUI } = require('../.test-build/ui-idle.cjs');

let now = 0, nextId = 0;
const timers = new Map();
global.setTimeout = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
global.clearTimeout = id => timers.delete(id);
global.window = new EventTarget();
global.document = new EventTarget();
document.hidden = false;
const root = new EventTarget();
root.dataset = {};
const tick = ms => {
  const end = now + ms;
  while (timers.size) {
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (timer.at > end) break;
    now = timer.at; timers.delete(id); timer.fn();
  }
  now = end;
};

const ui = attachIdleUI(root);
assert.equal(root.dataset.uiIdle, 'false');
tick(1999); assert.equal(root.dataset.uiIdle, 'false', 'UI must remain visible for the full two-second idle delay');
tick(1); assert.equal(root.dataset.uiIdle, 'true', 'dimming must start exactly after two seconds');
window.dispatchEvent(new Event('pointermove'));
assert.equal(root.dataset.uiIdle, 'false', 'movement must restore UI immediately, including during a fade');
tick(1500);
window.dispatchEvent(new Event('pointermove'));
tick(1999); assert.equal(root.dataset.uiIdle, 'false', 'each movement must restart the two-second delay');
tick(1); assert.equal(root.dataset.uiIdle, 'true');

for (const event of ['pointerdown', 'wheel', 'pageshow']) {
  window.dispatchEvent(new Event(event));
  assert.equal(root.dataset.uiIdle, 'false', `${event} must reveal UI`);
  tick(2000); assert.equal(root.dataset.uiIdle, 'true');
}
for (const key of ['ArrowRight', 'ArrowLeft', 'Enter', ' ']) {
  window.dispatchEvent(Object.assign(new Event('keydown'), { key }));
  assert.equal(root.dataset.uiIdle, 'true', 'keyboard page navigation must keep an idle interface dim');
}
ui.show();
tick(1500);
window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'ArrowRight' }));
tick(500);
assert.equal(root.dataset.uiIdle, 'true', 'a key press must not postpone the original idle deadline');
root.dispatchEvent(new Event('focusin'));
assert.equal(root.dataset.uiIdle, 'false', 'focusing a control must still reveal UI');
tick(1000);
document.hidden = true;
document.dispatchEvent(new Event('visibilitychange'));
tick(10000); assert.equal(root.dataset.uiIdle, 'false', 'hidden tabs must suspend the idle timer');
document.hidden = false;
document.dispatchEvent(new Event('visibilitychange'));
tick(1999); assert.equal(root.dataset.uiIdle, 'false');
tick(1); assert.equal(root.dataset.uiIdle, 'true');
ui.show(); window.dispatchEvent(new Event('pagehide'));
tick(10000); assert.equal(root.dataset.uiIdle, 'false', 'pagehide must stop the timer');
ui.destroy();
assert.equal(root.dataset.uiIdle, undefined);
window.dispatchEvent(new Event('pointermove'));
window.dispatchEvent(new Event('pointerdown'));
window.dispatchEvent(new Event('keydown'));
tick(10000); assert.equal(root.dataset.uiIdle, undefined, 'destroy must remove listeners and timers');
assert.equal(timers.size, 0);

console.log('PASS: exact two-second idle delay, keyboard reading stays dim without resetting the deadline, pointer/touch/scroll/focus recovery, hidden-tab suspension, and cleanup.');
