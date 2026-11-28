# villa ! villa? villa

Static WebGL book reader. Serve the repository over HTTP; opening `index.html`
directly cannot load the page manifest.

Live site: https://youngikyoun.com/villavillavilla/
GitHub Pages deploys the repository root from `main` after a push to `origin`.

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Open http://127.0.0.1:8766/.

Book size ranges from 60% to the window-fitting 100%, starting at 95% for a
little more space around the book. Desktop readers use
vertical mouse-wheel/trackpad scrolling over the book. On touch screens,
two-finger pinching controls book size; one finger continues to turn pages.

Wheel input is normalized across pixel/line/page units and limited to two
percentage points per event. A pinch ignores the first 6px of finger jitter
and applies a damped distance ratio. Both gestures ease toward their target
over animation frames. A second finger cancels the page drag; fingers left
after a pinch cannot accidentally turn a page.

The book is centered in the complete viewport, including the heading area.
At 100%, one fixed envelope contains the complete page and cover motion, with
a small viewport margin (up to 6px). The camera stays fixed while turning,
holding, or hovering pages; a resting page uses the same scale as an upright
page. In the reading view, only explicit wheel/pinch zoom or a
viewport/fullscreen resize changes the camera. The interface floats above the
book and reserves no space.
Shader-equivalent geometry measurements are retained for clipping tests.

On first entry, all page, preview, and cover images finish downloading before
the reader is revealed. Loading progress is displayed only as a percentage; encoded image blobs are
kept locally while GPU decoding stays limited to nearby pages. After textures
are ready, the scene paints while transparent and fades from 0 to 1 opacity
over one second with gentle acceleration and deceleration. Navigating away
releases those blobs and cancels unfinished downloads.

The first view shows the closed book from above and to its left: a -55-degree
camera azimuth and 20-degree elevation reveal the front cover, printed binding,
and top edge together. A 9-degree entry lens keeps only mild perspective;
distance is compensated by the tangent of the field of view to retain the
framing. The normal reading view keeps its original 5-degree lens and distance.
For a slightly closer overview, its camera distance is 1.3 times the
lens-adjusted reading distance.
Clicking the reading area moves the camera along an arc to the existing reading
position over two seconds, without opening the cover. Quintic smootherstep gives zero velocity
and acceleration at both endpoints, with no overshoot (see
[GPU Gems](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-5-implementing-improved-perlin-noise)).
The left navigation button or Left Arrow key on the front cover returns to the
first oblique view; Right Arrow, Enter, or clicking returns to the front. Inputs
cannot skip through a transition. The book itself retains its normal pose.
After arrival, the camera stays fixed throughout all page and cover turns.
Mouse hover over the closed book in overview gently turns the camera up to 7
degrees according to the pointer's horizontal position: left reveals more of
the front cover, right reveals more of the binding, and the center keeps the
resting angle. A critically damped spring smooths the motion. Leaving the book or
window restores the resting angle. The lens and camera radius stay fixed while
hovering. Hit-testing uses the resting silhouette to avoid edge flicker; blank
space, touch input, and reduced-motion mode do not trigger the effect. Clicking
mid-hover starts the two-second transition from the current pose without a snap.
Reading distance is always calculated from the reading lens, including during
viewport changes in the entry view. Depth planes tighten around the closed book
for the closer entry camera. Closed stacks fill the binding-side head/tail edge;
open stacks retain their gutter taper. Derivative-filtered sheet lines fade to
their mean below pixel resolution, avoiding moire on oblique paper edges.

The spine texture is extracted directly from the supplied print-cover PDF
`윤영익_표지(수정).pdf`. Its central white strip and vertical title are rendered
without retyping or redrawing, excluding the 3mm top/bottom bleed. The versioned
lossless WebP is included in the initial image preload and decoded before entry.
`render_spine.py` reproduces the extraction using PyMuPDF, Pillow and Poppler.

On desktop (at least 769px wide, with a mouse or trackpad), a play button sits
at the top center. Playing expands the seek bar and pushes the button left in
one synchronized 720ms motion, with a shared acceleration/deceleration curve
and no stagger. The bar stays 8px from the button throughout and finishes
centered in the viewport. Audio-clock progress updates every animation frame;
Pause preserves the position and collapses the bar after two seconds, using
the same 720ms duration and easing curve as expansion.
The player dims along with the other idle controls, remaining visible and usable.
Mobile neither shows the player nor creates an audio context or downloads audio.

Light/dark transitions spread in very large Perlin-noise regions over 1.1
seconds, with a soft ink-like boundary and a fresh noise pattern on every
toggle. A lightweight background canvas sits
beneath the transparent WebGL book, and UI colors follow the background at
each control's location. New toggles add independent washes on top: earlier
washes keep spreading to completion underneath, while the newest wash naturally
covers them. Completed layers are folded into the background; reduced-motion
mode switches immediately.

`audio/villa-ambience-loop.mp3` uses only 0:04–3:16 of the supplied recording,
omitting the loud opening transient. It is encoded at 128kbps (about 3.0 MB).
A 1.5-second equal-power tail/head crossfade produces a 190.5-second cycle.
Web Audio loops the decoded buffer without timer
gaps. Play and resume ease in from silence over two seconds using a smoothstep
volume curve; pauses and seeks retain short fades. Audio loads only on the first
play click; leaving the page or switching to mobile stops playback.

After two seconds without pointer activity, the title, toolbar, navigation,
and notices ease to 30% opacity over 1.5 seconds. Pointer movement restores
them within 0.2 seconds. Touch, scrolling, and focusing a control also restore
full opacity. Keyboard page navigation neither brightens the interface nor
resets its idle deadline. Dimmed controls remain clickable. Loading
and error screens remain visible while the reader is not ready.

Selected text spreads (original PDF pages 5, 7, 8, 10, 24, 38, 50, and 61)
use 2880 × 3770 lossless WebP faces. Nearby off-screen faces retain the original
1440px previews to limit decoding and GPU memory; visible faces and moving
sheets use full resolution. The original PDF and page order are unchanged.

Editable TypeScript and regression tests are in `noslop-book-src/`:

```sh
cd noslop-book-src
npm ci
npm test
npm run build
```

To regenerate the selected high-resolution assets, install Pillow and Poppler,
then run `python render_text_pages.py /path/to/1126_윤영익_내지.pdf` from that
directory. The manifest is updated only after all images pass lossless checks.

The book engine adapts the user-provided
[noslopUI paper-turning example](https://noslopui.com/motion-lab/3d-webgl/paper-turning-book-3d).
The title uses Hina Mincho; English interface labels and numbers use locally
hosted Fira Mono Regular.
Page ranges slide left when advancing and right when going back, starting
with the front cover. Each range is clipped separately from the total page
count. Both arrows stay fixed with a 12px gap to the counter's outer space.
The visible label stays centered inside that space; digit-count changes resize
its inner row smoothly over 240ms. Counter decorations do not receive pointer
input, keeping both cover navigation buttons clickable.
Rapid reversals continue from the visible position, and reduced-motion mode
updates the counter immediately.
Three.js and font licenses are included with the assets.
