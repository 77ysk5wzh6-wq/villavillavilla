const assert = require('node:assert/strict');
const { preloadBookImages } = require('../.test-build/preload.cjs');
let created = [], revoked = [], serial = 0;
URL.createObjectURL = blob => { assert(blob instanceof Blob); const url = `blob:test-${++serial}`; created.push(url); return url; };
URL.revokeObjectURL = url => revoked.push(url);
const manifest = { title: 'test', author: 'test', aspect: .764, pdfPages: 12,
  spine: { src: 'slow-spine', width: 159, height: 3770 },
  faces: Array.from({ length: 12 }, (_, i) => ({ src: `page-${i}`, previewSrc: 'shared-preview', pdfPage: i + 1, half: 'single' })) };
(async () => {
  let inFlight = 0, maximum = 0, releaseSlow, finished = false;
  const fetched = [], updates = [];
  global.fetch = async src => {
    fetched.push(src); maximum = Math.max(maximum, ++inFlight);
    return { ok: true, blob: async () => {
      if (src === 'slow-spine') await new Promise(resolve => { releaseSlow = resolve; });
      else await new Promise(resolve => setImmediate(resolve));
      inFlight--; return new Blob([src], { type: 'image/webp' });
    } };
  };
  const pending = preloadBookImages(manifest, new AbortController().signal, (n, total) => updates.push([n, total])).then(result => { finished = true; return result; });
  while (!releaseSlow) await new Promise(resolve => setImmediate(resolve));
  assert(!finished, 'the introduction must wait for the spine artwork as well as the page images');
  releaseSlow();
  const loaded = await pending;
  assert.equal(fetched.length, 14, 'shared image paths must download only once');
  assert.equal(new Set(fetched).size, 14);
  assert(maximum <= 6, 'downloads must have bounded concurrency');
  assert.deepEqual(updates[0], [0, 14]);
  assert.deepEqual(updates.at(-1), [14, 14]);
  assert(loaded.manifest.spine.src.startsWith('blob:'));
  assert.equal(loaded.manifest.spine.height, 3770, 'spine metadata must survive preloading');
  for (let i = 0; i < manifest.faces.length; i++) {
    assert(loaded.manifest.faces[i].src.startsWith('blob:'));
    assert(loaded.manifest.faces[i].previewSrc.startsWith('blob:'));
    assert.equal(loaded.manifest.faces[i].pdfPage, manifest.faces[i].pdfPage);
  }
  loaded.release(); loaded.release();
  assert.equal(revoked.length, created.length, 'encoded images must be released exactly once');

  created = []; revoked = [];
  global.fetch = async (src, { signal }) => {
    if (src === 'page-2') { await new Promise(resolve => setImmediate(resolve)); return { ok: false }; }
    if (src === 'page-0') return { ok: true, blob: async () => new Blob([src]) };
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
      else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  await assert.rejects(preloadBookImages(manifest, new AbortController().signal, () => {}));
  assert.deepEqual(revoked.sort(), created.sort(), 'failed loads must cancel workers and release all created image URLs');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(preloadBookImages(manifest, controller.signal, () => {}));
  console.log('PASS: waits for all images, deduplicates downloads, limits concurrency, reports loading progress, preserves page metadata, and cleans up failures/cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
