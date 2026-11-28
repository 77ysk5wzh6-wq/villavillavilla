type CounterPosition = { opening: number; text: string; cover: boolean; label: string };
type CounterFrame = { clip: HTMLSpanElement; value: HTMLSpanElement; animation: Animation | null };

export function attachPageCounter(root: HTMLElement, totalPages: number) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const announcement = document.createElement('span');
  announcement.className = 'sr-only';
  const visual = document.createElement('span');
  visual.className = 'counter-visual';
  visual.setAttribute('aria-hidden', 'true');
  const total = document.createElement('span');
  total.className = 'counter-total';
  total.textContent = ` / ${totalPages}`;
  const totalWidth = total.textContent.length;
  const maxRangeWidth = String(totalPages).length * 2 + 1;
  root.style.setProperty('--counter-space', `${Math.max(11, maxRangeWidth + totalWidth)}ch`);
  visual.style.setProperty('--counter-total-width', `${totalWidth}ch`);
  visual.appendChild(total);
  root.replaceChildren(announcement, visual);

  const frames = new Set<CounterFrame>();
  let active: CounterFrame | null = null;
  let previous: CounterPosition | null = null;
  let totalAnimation: Animation | null = null;
  const duration = 360;
  const easing = 'cubic-bezier(.22,.61,.36,1)';
  const remove = (frame: CounterFrame) => {
    frame.animation?.cancel();
    frame.clip.remove();
    frames.delete(frame);
  };

  return {
    update(position: CounterPosition) {
      if (previous && position.text === previous.text && position.cover === previous.cover) return;
      announcement.textContent = position.label;
      // The outer space keeps both arrows fixed. Only the centered inner row
      // resizes, and the number's clip follows the denominator's left edge.
      visual.style.setProperty('--counter-width', `${position.text.length + (position.cover ? 0 : totalWidth)}ch`);
      const clip = document.createElement('span');
      clip.className = 'counter-window';
      clip.dataset.cover = String(position.cover);
      const value = document.createElement('span');
      value.className = 'counter-value';
      value.textContent = position.text;
      clip.appendChild(value);
      const incoming: CounterFrame = { clip, value, animation: null };
      const direction = previous ? Math.sign(position.opening - previous.opening) : 0;
      const animate = !!active && !!direction && !motion.matches && typeof value.animate === 'function';

      // Remove older exits on rapid turns; continue the current label from its
      // actual on-screen position when the user reverses mid-animation.
      for (const frame of frames) if (frame !== active) remove(frame);
      if (animate && active) {
        const outgoing = active;
        const style = window.getComputedStyle(outgoing.value);
        const from = { transform: style.transform, opacity: style.opacity };
        outgoing.animation?.cancel();
        outgoing.animation = outgoing.value.animate([from,
          { transform: `translateX(${-direction * 100}%)`, opacity: 0 }], { duration, easing });
        outgoing.animation.onfinish = () => remove(outgoing);
        incoming.animation = value.animate([
          { transform: `translateX(${direction * 100}%)`, opacity: 0 },
          { transform: 'translateX(0)', opacity: 1 },
        ], { duration, easing });
        incoming.animation.onfinish = () => { incoming.animation = null; };
      } else {
        for (const frame of frames) remove(frame);
      }
      visual.appendChild(clip);
      frames.add(incoming);

      if (!animate || position.cover !== previous?.cover) {
        const opacity = window.getComputedStyle(total).opacity;
        totalAnimation?.cancel();
        total.style.opacity = position.cover ? '0' : '1';
        if (animate) {
          // Let an outgoing cover caption clear the denominator before it appears.
          totalAnimation = total.animate(position.cover ? [{ opacity }, { opacity: 0 }] : [
            { opacity, offset: 0 }, { opacity, offset: .4 }, { opacity: 1, offset: 1 },
          ], { duration: position.cover ? 120 : duration, easing });
        }
      }
      active = incoming;
      previous = position;
    },
    destroy() {
      for (const frame of frames) remove(frame);
      totalAnimation?.cancel();
      root.textContent = previous?.label ?? '';
    },
  };
}
