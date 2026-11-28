import { ZOOM_MIN, ZOOM_MAX } from './framing';

type ZoomInput = {
  getTarget: () => number;
  setTarget: (zoom: number) => void;
  cancelPageTurn: () => void;
  isPageDragging: () => boolean;
};

const clamp = (zoom: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));

// Capture touch gestures before the book's single-pointer page handlers.
// After a pinch, consume the remaining fingers until every finger is lifted.
export function attachZoomInput(canvas: HTMLElement, input: ZoomInput) {
  const touches = new Map<number, { x: number; y: number }>();
  let blocked = false;
  let pinch: { distance: number; active: boolean } | null = null;
  let wheelPixels = 0;
  let lastWheelAt = -Infinity;

  const distance = () => {
    const [a, b] = [...touches.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  };
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { canvas.setPointerCapture(event.pointerId); } catch {}
    if (touches.size >= 2) {
      if (!blocked) {
        blocked = true;
        input.cancelPageTurn();
      }
      pinch = { distance: distance(), active: false };
      for (const id of touches.keys()) {
        try { canvas.setPointerCapture(id); } catch {}
      }
    }
    if (blocked) consume(event);
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!blocked) return;
    consume(event);
    if (!pinch || touches.size < 2) return;
    const next = distance();
    let previous = pinch.distance;
    if (!pinch.active) {
      // Ignore the first 6px of finger jitter, without a jump at the threshold.
      const delta = next - previous;
      if (Math.abs(delta) <= 6) return;
      previous += Math.sign(delta) * 6;
      pinch.active = true;
    }
    // Dampen the distance ratio. Rebase at every move, including at the limits,
    // so reversing at the maximum responds immediately instead of getting stuck.
    input.setTarget(clamp(input.getTarget() * Math.pow(next / previous, .55)));
    pinch.distance = next;
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    touches.delete(event.pointerId);
    if (!blocked) return;
    consume(event);
    try { canvas.releasePointerCapture(event.pointerId); } catch {}
    pinch = touches.size >= 2 ? { distance: distance(), active: false } : null;
    if (!touches.size) blocked = false;
  };
  const onWheel = (event: WheelEvent) => {
    // Horizontal trackpad gestures and shift-scroll retain their usual meaning.
    if (event.shiftKey || !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (touches.size || input.isPageDragging()) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, canvas.clientHeight) : 1;
    const pixels = Math.max(-80, Math.min(80, event.deltaY * unit));
    const now = performance.now();
    if (now - lastWheelAt > 160) wheelPixels = 0;
    lastWheelAt = now;
    wheelPixels += pixels;
    if (Math.abs(wheelPixels) < 3) return;
    // At most 2 percentage points per wheel event; pixel/line/page units agree.
    input.setTarget(clamp(input.getTarget() - Math.max(-80, Math.min(80, wheelPixels)) * .025));
    wheelPixels = 0;
  };
  const reset = () => {
    const ids = [...touches.keys()];
    touches.clear(); blocked = false; pinch = null; wheelPixels = 0;
    for (const id of ids) {
      try { canvas.releasePointerCapture(id); } catch {}
    }
  };

  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointermove', onMove, true);
  canvas.addEventListener('pointerup', onUp, true);
  canvas.addEventListener('pointercancel', onUp, true);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  return {
    reset,
    destroy() {
      canvas.removeEventListener('pointerdown', onDown, true);
      canvas.removeEventListener('pointermove', onMove, true);
      canvas.removeEventListener('pointerup', onUp, true);
      canvas.removeEventListener('pointercancel', onUp, true);
      canvas.removeEventListener('wheel', onWheel);
      reset();
    },
  };
}
