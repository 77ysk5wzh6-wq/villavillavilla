// Behaviour tests run the real input handlers, springs, ray mapping, and texture
// management with a lightweight DOM/renderer stand-in. Visual GPU QA is separate.
const assert = require('node:assert/strict');
const T = require('three');
const { init, DEFAULT_PROPS, visitBookVertices, bookVertex } = require('../.test-build/engine.cjs');

let now = 0, callback, camera, renderedScene, resizeCallback;
let lockedCamera = null;
const cameraSnapshot = camera => ({
  position: camera.position.toArray(), orientation: camera.quaternion.toArray(),
  projection: camera.projectionMatrix.toArray(), fov: camera.fov, near: camera.near, far: camera.far,
});
class Element extends EventTarget {
  constructor() { super(); this.style = { setProperty() {} }; this.dataset = {}; this.clientWidth = 1200; this.clientHeight = 800; this.children = []; }
  setAttribute() {}
  appendChild(child) { this.children.push(child); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}
  matches() { return false; }
  remove() {}
  getContext() { return { fillRect() {}, createRadialGradient() { return { addColorStop() {} }; } }; }
}
const stage = new Element();
const controls = new Element();
controls.getBoundingClientRect = () => ({ top: stage.clientHeight - (stage.clientHeight <= 450 ? 68 : 88) });
const root = new Element();
const prevButton = new Element(), nextButton = new Element();
root.querySelector = selector => selector === '[data-ml-stage]' ? stage : selector === '.controls' ? controls : selector === '[data-ml-prev]' ? prevButton : selector === '[data-ml-next]' ? nextButton : null;
global.document = new Element();
document.createElement = () => new Element();
document.hidden = false;
global.window = new Element();
window.matchMedia = () => ({ matches: false });
window.devicePixelRatio = 1;
global.performance = { now: () => now };
global.requestAnimationFrame = fn => { callback = fn; return 1; };
global.cancelAnimationFrame = () => {};
global.ResizeObserver = class { constructor(fn) { resizeCallback = fn; } observe() {} disconnect() {} };
global.IntersectionObserver = class { observe() {} disconnect() {} };
global.Image = class { decode() { return Promise.resolve(); } };
global.PointerEvent = class extends Event { constructor(type, values = {}) { super(type, { cancelable: true }); Object.assign(this, { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 0, clientY: 0 }, values); } };
global.WheelEvent = class extends Event { constructor(type, values = {}) { super(type, { cancelable: true }); Object.assign(this, { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false }, values); } };
class Renderer {
  capabilities = { getMaxAnisotropy: () => 4 };
  getPixelRatio() { return 1; }
  setPixelRatio() {}
  setSize() {}
  render(scene, nextCamera) {
    renderedScene = scene; camera = nextCamera; scene.updateMatrixWorld(); camera.updateMatrixWorld();
    if (lockedCamera) assert.deepEqual(cameraSnapshot(camera), lockedCamera,
      'page turns, cover motion, hovering, and held pages must never move or rescale the camera');
  }
  dispose() {}
}
const manifest = { title: 'test', author: 'test', aspect: 542.835 / 708.661, pdfPages: 67,
  faces: Array.from({ length: 134 }, (_, i) => ({ src: `${i}.webp`, pdfPage: i, half: 'single' })) };
const advance = milliseconds => {
  const count = Math.ceil(milliseconds / (1000 / 120));
  for (let i = 0; i < count; i++) { now += 1000 / 120; callback(now); }
};
const point = (x, y = -.35) => {
  const vector = new T.Vector3(x, y, 0).project(camera);
  return { clientX: (vector.x + 1) * 600, clientY: (1 - vector.y) * 400 };
};
let canvas;
const pointer = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, point(x, y)));
const active = book => book.getState().leaves.find(leaf => leaf.index === 1);

(async () => {
  const zoomUpdates = [];
  const book = init(root, { THREE: { ...T, WebGLRenderer: Renderer } }, { ...DEFAULT_PROPS, spread: 1 }, manifest, undefined, value => zoomUpdates.push(value));
  await book.ready;
  canvas = stage.children[0];
  advance(100);
  const originalReadingCamera = cameraSnapshot(camera);
  lockedCamera = cameraSnapshot(camera);
  assert.equal(book.getState().opening, 1);

  pointer('pointerdown', .92);
  advance(3000);
  assert.equal(book.getState().opening, 1, 'holding still must not riffle');
  pointer('pointermove', .7); advance(20);
  pointer('pointermove', .3); advance(700);
  assert.equal(book.getState().dragging, true);
  const held = active(book);
  assert(held.progress > .1 && held.progress < .5, 'a short pull must remain part-way');
  assert(Math.abs(held.curve) > .01, 'the held sheet must remain curved');
  advance(3000);
  assert(Math.abs(active(book).progress - held.progress) < .0001, 'a stationary pointer must keep the pose');
  pointer('pointermove', .65); advance(700);
  assert(active(book).progress < held.progress, 'reversing the pointer must reverse the sheet');
  pointer('pointerup', .65); advance(2500);
  assert.equal(book.getState().opening, 1, 'a paused short pull must settle back without a stale fling');
  assert.equal(book.getState().dragging, false);

  pointer('pointerdown', .92); pointer('pointermove', -.65); advance(1000);
  assert(active(book).progress > .5 && active(book).progress < 1);
  const halfway = active(book).progress;
  advance(2000);
  assert(Math.abs(active(book).progress - halfway) < .0001, 'holding past the spine must not finish on its own');
  pointer('pointerup', -.65); advance(2500);
  assert.equal(book.getState().opening, 2, 'releasing past the spine must complete the turn');

  pointer('pointerdown', -.92); pointer('pointermove', .65); advance(1000);
  pointer('pointerup', .65); advance(2500);
  assert.equal(book.getState().opening, 1, 'left-to-right drag must turn back');

  pointer('pointerdown', .92); pointer('pointermove', -.65); advance(1000);
  pointer('pointercancel', -.65); advance(2500);
  assert.equal(book.getState().opening, 1, 'cancelled input must restore its original side');

  pointer('pointerdown', .92); pointer('pointermove', -.65); advance(700);
  window.dispatchEvent(new Event('blur')); advance(2500);
  assert.equal(book.getState().dragging, false, 'changing windows must release a captured page');
  assert.equal(book.getState().opening, 1);

  for (const opening of [30, manifest.faces.length / 2 - 1, 10, 0, manifest.faces.length / 2, 2]) {
    await book.goTo(opening); advance(50);
    assert.equal(book.getState().opening, opening);
    assert(book.getState().residentFaces <= 20, 'jumping through the book must release distant textures');
  }
  // Lighting must update every surface while preserving the reader's position.
  book.update({ ...DEFAULT_PROPS, spread: 1, lightIntensity: .8, shadowStrength: 0, diffusion: 1 });
  advance(50);
  assert.equal(book.getState().opening, 2, 'lighting controls must not reopen or turn the book');
  let surfaces = 0;
  const groundShadows = new Set();
  renderedScene.traverse(object => {
    for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
      if (material.isShaderMaterial) {
        surfaces++;
        assert.equal(material.uniforms.uLightIntensity?.value, .8, 'every surface must receive brightness');
        assert.equal(material.uniforms.uShadowStrength?.value, 0, 'every surface must receive shadow strength');
        assert.equal(material.uniforms.uDiffusion?.value, 1, 'every surface must receive diffusion');
      }
      if (material.isMeshBasicMaterial && material.transparent && material.map) groundShadows.add(material);
    }
  });
  assert(surfaces > 10, 'lighting verification must include the sheets, boards, and page blocks');
  assert.equal(groundShadows.size, 2, 'both ambient and contact shadows must be included');
  for (const shadow of groundShadows) assert.equal(shadow.opacity, 0, 'zero shadow strength must remove both ground-shadow layers');
  book.update({ ...DEFAULT_PROPS, spread: 1 });
  advance(50);
  for (const shadow of groundShadows) assert(shadow.opacity > 0 && shadow.opacity < .3, 'reset must restore subtle ground-shadow layers');
  assert.equal(book.getState().opening, 2);

  // Changing the backdrop must keep a held page and its printed faces intact.
  pointer('pointerdown', .92); pointer('pointermove', .3); advance(700);
  const heldBeforeTheme = book.getState().leaves.find(leaf => leaf.index === 2).progress;
  const printedFaces = [];
  renderedScene.traverse(mesh => {
    if (mesh.material?.uniforms?.uFront) printedFaces.push([
      mesh.material.uniforms, mesh.material.uniforms.uFront.value.image, mesh.material.uniforms.uBack.value.image,
    ]);
  });
  for (const [background, channel] of [['#1c1c1c', 28 / 255], ['#efefef', 239 / 255]]) {
    book.update({ ...DEFAULT_PROPS, spread: 1, background }); advance(50);
    assert.deepEqual(renderedScene.background.toArray(), [channel, channel, channel], 'the WebGL backdrop must follow the selected theme');
    assert.equal(book.getState().opening, 2);
    assert(book.getState().dragging, 'changing theme must not cancel a held page');
    assert(Math.abs(book.getState().leaves.find(leaf => leaf.index === 2).progress - heldBeforeTheme) < .001);
    for (const [u, front, back] of printedFaces) {
      assert.equal(u.uFront.value.image, front, 'theme must retain the original front-face image');
      assert.equal(u.uBack.value.image, back, 'theme must retain the original back-face image');
    }
  }
  book.update({ ...DEFAULT_PROPS, spread: 1, background: '#1c1c1c' }, 500);
  assert.equal(renderedScene.background.r, 239 / 255, 'starting a fade must not jump to the new background');
  advance(250);
  const midFade = renderedScene.background.r;
  assert(midFade > 28 / 255 && midFade < 239 / 255, 'the background must pass through intermediate brightness');
  book.update({ ...DEFAULT_PROPS, spread: 1, background: '#efefef' }, 500);
  assert.equal(renderedScene.background.r, midFade, 'reversing a fade must continue from the current colour');
  advance(250);
  assert(renderedScene.background.r > midFade && renderedScene.background.r < 239 / 255, 'the reverse fade must brighten gradually');
  advance(260);
  assert.deepEqual(renderedScene.background.toArray(), [239 / 255, 239 / 255, 239 / 255], 'the reverse fade must finish after 500ms');
  book.update({ ...DEFAULT_PROPS, spread: 1, background: '#1c1c1c' }, 500);
  advance(510);
  assert.deepEqual(renderedScene.background.toArray(), [28 / 255, 28 / 255, 28 / 255], 'the dark fade must finish after 500ms');
  assert.equal(book.getState().opening, 2);
  assert(book.getState().dragging, 'fading must keep the held page under pointer control');
  book.update({ ...DEFAULT_PROPS, spread: 1 });
  pointer('pointercancel', .3); advance(2500);

  // Fast cover/first-sheet commands must never animate both surfaces through
  // each other. Find the actual rendered objects by their page textures.
  await book.goTo(0); advance(100);
  const bookGroup = renderedScene.children.find(object => object.isGroup);
  const papers = bookGroup.children.filter(object => object.material?.uniforms?.uFront);
  const findBoard = face => bookGroup.children.find(object => object.isGroup &&
    object.children.some(child => child.material?.uniforms?.uMap?.value?.image?.src === `${face}.webp`));
  const frontBoard = findBoard(0);
  const backBoard = findBoard(manifest.faces.length - 2);
  const firstPaper = papers.find(mesh => mesh.material.uniforms.uFront.value.image.src === '2.webp');
  assert(frontBoard && backBoard && firstPaper);
  const coverView = side => {
    const anchorZ = .055 / 2 + .055 / (manifest.faces.length / 2 - 2) * 2.8;
    const center = new T.Vector3(side * .5, 0, anchorZ).applyMatrix4(bookGroup.matrixWorld);
    const projected = center.clone().project(camera);
    assert(Math.abs(projected.x) < 1e-8 && Math.abs(projected.y) < 1e-8,
      'the tilted cover must stay centered around its own visual center');
    assert(Math.abs(bookGroup.rotation.x) < 1e-10 && Math.abs(bookGroup.rotation.y) < 1e-10,
      'ordinary closed covers must remain front-facing; the previous cover tilt is removed');
  };
  coverView(1);
  for (const board of [frontBoard, backBoard]) for (const face of board.children) {
    assert.equal(face.geometry.parameters.width, firstPaper.geometry.parameters.width, 'cover and paper widths must match');
    assert.equal(face.geometry.parameters.height, firstPaper.geometry.parameters.height, 'cover and paper heights must match');
  }
  await book.goTo(1); advance(100);
  assert(Math.abs(bookGroup.rotation.x) < 1e-10, 'an opened book must return to its normal reading pose');
  assert(Math.abs(bookGroup.rotation.y) < 1e-10, 'open spreads must stay front-facing');
  assert(frontBoard.visible && !backBoard.visible, 'the blank inside front cover stays visible at the first opening');
  await book.goTo(2); advance(100);
  assert(!frontBoard.visible && !backBoard.visible, 'boards beneath printed pages must not leave a visible rim');
  pointer('pointermove', -.92, .5); advance(900);
  assert(frontBoard.visible, 'lifting the first left sheet must reveal the cover underneath');
  pointer('pointerleave', -.92, .5); advance(1800);
  await book.goTo(manifest.faces.length / 2 - 1); advance(100);
  assert(!frontBoard.visible && backBoard.visible, 'the blank inside back cover stays visible at the final opening');
  await book.goTo(0); advance(100);
  assert(frontBoard.visible, 'the front cover must be visible when closed');
  assert(papers.every(mesh => !mesh.visible), 'printed sheets must not be drawn through a closed front cover');
  const blocks = bookGroup.children.flatMap(object => object.children).filter(mesh =>
    Array.isArray(mesh.material) && mesh.material[0]?.uniforms?.uSheets);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.equal(block.material[4].visible, false, 'a page block must not draw a cap over the inner cover');
    assert.equal(block.material[5].visible, false, 'a page block must not draw a coplanar bottom on the inner cover');
  }
  const frontStart = now;
  let firstSheetStart;
  book.turn(1); book.turn(1);
  for (let frame = 0; frame < 500; frame++) {
    advance(1000 / 120);
    if (firstPaper.material.uniforms.uA.value > .0001) {
      firstSheetStart ??= now;
      assert(-frontBoard.rotation.y >= Math.PI / 2, 'the front cover must cross the spine before paper starts');
      assert(-frontBoard.rotation.y + .0001 >= firstPaper.material.uniforms.uA.value, 'the front cover must stay ahead of the first sheet');
    }
  }
  assert.equal(book.getState().opening, 2, 'the queued forward command must still complete');
  assert(firstSheetStart - frontStart >= 500 && firstSheetStart - frontStart < 550, 'front cover must allow paper after a 500ms interval');
  // Rapid first/second-sheet turns expose the cover while both sheets are in
  // the air. Their fractional progress must not fabricate a striped slab.
  await book.goTo(1); advance(100);
  book.turn(1); book.turn(1);
  for (let frame = 0; frame < 40; frame++) {
    advance(1000 / 120);
    assert(!blocks.find(mesh => mesh.material[0].uniforms.uSide.value === -1).visible,
      'airborne pages must not create a page block on the exposed front inner cover');
  }
  await book.goTo(0); advance(100);
  book.turn(1); advance(350);
  let paperX = bookGroup.position.x;
  pointer('pointerdown', paperX + .92, .35);
  pointer('pointermove', paperX + .65, .35);
  assert(!book.getState().dragging, 'the first sheet must respect the 500ms cover interval');
  advance(160);
  paperX = bookGroup.position.x;
  pointer('pointerdown', paperX + .92, .35);
  pointer('pointermove', paperX + .65, .35);
  assert(book.getState().dragging, 'after 500ms an exposed page must be draggable while its cover settles');
  advance(100);
  assert(-frontBoard.rotation.y > firstPaper.material.uniforms.uA.value, 'a dragged page must stay below the opening cover');
  pointer('pointercancel', paperX + .65, .35); advance(2500);
  await book.goTo(2); advance(100);
  book.turn(-1); book.turn(-1);
  for (let frame = 0; frame < 650; frame++) {
    advance(1000 / 120);
    if (frontBoard.rotation.y > -Math.PI + .0001) {
      assert.equal(firstPaper.material.uniforms.uA.value, 0, 'the first sheet must settle before its cover closes');
      assert(Math.abs(firstPaper.material.uniforms.uK2.value) < .002, 'a trailing paper curl must settle before cover contact');
    }
  }
  assert.equal(book.getState().opening, 0);
  assert(papers.every(mesh => !mesh.visible));
  pointer('pointermove', .45, .5); advance(900);
  assert(frontBoard.rotation.y < 0, 'front-cover hover should still work');
  assert.equal(firstPaper.material.uniforms.uA.value, 0, 'cover hover must not lift the covered first sheet');
  pointer('pointerleave', .45, .5); advance(1800);
  assert(papers.every(mesh => !mesh.visible), 'leaving a closed cover must hide the covered paper again');

  await book.goTo(manifest.faces.length / 2); advance(100);
  coverView(-1);
  const lastPaper = papers.find(mesh => mesh.material.uniforms.uFront.value.image.src === `${manifest.faces.length - 4}.webp`);
  assert(lastPaper && papers.every(mesh => !mesh.visible), 'the same occlusion rules apply to the back cover');
  const backStart = now;
  let lastSheetStart;
  book.turn(-1); book.turn(-1);
  for (let frame = 0; frame < 500; frame++) {
    advance(1000 / 120);
    if (lastPaper.material.uniforms.uA.value < Math.PI - .0001) {
      lastSheetStart ??= now;
      assert(-backBoard.rotation.y <= Math.PI / 2, 'the back cover must cross the spine before paper starts');
      assert(-backBoard.rotation.y <= lastPaper.material.uniforms.uA.value + .0001, 'the back cover must stay ahead of the last sheet');
    }
  }
  assert(lastSheetStart - backStart >= 500 && lastSheetStart - backStart < 550, 'back cover must allow paper after a 500ms interval');
  book.turn(1); book.turn(1);
  for (let frame = 0; frame < 650; frame++) {
    advance(1000 / 120);
    if (backBoard.rotation.y < -.0001) {
      assert.equal(lastPaper.material.uniforms.uA.value, Math.PI, 'the last sheet must settle before its cover closes');
    }
  }
  assert.equal(book.getState().opening, manifest.faces.length / 2);
  assert(papers.every(mesh => !mesh.visible));

  // Uneven page stacks used to leave their roots at different heights. Check
  // the actual render uniforms and mesh transforms through both turn directions,
  // including a held/reversed drag near the start of the book.
  const binding = firstPaper.material.uniforms.uBinding.value.clone();
  const assertBound = () => {
    const visible = papers.filter(mesh => mesh.visible);
    assert(visible.length > 0);
    for (const y of [-.5 / manifest.aspect, .5 / manifest.aspect]) {
      const roots = visible.map(mesh => new T.Vector3(0, y, 0)
        .add(mesh.material.uniforms.uBinding.value).applyMatrix4(mesh.matrixWorld));
      for (const root of roots) assert(root.distanceTo(roots[0]) < 1e-10,
        'resting and moving sheets must meet along their entire binding edge');
    }
    for (const mesh of visible) assert(mesh.material.uniforms.uBinding.value.distanceTo(binding) < 1e-10,
      'the binding must not drift as thickness transfers between stacks');
  };
  for (const opening of [2, Math.floor(manifest.faces.length / 4), manifest.faces.length / 2 - 2]) {
    await book.goTo(opening); advance(100); assertBound();
    book.turn(1, .7);
    for (let frame = 0; frame < 240; frame++) { advance(1000 / 120); assertBound(); }
    book.turn(-1, -.7);
    for (let frame = 0; frame < 240; frame++) { advance(1000 / 120); assertBound(); }
  }
  await book.goTo(2); advance(100);
  pointer('pointerdown', .92); pointer('pointermove', .3); advance(700);
  assert(book.getState().dragging); assertBound();
  advance(2000); assertBound();
  pointer('pointermove', .65); advance(700); assertBound();
  pointer('pointercancel', .65); advance(2500); assertBound();
  await book.goTo(2); advance(100);

  // Integrate the rendered row's tangent angles to compare actual corner
  // heights. The grabbed corner must rise higher on either side of the spine.
  const rowPoint = (mesh, yn, distance = mesh.material.uniforms.uW.value) => {
    const u = mesh.material.uniforms;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const width = u.uW.value, gutter = u.uSG.value, middle = width * .5;
    const lo = u.uAR.value, hi = u.uAL.value;
    const angle = clamp(u.uA.value + u.uG.value * yn * Math.sin(u.uA.value), lo, hi);
    const rootAngle = clamp(angle + u.uGut.value, lo, hi);
    const bodyCurve = clamp(u.uK.value * (1 + .45 * u.uG.value * yn),
      (lo - angle) / (middle - gutter), (hi - angle) / (middle - gutter));
    const tailAngle = angle + bodyCurve * (middle - gutter);
    const tailCurve = clamp(bodyCurve + u.uK2.value,
      (lo - tailAngle) / (width - middle), (hi - tailAngle) / (width - middle));
    const dx = distance / 1000;
    let height = 0, horizontal = 0;
    for (let i = 0; i < 1000; i++) {
      const x = (i + .5) * dx;
      const tangent = x < gutter ? rootAngle + (angle - rootAngle) * x / gutter
        : x < middle ? angle + bodyCurve * (x - gutter)
        : tailAngle + tailCurve * (x - middle);
      height += Math.sin(tangent) * dx;
      horizontal += Math.cos(tangent) * dx;
    }
    return new T.Vector3(horizontal, yn * u.uH.value * .5, height);
  };
  const edgeHeight = (mesh, yn) => rowPoint(mesh, yn).z;
  const verifyVertexMapping = mesh => {
    bookGroup.updateMatrixWorld(true);
    const u = mesh.material.uniforms;
    const smooth = (end, x) => { const t = Math.max(0, Math.min(1, x / end)); return t * t * (3 - 2 * t); };
    for (const yn of [-1, 0, 1]) for (const s of [0, .1, .45, .9]) {
      // Independent numerical integration of the shader's tangent angles.
      const expected = rowPoint(mesh, yn, s);
      if (u.uOffC) {
        const offset = u.uOffC.value.clone().addScaledVector(u.uOffP.value, .18 + .82 * smooth(.22 * u.uW.value, s));
        expected.add(u.uBinding.value.clone().lerp(offset, smooth(.055 * u.uW.value, s)));
      } else {
        expected.applyAxisAngle(new T.Vector3(0, 1, 0), u.uA.value);
      }
      expected.applyMatrix4(mesh.matrixWorld);
      const actual = bookVertex(mesh, s, yn * u.uH.value * .5, 0, { x: 0, y: 0, z: 0 });
      assert(expected.distanceTo(new T.Vector3(actual.x, actual.y, actual.z)) < 2e-5,
        'camera measurements must match independently integrated paper/cover shader positions');
    }
  };
  const bow = mesh => rowPoint(mesh, 0, .75).distanceTo(
    rowPoint(mesh, 0, .5).add(rowPoint(mesh, 0, 1)).multiplyScalar(.5));
  for (const side of [1, -1]) {
    await book.goTo(2); advance(100);
    const paper = papers.find(mesh => mesh.material.uniforms.uFront.value.image.src === `${(side > 0 ? 2 : 1) * 2}.webp`);
    pointer('pointerdown', side * .92, 0); pointer('pointermove', side * .65, 0); advance(700);
    verifyVertexMapping(paper);
    const paperBow = bow(paper);
    assert(paperBow > .001);
    pointer('pointercancel', side * .65, 0); advance(2500);
    const opening = side > 0 ? 0 : manifest.faces.length / 2;
    const board = side > 0 ? frontBoard : backBoard;
    const face = board.children.find(mesh => mesh.material?.uniforms?.uMap?.value);
    const offset = -side * .5;
    for (const corner of [1, -1]) {
      await book.goTo(opening); advance(100);
      const y = corner * .45 / manifest.aspect;
      pointer('pointerdown', offset + side * .92, y);
      pointer('pointermove', offset + side * .65, y); advance(700);
      assert(book.getState().dragging, 'a cover must remain directly draggable');
      verifyVertexMapping(face);
      const coverBow = bow(face);
      assert(coverBow > .0001 && coverBow < paperBow * .5, 'cover stock must bend visibly, but much less than an interior sheet');
      assert(edgeHeight(face, corner) > edgeHeight(face, -corner) + .0005, 'the grabbed cover corner must lead on both sides');
      assert(face.geometry.parameters.widthSegments >= 40, 'cover faces need enough vertices for a smooth curve');
      const heldCover = book.getState().leaves.find(leaf => leaf.index === (side > 0 ? 0 : manifest.faces.length / 2 - 1));
      advance(2000);
      assert(Math.abs(book.getState().leaves.find(leaf => leaf.index === heldCover.index).progress - heldCover.progress) < .0001, 'holding a cover must keep its pose');
      pointer('pointermove', offset + side * .85, y); advance(700);
      const reversed = book.getState().leaves.find(leaf => leaf.index === heldCover.index).progress;
      assert(side > 0 ? reversed < heldCover.progress : reversed > heldCover.progress, 'a cover must follow a reversed pull');
      pointer('pointercancel', offset + side * .85, y); advance(2500);
      assert.equal(book.getState().opening, opening);
      assert(Math.abs(face.material.uniforms.uK.value) < .001, 'a closed cover must settle flat again');
    }
  }
  for (const mode of ['hover', 'drag', 'release', 'click']) {
    for (const side of [1, -1]) for (const corner of [1, -1]) {
      await book.goTo(2); advance(100);
      const y = corner * .45 / manifest.aspect;
      const leaf = side > 0 ? 2 : 1;
      const mesh = papers.find(mesh => mesh.material.uniforms.uFront.value.image.src === `${leaf * 2}.webp`);
      if (mode === 'hover') {
        pointer('pointermove', side * .92, y); advance(500);
      } else {
        pointer('pointerdown', side * .92, y);
        if (mode === 'click') {
          pointer('pointerup', side * .92, y); advance(120);
        } else {
          pointer('pointermove', side * .65, y); advance(350);
          assert(book.getState().dragging);
          if (mode === 'release') { pointer('pointerup', side * .65, y); advance(90); }
        }
      }
      assert(edgeHeight(mesh, corner) > edgeHeight(mesh, -corner) + .001,
        `${side > 0 ? 'right' : 'left'} ${corner > 0 ? 'top' : 'bottom'} corner must lift at the pointer during ${mode}`);
      pointer('pointercancel', side * .65, y);
      pointer('pointerleave', side * .65, y);
    }
  }
  await book.goTo(2); advance(100);

  // Every currently visible vertex must fit the same fixed camera, throughout
  // the motion. A resting page intentionally uses the same scale as a raised one.
  const assertFrame = (width, height, zoom) => {
    const margin = Math.min(6, width * .012, height * .012);
    let gap = Infinity, minY = Infinity, maxY = -Infinity, count = 0;
    visitBookVertices(bookGroup, (x, y, z) => {
      const p = new T.Vector3(x, y, z).project(camera);
      const px = (1 + p.x) * width * .5, py = (1 - p.y) * height * .5;
      gap = Math.min(gap, px, width - px, py, height - py);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py); count++;
      assert(p.z > -1 && p.z < 1, 'depth planes must contain the actual book');
    });
    assert(count > 1000, 'frame checks must include the detailed deformed meshes');
    assert(gap >= margin - .001, `book must remain inside ${width}x${height} at zoom ${zoom}`);
    return { minY, maxY };
  };
  lockedCamera = null;
  for (const [width, height] of [[1440, 900], [800, 600], [390, 540], [320, 380], [844, 250], [1600, 300], [100, 2400], [320, 150]]) {
    stage.clientWidth = width; stage.clientHeight = height;
    for (const zoom of [60, 80, 100]) {
    await book.goTo(2); advance(100);
    book.setZoom(zoom);
    resizeCallback(); advance(50);
    assert.equal(book.getState().zoom, zoom);
    const bounds = assertFrame(width, height, zoom);
    const anchorZ = .055 / 2 + .055 / (manifest.faces.length / 2 - 2) * 2.8;
    const center = new T.Vector3(0, 0, anchorZ).project(camera);
    assert(Math.abs(center.x) < .00001 && Math.abs(center.y) < .00001,
      'the resting book must stay centered in the viewport at every zoom and aspect ratio');
    if (width === 1440 && height === 900 && zoom === 100) {
      assert((bounds.maxY - bounds.minY) / height > .8, 'the fixed safe maximum should still use most of the viewport');
      console.log(`Fixed maximum desktop book height: ${((bounds.maxY - bounds.minY) / height * 100).toFixed(1)}% of viewport`);
    }
    assert(camera.near > 1 && camera.far / camera.near < 10, 'the depth range must preserve precision between adjacent book layers');
    lockedCamera = cameraSnapshot(camera);
    book.turn(1, .6);
    for (let i = 0; i < 40; i++) { advance(1000 / 60); assertFrame(width, height, zoom); }
    advance(2000);
    book.turn(-1, -.6);
    for (let i = 0; i < 40; i++) { advance(1000 / 60); assertFrame(width, height, zoom); }
    advance(2000);
    lockedCamera = null;
    }
  }
  assert.equal(book.setZoom(999), 100, 'zoom must clamp to the safe maximum');
  assert.equal(book.setZoom(-10), 60, 'zoom must clamp to the minimum');
  assert.equal(book.setZoom(NaN), 95, 'invalid input must restore the default');
  book.setZoom(100);

  // Covers must use the same fixed scale as interior pages, including on mobile.
  for (const [width, height] of [[1440, 900], [390, 700]]) {
    stage.clientWidth = width; stage.clientHeight = height;
    resizeCallback(); advance(50);
    lockedCamera = cameraSnapshot(camera);
    for (const opening of [0, manifest.faces.length / 2]) {
      await book.goTo(opening); advance(100);
      assertFrame(width, height, 100);
      book.turn(opening === 0 ? 1 : -1);
      for (let i = 0; i < 40; i++) { advance(1000 / 60); assertFrame(width, height, 100); }
      advance(2000); assertFrame(width, height, 100);
    }
    lockedCamera = null;
  }

  // Interface visibility must have no effect on the book's size or center.
  stage.clientWidth = 844; stage.clientHeight = 390;
  resizeCallback(); advance(50);
  const desktopProjection = camera.projectionMatrix.clone();
  const desktopPosition = camera.position.clone();
  root.dataset.uiIdle = 'true'; resizeCallback(); advance(50);
  const centered = new T.Vector3(0, 0, .055).project(camera);
  assert(Math.abs(centered.x) < .001, 'the mobile spread must remain horizontally centered');
  assert.deepEqual(camera.projectionMatrix.toArray(), desktopProjection.toArray(), 'hiding UI must not change book framing');
  assert(camera.position.equals(desktopPosition), 'hiding UI must not move the camera');
  root.dataset.uiIdle = 'false';
  stage.clientWidth = 1200; stage.clientHeight = 800;
  resizeCallback(); advance(50);

  const wheel = values => {
    const event = new WheelEvent('wheel', values);
    canvas.dispatchEvent(event);
    return event;
  };
  for (const values of [{ deltaY: 100 }, { deltaY: 5, deltaMode: 1 }, { deltaY: 1, deltaMode: 2 }, { deltaY: 100000 }]) {
    book.setZoom(85); advance(200);
    assert(wheel(values).defaultPrevented, 'vertical scrolling must adjust the book instead of the browser');
    assert.equal(book.getState().zoom, 85, 'wheel changes must be applied smoothly on animation frames');
    advance(16);
    assert(book.getState().zoom < 85 && book.getState().zoom > 83, 'the first wheel frame must ease gently toward its target');
    advance(600);
    assert.equal(book.getState().zoom, 83, 'large pixel, line, and page wheel events must be capped at two percentage points');
  }
  book.setZoom(85); advance(200);
  assert(!wheel({ deltaY: 1, deltaX: 80 }).defaultPrevented, 'horizontal swipes must not be intercepted');
  assert(!wheel({ deltaY: 80, shiftKey: true }).defaultPrevented, 'shift-scroll must not change zoom');
  for (let i = 0; i < 4; i++) wheel({ deltaY: .4 });
  advance(100);
  assert.equal(book.getState().zoom, 85, 'tiny trackpad jitter must not change book size');
  advance(200);
  for (let i = 0; i < 100; i++) wheel({ deltaY: 80 });
  advance(900); assert.equal(book.getState().zoom, 60);
  wheel({ deltaY: -80 }); advance(600);
  assert.equal(book.getState().zoom, 62, 'reversing at the minimum must respond without accumulated overscroll');
  book.setZoom(99); wheel({ deltaY: -800 }); advance(600);
  assert.equal(book.getState().zoom, 100, 'scrolling must preserve the window-fitting maximum');
  assert.equal(zoomUpdates.at(-1), 100, 'gesture changes must report the current zoom state');

  const touch = (type, id, x, y, primary = id === 11) => {
    const event = new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: primary, clientX: x, clientY: y });
    canvas.dispatchEvent(event);
    return event;
  };
  await book.goTo(2); book.setZoom(85); advance(100);
  const anchor = point(.3, 0);
  touch('pointerdown', 11, anchor.clientX - 60, anchor.clientY);
  assert(touch('pointerdown', 12, anchor.clientX + 60, anchor.clientY).defaultPrevented);
  touch('pointermove', 12, anchor.clientX + 57, anchor.clientY); advance(100);
  assert.equal(book.getState().zoom, 85, 'a pinch must ignore the first six pixels of finger jitter');
  touch('pointermove', 12, anchor.clientX + 20, anchor.clientY);
  advance(16); const firstPinchFrame = book.getState().zoom;
  assert(firstPinchFrame < 85 && firstPinchFrame > 80, 'pinching must ease into the new size');
  advance(600);
  assert(book.getState().zoom > 60 && book.getState().zoom < 80, 'pinching inward must reduce the book with damped sensitivity');
  assert(!book.getState().dragging && book.getState().opening === 2, 'pinching must cancel the initial page press');
  touch('pointerup', 12, anchor.clientX + 20, anchor.clientY);
  touch('pointermove', 11, 40, anchor.clientY);
  touch('pointerup', 11, 40, anchor.clientY); advance(1000);
  assert.equal(book.getState().opening, 2, 'the finger remaining after a pinch must not turn a page');

  // Single-finger turning still works after pinching, and a second touch can
  // safely interrupt an already moving page without completing that turn.
  let p = point(.92, 0); touch('pointerdown', 11, p.clientX, p.clientY);
  p = point(-.65, 0); touch('pointermove', 11, p.clientX, p.clientY); advance(1000);
  assert(book.getState().dragging, 'one finger must still drag pages after a pinch');
  touch('pointerup', 11, p.clientX, p.clientY); advance(2500);
  assert.equal(book.getState().opening, 3);
  p = point(.92, 0); touch('pointerdown', 11, p.clientX, p.clientY);
  p = point(.3, 0); touch('pointermove', 11, p.clientX, p.clientY); advance(300);
  assert(book.getState().dragging);
  touch('pointerdown', 12, p.clientX - 100, p.clientY); advance(600);
  assert(!book.getState().dragging && book.getState().opening === 3, 'a second finger must cancel a page drag before zooming');
  touch('pointercancel', 12, p.clientX - 100, p.clientY);
  touch('pointerup', 11, p.clientX, p.clientY); advance(600);
  assert.equal(book.getState().opening, 3, 'cancelling a pinch must not complete the original page turn');
  book.setZoom(100); advance(100);
  p = point(.3, 0);
  touch('pointerdown', 11, p.clientX, p.clientY);
  touch('pointerdown', 12, p.clientX + 100, p.clientY);
  touch('pointermove', 12, p.clientX + 150, p.clientY); advance(600);
  assert.equal(book.getState().zoom, 100, 'pinching outward must preserve the safe maximum');
  touch('pointermove', 12, p.clientX + 130, p.clientY); advance(600);
  assert(book.getState().zoom < 100, 'pinch reversal must respond immediately after reaching the maximum');
  window.dispatchEvent(new Event('blur')); advance(100);
  touch('pointerup', 12, p.clientX + 130, p.clientY);
  touch('pointerup', 11, p.clientX, p.clientY);
  assert(!book.getState().dragging, 'losing focus must reset touch gestures');
  book.destroy();

  // A preview still decoding must neither block nor overwrite a visible page's
  // high-resolution image when a reader changes openings quickly.
  stage.clientWidth = 1200; stage.clientHeight = 800;
  let releasePreview;
  global.Image = class {
    decode() {
      if (this.src === '2-preview.webp') return new Promise(resolve => { releasePreview = resolve; });
      return Promise.resolve();
    }
  };
  const qualityManifest = { ...manifest, faces: manifest.faces.map((face, i) => ({ ...face, previewSrc: `${i}-preview.webp` })) };
  const qualityBook = init(root, { THREE: { ...T, WebGLRenderer: Renderer } }, { ...DEFAULT_PROPS, spread: 2 }, qualityManifest);
  await qualityBook.goTo(1); advance(50);
  const loadedImages = () => {
    const sources = new Set();
    renderedScene.traverse(mesh => {
      for (const name of ['uFront', 'uBack', 'uMap']) {
        const src = mesh.material?.uniforms?.[name]?.value?.image?.src;
        if (src) sources.add(src);
      }
    });
    return sources;
  };
  assert(loadedImages().has('1.webp') && loadedImages().has('2.webp'), 'visible faces must use their full-resolution source');
  releasePreview(); await qualityBook.ready; advance(50);
  assert(loadedImages().has('2.webp') && !loadedImages().has('2-preview.webp'), 'a stale preview must not downgrade a visible page');
  await qualityBook.goTo(10); advance(50);
  assert(loadedImages().has('19.webp') && loadedImages().has('20.webp'));
  assert(loadedImages().has('18-preview.webp'), 'nearby off-screen pages must use small previews');
  qualityBook.turn(1);
  await new Promise(resolve => setImmediate(resolve));
  advance(100);
  for (const face of [19, 20, 21, 22]) assert(loadedImages().has(`${face}.webp`), 'turning and exposed resting faces must stay at full resolution');
  qualityBook.destroy();

  const transparentBook = init(root, { THREE: { ...T, WebGLRenderer: Renderer } },
    { ...DEFAULT_PROPS, spread: 0 }, manifest, undefined, undefined, { transparentBackground: true });
  await transparentBook.ready; advance(100);
  assert.equal(renderedScene.background, null, 'the ink backdrop must remain visible beneath the WebGL book');
  transparentBook.update({ ...DEFAULT_PROPS, spread: 0, background: '#1c1c1c' }, 500); advance(600);
  assert.equal(renderedScene.background, null, 'theme changes must never restore an opaque WebGL backdrop');
  transparentBook.destroy();

  // Entry waits on assets and explicit input, then moves the camera for two
  // seconds. The model stays still and subsequent page turns lock the camera.
  const intro = init(root, { THREE: { ...T, WebGLRenderer: Renderer } },
    { ...DEFAULT_PROPS, spread: 0 }, { ...manifest, spine: { src: 'spine.webp', width: 159, height: 3770 } }, undefined, undefined, { intro: true });
  await intro.ready; advance(100);
  const introCanvas = stage.children.at(-1);
  introCanvas.getBoundingClientRect = () => stage.getBoundingClientRect();
  const introGroup = renderedScene.children.find(object => object.isGroup);
  const introBinding = introGroup.children.find(mesh => mesh.userData?.bookSurface);
  assert.equal(intro.getState().view, 'overview');
  assert.equal(intro.getState().viewAmount, 1);
  assert.equal(introGroup.rotation.y, 0, 'the entry must move the camera rather than rotate the book');
  assert(camera.position.x < 0 && camera.position.y > 0 && camera.position.z > 0,
    'the camera must reveal the cover, left binding, and top edge from above');
  const entryCamera = cameraSnapshot(camera);
  assert(camera.fov >= 8 && camera.fov <= 10 && camera.near > 1 && camera.far / camera.near < 4,
    'entry must keep only mild perspective with a precise closed-book depth range');
  let entryCover;
  introGroup.traverse(mesh => {
    if (mesh.material?.uniforms?.uMap?.value?.image?.src === '0.webp') entryCover = mesh;
  });
  assert(entryCover);
  const entryEdgeLength = x => {
    const project = y => {
      const point = bookVertex(entryCover, x, y, entryCover.geometry.attributes.position.getZ(0), { x: 0, y: 0, z: 0 });
      return new T.Vector3(point.x, point.y, point.z).project(camera);
    };
    return project(.5 / manifest.aspect).distanceTo(project(-.5 / manifest.aspect));
  };
  const perspectiveRatio = entryEdgeLength(0) / entryEdgeLength(1);
  assert(perspectiveRatio > 1.02 && perspectiveRatio < 1.075,
    'the cover edges must stay nearly parallel with only a mild perspective difference');
  const entryStack = introGroup.children.flatMap(object => object.children).find(mesh =>
    Array.isArray(mesh.material) && mesh.material[0].uniforms?.uSide?.value === 1);
  assert(entryStack?.visible);
  const stackPoint = x => bookVertex(entryStack, x, .5 / manifest.aspect - .004, 1, { x: 0, y: 0, z: 0 });
  const headZ = stackPoint(.8).z;
  for (const x of [0, .025, .1, .22]) assert(Math.abs(stackPoint(x).z - headZ) < 1e-10,
    'a closed book must fill the head edge up to its binding, without an exposed triangular taper');
  assert(introBinding?.visible, 'a solid binding face must be visible between the covers');
  const bindingTexture = introBinding.material.uniforms.uMap.value;
  assert.equal(bindingTexture.image.src, 'spine.webp', 'the binding face must use the supplied spine design');
  assert.equal(introBinding.material.uniforms.uUseMap.value, 1);
  assert.equal(bindingTexture.colorSpace, T.NoColorSpace, 'spine artwork must preserve printed colors like the cover images');
  assert.equal(bindingTexture.flipY, true, 'the supplied artwork must retain its upright image orientation');
  let bindingDisposed = 0;
  bindingTexture.addEventListener('dispose', () => { bindingDisposed++; });
  const introShadows = renderedScene.children.filter(mesh => mesh.material?.isMeshBasicMaterial && mesh.material.map);
  assert.equal(introShadows.length, 2);
  for (const mesh of introShadows) assert(mesh.scale.x >= 1,
    'shadows must retain the closed book footprint while the camera moves');
  assert(prevButton.disabled && !nextButton.disabled);
  lockedCamera = cameraSnapshot(camera);
  resizeCallback(); advance(100);
  assert.deepEqual(cameraSnapshot(camera), entryCamera,
    'entry resize must derive framing from the reading lens instead of feeding back the wide entry lens');
  advance(3000);
  assert.equal(intro.getState().viewAmount, 1, 'the entry view must wait for a click instead of rotating automatically');
  lockedCamera = null;
  const introClick = () => {
    for (const type of ['pointerdown', 'pointerup']) introCanvas.dispatchEvent(new PointerEvent(type, { clientX: 600, clientY: 400 }));
  };
  const key = value => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: value, metaKey: false, ctrlKey: false, altKey: false });
    root.dispatchEvent(event);
  };
  const introMove = (x, y = 0, pointerType = 'mouse') => introCanvas.dispatchEvent(new PointerEvent('pointermove', {
    ...point(x, y), pointerType,
  }));
  const overviewPoint = fraction => {
    let left = Infinity, right = -Infinity;
    visitBookVertices(introGroup, (x, y, z) => {
      const p = new T.Vector3(x, y, z).project(camera);
      left = Math.min(left, p.x); right = Math.max(right, p.x);
    });
    return { clientX: (1 + left + (right - left) * fraction) * stage.clientWidth / 2,
      clientY: stage.clientHeight / 2 };
  };
  const moveOverview = p => introCanvas.dispatchEvent(new PointerEvent('pointermove', p));
  const leftHoverPoint = overviewPoint(.12), rightHoverPoint = overviewPoint(.88), centerHoverPoint = overviewPoint(.5);
  introMove(-1); advance(500);
  assert.equal(intro.getState().overviewHover, 0, 'blank canvas must not activate overview hover');
  introMove(0, 0, 'touch'); advance(500);
  assert.equal(intro.getState().overviewHover, 0, 'touch movement must not activate overview hover');
  moveOverview(leftHoverPoint);
  assert.deepEqual(cameraSnapshot(camera), entryCamera, 'hover must start on animation frames without snapping');
  advance(100);
  assert(intro.getState().overviewHover > 0 && intro.getState().overviewHover < .5,
    'overview hover must accelerate gently toward the cover');
  let lastHover = intro.getState().overviewHover;
  for (let i = 0; i < 50; i++) {
    // Repeated input at an edge must not flicker as the camera changes angle.
    moveOverview(leftHoverPoint); advance(40);
    const value = intro.getState().overviewHover;
    assert(value >= lastHover && value <= 1, 'hover must approach its angle without bounce or edge flicker');
    lastHover = value;
  }
  assert(intro.getState().overviewHover > .6 && intro.getState().overviewHover < 1);
  assert(camera.position.x > entryCamera.position[0] && camera.position.z > entryCamera.position[2],
    'hover must reveal more of the front cover');
  assert.equal(camera.fov, entryCamera.fov, 'hover must not change the lens or create a zoom effect');
  assert.equal(camera.position.y, entryCamera.position[1]);
  assert.equal(intro.getState().opening, 0, 'hover must never open the cover');
  const leftHoverCamera = cameraSnapshot(camera);
  moveOverview(rightHoverPoint);
  assert.deepEqual(cameraSnapshot(camera), leftHoverCamera, 'changing sides must not snap the camera');
  advance(2200);
  assert(intro.getState().overviewHover < -.6 && intro.getState().overviewHover > -1,
    'the right side must tilt in the opposite direction');
  assert(camera.position.x < entryCamera.position[0] && camera.position.z < entryCamera.position[2],
    'right-side hover must reveal more of the binding');
  assert.equal(camera.fov, entryCamera.fov);
  assert.equal(camera.position.y, entryCamera.position[1], 'changing hover sides must preserve camera radius and elevation');
  moveOverview(centerHoverPoint); advance(2200);
  assert(Math.abs(intro.getState().overviewHover) < .01, 'the book center must stay near the resting angle');
  moveOverview(leftHoverPoint); advance(2200);
  introCanvas.dispatchEvent(new PointerEvent('pointerleave'));
  advance(100);
  assert(intro.getState().overviewHover > 0 && intro.getState().overviewHover < 1,
    'leaving must ease back instead of snapping');
  advance(2200);
  assert.deepEqual(cameraSnapshot(camera), entryCamera, 'leaving must restore the exact resting camera');
  moveOverview(rightHoverPoint); advance(250);
  window.dispatchEvent(new Event('blur')); advance(2200);
  assert.deepEqual(cameraSnapshot(camera), entryCamera, 'window blur must clear overview hover');
  introCanvas.dispatchEvent(new PointerEvent('pointerdown', leftHoverPoint));
  moveOverview(rightHoverPoint);
  introCanvas.dispatchEvent(new PointerEvent('pointerup', rightHoverPoint));
  advance(1400);
  assert.equal(intro.getState().view, 'overview', 'a drag in overview must not count as a click');
  assert(intro.getState().overviewHover < -.6, 'releasing a mouse drag must resume hover at the released side');
  introCanvas.dispatchEvent(new PointerEvent('pointerleave')); advance(2200);
  moveOverview(rightHoverPoint); advance(350);
  const hoveredCamera = cameraSnapshot(camera);
  assert(intro.getState().overviewHover < 0 && intro.getState().overviewHover > -1);
  introClick();
  assert.deepEqual(cameraSnapshot(camera), hoveredCamera, 'clicking mid-hover must keep its current camera pose');
  assert(intro.getState().transitioning && prevButton.disabled && nextButton.disabled);
  introClick(); key('ArrowRight');
  advance(100);
  const firstMotion = 1 - intro.getState().viewAmount;
  assert(firstMotion > 0 && firstMotion < .002, 'the camera must accelerate gently from rest');
  advance(900);
  assert(Math.abs(intro.getState().viewAmount - .5) < .01, 'the camera path must be halfway through after one second');
  assert(camera.position.x > entryCamera.position[0] && camera.position.x < 0,
    'the camera must travel around the book toward its frontal position');
  assert.equal(introGroup.rotation.y, 0, 'the book must remain still throughout the camera arc');
  assert.equal(intro.getState().opening, 0, 'the first click must never open the cover');
  advance(900);
  assert(intro.getState().transitioning, 'the transition must remain active before two seconds');
  assert(intro.getState().viewAmount > 0 && intro.getState().viewAmount < .002,
    'the camera must decelerate gently into its final position');
  advance(120);
  assert(!intro.getState().transitioning && intro.getState().viewAmount === 0);
  assert.equal(intro.getState().overviewHover, 0, 'the reading view must have no overview hover offset');
  assert(Math.abs(camera.position.x) < 1e-10);
  assert(camera.position.y < 0, 'arrival must restore the existing reading camera elevation');
  const readingCamera = cameraSnapshot(camera);
  assert.deepEqual(readingCamera, originalReadingCamera,
    'the arrival camera, lens, scale, and depth planes must exactly match the unchanged reading view');
  lockedCamera = readingCamera;
  advance(2000);
  assert(Math.abs(introGroup.rotation.y) < 1e-10 && Math.abs(introGroup.rotation.x) < 1e-10,
    'the final cover pose must be frontal, without the removed cover tilt');
  assert(!prevButton.disabled, 'the left arrow must be available on the front cover');
  lockedCamera = null;
  prevButton.dispatchEvent(new Event('click')); advance(2100);
  assert.equal(intro.getState().viewAmount, 1, 'the left button on the cover must return to the first oblique view');
  assert.deepEqual(cameraSnapshot(camera), entryCamera, 'returning must restore the exact initial camera position');
  key('ArrowRight'); advance(2100);
  assert.equal(intro.getState().viewAmount, 0);
  assert.deepEqual(cameraSnapshot(camera), readingCamera);
  key('ArrowLeft'); advance(2100);
  assert.equal(intro.getState().viewAmount, 1, 'the left arrow key must also return to the first oblique view');
  key('Enter'); advance(2100);
  assert.equal(intro.getState().viewAmount, 0);
  lockedCamera = cameraSnapshot(camera);
  nextButton.dispatchEvent(new Event('click')); advance(2500);
  assert.equal(intro.getState().opening, 1, 'after the intro, the next action must turn the cover normally');
  assert.equal(intro.getState().viewAmount, 0);
  assert(stackPoint(0).z < stackPoint(.8).z - .01,
    'opening the cover must restore the original taper below the printed paper binding');
  lockedCamera = null;
  intro.setZoom(100);
  for (const [width, height] of [[1440, 900], [390, 700], [844, 250], [320, 150]]) {
    stage.clientWidth = width; stage.clientHeight = height;
    resizeCallback(); await intro.goTo(0); advance(100);
    assert.equal(intro.getState().view, 'front', 'ordinary navigation must not replay the first-entry oblique view');
    assert(Math.abs(camera.position.x) < 1e-10, 'ordinary navigation must restore the reading camera');
    for (const direction of [-1, 1]) {
      intro.turn(direction);
      let previousAmount = intro.getState().viewAmount;
      for (let i = 0; i < 65; i++) {
        advance(1000 / 30);
        const amount = intro.getState().viewAmount;
        assert(amount >= 0 && amount <= 1 && (direction < 0 ? amount >= previousAmount : amount <= previousAmount),
          'the camera must approach each endpoint monotonically without overshoot');
        previousAmount = amount;
        let gap = Infinity;
        const projected = new T.Vector3();
        visitBookVertices(introGroup, (x, y, z) => {
          projected.set(x, y, z).project(camera);
          const px = (1 + projected.x) * width / 2, py = (1 - projected.y) * height / 2;
          gap = Math.min(gap, px, width - px, py, height - py);
          assert(projected.z > -1 && projected.z < 1);
        });
        assert(gap >= Math.min(6, width * .012, height * .012) - .01, 'both camera paths must keep the complete book inside the viewport');
      }
      if (direction < 0) {
        const hoverPoints = [overviewPoint(.12), overviewPoint(.88)];
        for (const [side, hoverPoint] of hoverPoints.entries()) {
          moveOverview(hoverPoint);
          for (let i = 0; i < 15; i++) {
            advance(50);
            visitBookVertices(introGroup, (x, y, z) => {
              const p = new T.Vector3(x, y, z).project(camera);
              const gap = Math.min((1 + p.x) * width / 2, (1 - p.x) * width / 2,
                (1 + p.y) * height / 2, (1 - p.y) * height / 2);
              assert(gap >= Math.min(6, width * .012, height * .012) - .01 && p.z > -1 && p.z < 1,
                'overview hover must keep the entire book inside every tested viewport');
            });
          }
          assert(side === 0 ? intro.getState().overviewHover > .6 : intro.getState().overviewHover < -.6,
            'both sides must activate directional hover at every viewport size');
        }
        introCanvas.dispatchEvent(new PointerEvent('pointerleave')); advance(2200);
      }
      lockedCamera = cameraSnapshot(camera);
      advance(300);
      lockedCamera = null;
    }
  }
  intro.destroy();
  assert.equal(bindingDisposed, 1, 'destroying the reader must release the spine texture');
  window.matchMedia = () => ({ matches: true });
  const reducedIntro = init(root, { THREE: { ...T, WebGLRenderer: Renderer } },
    { ...DEFAULT_PROPS, spread: 0 }, manifest, undefined, undefined, { intro: true });
  await reducedIntro.ready; advance(100);
  lockedCamera = cameraSnapshot(camera);
  stage.children.at(-1).dispatchEvent(new PointerEvent('pointermove', {
    clientX: stage.clientWidth / 2, clientY: stage.clientHeight / 2,
  }));
  advance(1200);
  assert.equal(reducedIntro.getState().overviewHover, 0, 'reduced-motion mode must omit decorative hover');
  lockedCamera = null;
  reducedIntro.destroy();
  window.matchMedia = () => ({ matches: false });
  console.log('PASS: frontal covers and spreads, fixed camera throughout page/cover motion, and no clipping at three zoom levels across eight viewport sizes.');
  console.log('PASS: visible/turning faces use full resolution, off-screen previews bound memory, and stale image requests cannot downgrade visible text.');
  console.log('PASS: damped wheel/pinch zoom, jitter filtering, input-unit normalization, smooth frames, safe limits, centering, zoom callbacks, and pinch/page-turn handoff.');
  console.log('PASS: moderate perspective, smooth directional overview hover, stable hit-testing, exit/blur recovery, mid-hover click continuity, unchanged reading camera, two-second camera arc, and viewport containment.');
})().catch(error => { console.error(error); process.exitCode = 1; });
