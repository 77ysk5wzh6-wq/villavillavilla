import type { BookManifest } from './engine';

// Download every image before revealing the introduction. Keep encoded blobs
// in memory; the existing texture cache still decodes only nearby pages.
export async function preloadBookImages(manifest: BookManifest, signal: AbortSignal,
  progress: (loaded: number, total: number) => void) {
  const sources = [...new Set([...manifest.faces.flatMap(face => [face.src, face.previewSrc].filter((src): src is string => !!src)),
    ...(manifest.spine ? [manifest.spine.src] : [])])];
  const blobs = new Map<string, string>();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let cursor = 0, loaded = 0;
  const release = () => { for (const url of blobs.values()) URL.revokeObjectURL(url); blobs.clear(); };
  const worker = async () => {
    while (cursor < sources.length) {
      const src = sources[cursor++];
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error('책 이미지를 불러오지 못했습니다. 새로고침해 주세요.');
      const blob = await response.blob();
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      blobs.set(src, URL.createObjectURL(blob));
      progress(++loaded, sources.length);
    }
  };
  progress(0, sources.length);
  const jobs = Array.from({ length: Math.min(6, sources.length) }, worker);
  try {
    await Promise.all(jobs);
    return { manifest: { ...manifest, spine: manifest.spine ? { ...manifest.spine, src: blobs.get(manifest.spine.src)! } : undefined,
      faces: manifest.faces.map(face => ({ ...face,
      src: blobs.get(face.src)!, previewSrc: face.previewSrc ? blobs.get(face.previewSrc) : undefined })) }, release };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(jobs);
    release();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
