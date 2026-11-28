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
the reader is revealed. Loading progress is displayed; encoded image blobs are
kept locally while GPU decoding stays limited to nearby pages. Navigating away
releases those blobs and cancels unfinished downloads.

The first view shows the closed book from above and to its left: a -55-degree
camera azimuth and 20-degree elevation reveal the front cover, printed binding,
and top edge together. A 9-degree entry lens keeps only mild perspective;
distance is compensated by the tangent of the field of view to retain the
framing. The normal reading view keeps its original 5-degree lens and distance.
Clicking the reading area moves the camera along an arc to the existing reading
position over two seconds, without opening the cover. Quintic smootherstep gives zero velocity
and acceleration at both endpoints, with no overshoot (see
[GPU Gems](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-5-implementing-improved-perlin-noise)).
The left navigation button or Left Arrow key on the front cover returns to the
first oblique view; Right Arrow, Enter, or clicking returns to the front. Inputs
cannot skip through a transition. The book itself retains its normal pose.
After arrival, the camera stays fixed throughout all page and cover turns.
Mouse hover over the closed book in overview gently turns the camera 7 degrees
toward the front cover, using a critically damped spring. Leaving the book or
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

After two seconds without pointer activity, the title, toolbar, navigation,
and notices fade out over 1.5 seconds. Pointer movement restores
them within 0.2 seconds. Touch, scrolling, keyboard input, and keyboard focus
also reveal controls. Idle controls do not intercept book input. Loading
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
Three.js and font licenses are included with the assets.
