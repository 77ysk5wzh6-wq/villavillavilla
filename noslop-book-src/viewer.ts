import * as THREE from 'three';
import { init, DEFAULT_PROPS, type BookManifest, type BookPosition } from './engine';
import { ZOOM_DEFAULT } from './framing';
import { attachIdleUI } from './ui-idle';
import { preloadBookImages } from './preload';

const root = document.getElementById('reader')!;
const idleUI = attachIdleUI(root);
const opening = document.getElementById('opening') as HTMLInputElement;
const loading = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;
const fullscreen = document.getElementById('fullscreen') as HTMLButtonElement;
const blackboard = document.getElementById('blackboard') as HTMLButtonElement;
const notice = document.getElementById('notice')!;
let zoomLevel = ZOOM_DEFAULT;
let book: ReturnType<typeof init> | null = null;
let generation = 0;
let jump = 0;
let firstEntry = true;
let startup: AbortController | null = null;
let assets: { release: () => void } | null = null;
let blackboardEnabled = document.documentElement.dataset.theme === 'dark';

function zoomChanged(value: number) {
  zoomLevel = value;
}

const readerProps = () => ({ ...DEFAULT_PROPS, spread: 0, background: blackboardEnabled ? '#1c1c1c' : '#efefef' });

function applyBackground() {
  document.documentElement.dataset.theme = blackboardEnabled ? 'dark' : 'light';
  blackboard.setAttribute('aria-checked', String(blackboardEnabled));
  blackboard.title = blackboardEnabled ? '다크 모드 끄기' : '다크 모드 켜기';
  book?.update(readerProps(), 500);
}

blackboard.addEventListener('click', () => {
  blackboardEnabled = !blackboardEnabled;
  applyBackground();
  try { localStorage.setItem('villa-book-background', blackboardEnabled ? 'black' : 'white'); } catch {}
});
applyBackground();

function showNotice(message: string) {
  idleUI.show();
  notice.textContent = message;
  notice.hidden = false;
}

function positionChanged(position: BookPosition) {
  opening.disabled = position.transitioning || !root.classList.contains('ready');
  opening.max = String(position.total);
  opening.value = String(position.opening);
  opening.setAttribute('aria-valuetext', position.label);
  opening.style.setProperty('--progress', `${position.opening / position.total * 100}%`);
}

async function start() {
  const current = ++generation;
  startup?.abort();
  const controller = new AbortController();
  startup = controller;
  book?.destroy();
  book = null;
  assets?.release(); assets = null;
  root.classList.remove('ready');
  loading.hidden = false;
  loadingText.textContent = '책을 준비하고 있습니다.';
  opening.disabled = true;
  notice.hidden = true;
  try {
    if (location.protocol === 'file:') throw new Error('open-book.command로 책 뷰어를 열어 주세요.');
    const url = new URL('noslop-book-assets/manifest.json', location.href);
    const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) throw new Error('책 이미지 목록을 불러오지 못했습니다. 새로고침해 주세요.');
    const manifest: BookManifest = await response.json();
    if (manifest.faces.length < 4 || manifest.faces.length % 2 !== 0 || !Number.isFinite(manifest.aspect) || manifest.aspect <= 0) throw new Error('책 페이지 구성을 확인해 주세요.');
    manifest.faces = manifest.faces.map(face => ({ ...face, src: new URL(face.src, url).href,
      previewSrc: face.previewSrc ? new URL(face.previewSrc, url).href : undefined }));
    if (manifest.spine) manifest.spine = { ...manifest.spine, src: new URL(manifest.spine.src, url).href };
    const loaded = await preloadBookImages(manifest, controller.signal, (count, total) => {
      if (current === generation) loadingText.textContent = `책 이미지를 불러오는 중… ${Math.round(count / total * 100)}% (${count}/${total})`;
    });
    if (current !== generation || controller.signal.aborted) { loaded.release(); return; }
    assets = loaded;
    // Every load starts at the front cover, including old testing links such as #2.
    if (/^#\d+$/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
    book = init(root, { THREE }, readerProps(), loaded.manifest, positionChanged, zoomChanged, { intro: firstEntry });
    book.setZoom(zoomLevel);
    await book.ready;
    if (current !== generation || controller.signal.aborted) return;
    // Paint the fully textured scene while it is still transparent, then
    // start the fade so shader/texture setup cannot reveal it halfway through.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (current !== generation || controller.signal.aborted) return;
    firstEntry = false;
    root.classList.add('ready');
    idleUI.show();
    root.querySelector('[data-ml-stage]')?.setAttribute('aria-busy', 'false');
    loading.hidden = true;
    opening.disabled = false;
  } catch (error) {
    if (current !== generation || controller.signal.aborted) return;
    book?.destroy(); book = null;
    assets?.release(); assets = null;
    loadingText.textContent = error instanceof Error ? error.message : '책을 열지 못했습니다. 새로고침해 주세요.';
    console.error(error);
  }
}

opening.addEventListener('input', () => opening.style.setProperty('--progress', `${Number(opening.value) / Number(opening.max) * 100}%`));
opening.addEventListener('change', async () => {
  if (!book) return;
  const current = ++jump;
  try {
    opening.disabled = true;
    await book.goTo(Number(opening.value));
    if (current === jump) notice.hidden = true;
  } catch (error) {
    showNotice('페이지 이미지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    console.error(error);
  } finally {
    if (current === jump) opening.disabled = false;
  }
});
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.fullscreenEnabled) await root.requestFullscreen();
    else showNotice('브라우저 메뉴에서 전체 화면을 사용할 수 있습니다.');
  } catch { showNotice('브라우저 메뉴에서 전체 화면을 사용할 수 있습니다.'); }
});
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? '전체 화면 나가기' : '전체 화면 보기';
  fullscreen.setAttribute('aria-label', label);
  fullscreen.title = label;
});
root.addEventListener('book-asset-error', () => showNotice('일부 페이지 이미지를 불러오지 못했습니다. 페이지를 다시 선택해 주세요.'));
root.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  loading.hidden = false;
  loadingText.textContent = '3D 화면 연결이 끊겼습니다. 새로고침해 주세요.';
}, true);
window.addEventListener('pagehide', () => {
  ++generation; startup?.abort(); book?.destroy(); book = null; assets?.release(); assets = null;
});
window.addEventListener('pageshow', event => { if (event.persisted) void start(); });
void start();
