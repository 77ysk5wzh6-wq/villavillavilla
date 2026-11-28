// Adapted from the user-supplied noslopUI Motion Lab example.
// https://noslopui.com/motion-lab/3d-webgl/paper-turning-book-3d
// Original three-arc GPU sheet deformation and lighting are retained.
// Adaptations: real PDF faces, bounded texture cache, manual-only holding,
// cancellation handling, and stale fling-velocity correction.
import type * as THREE from 'three';
import { fitBookFrame, ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX } from './framing';
import { attachZoomInput } from './zoom-input';
import { attachPageCounter } from './page-counter';
export { visitBookVertices, bookVertex } from './book-geometry';

export const DEFAULT_PROPS = /* @props */ { paper: "#ffffff", ink: "#1f2328", accent: "#626974", background: "#efefef", spread: 0, curl: 0.85, cone: 0.65, shine: 0.18, speed: 1, autoplay: false, lightIntensity: 1, shadowStrength: 0.3, diffusion: 0.82 } /* @end-props */;

export type Props = typeof DEFAULT_PROPS;
export type Face = { src: string; previewSrc?: string; width?: number; height?: number; pdfPage: number | null; half: string };
export type BookManifest = { title: string; author: string; aspect: number; pdfPages: number; faces: Face[];
  spine?: { src: string; width?: number; height?: number } };
export type CoverView = 'front' | 'overview';
export type BookPosition = { opening: number; total: number; left: number | null; right: number | null; label: string; transitioning: boolean; view: CoverView };

export function init(root: HTMLElement, libs: { THREE: typeof import('three') }, initial: Props, manifest: BookManifest, onChange?: (position: BookPosition) => void, onZoomChange?: (zoom: number) => void, options: { intro?: boolean; transparentBackground?: boolean } = {}) {
  const T = libs.THREE;
  const stage = root.querySelector('[data-ml-stage]') as HTMLElement;
  const counter = root.querySelector('[data-ml-counter]') as HTMLElement | null;
  const pageCounter = counter ? attachPageCounter(counter, manifest.faces.length - 2) : null;
  const prevBtn = root.querySelector('[data-ml-prev]') as HTMLButtonElement | null;
  const nextBtn = root.querySelector('[data-ml-next]') as HTMLButtonElement | null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let props = initial;
  let coverView: CoverView = options.intro && initial.spread === 0 ? 'overview' : 'front';
  let viewAmount = coverView === 'overview' ? 1 : 0;
  let overviewHover = 0, overviewHoverTarget = 0, overviewHoverVelocity = 0;
  let viewTransition: { from: number; to: number; fromHover: number; started: number } | null = null;
  // Shared by paper, boards, and page blocks so the controls affect the whole book.
  const lightingUniforms = {
    uLightIntensity: { value: props.lightIntensity },
    uShadowStrength: { value: props.shadowStrength },
    uDiffusion: { value: props.diffusion },
  };

  // ---------------------------------------------------------------- renderer, camera
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;-webkit-user-select:none;user-select:none;';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '책 모서리를 잡아 넘기세요. 좌우 방향키로도 넘길 수 있습니다. 두 손가락 핀치 또는 세로 스크롤로 책 크기를 조절할 수 있습니다.');
  canvas.tabIndex = 0;
  stage.appendChild(canvas);

  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Colours are passed through untouched: textures are raw canvas values and the shaders output them as-is.
  renderer.outputColorSpace = T.LinearSRGBColorSpace;
  const scene = new T.Scene();
  const backgroundColor = new T.Color(props.background);
  scene.background = options.transparentBackground ? null : backgroundColor;
  const backgroundFrom = new T.Color();
  const backgroundTarget = new T.Color();
  let backgroundStarted = 0;
  let backgroundDuration = 0;
  const READING_FOV = 5;
  const ENTRY_FOV = 9;
  const camera = new T.PerspectiveCamera(READING_FOV, 1, 0.1, 60);
  const overviewHitCamera = camera.clone();

  const W = 1; // page width
  const H = 1 / manifest.aspect; // page height
  const PI = Math.PI;
  const PAPER_LEAVES = manifest.faces.length / 2 - 2; // leaves between the two coated covers
  const LEAVES = PAPER_LEAVES + 2; // leaf 0 is the front board, the last one the back board
  const EPS = Math.min(0.0024, 0.055 / Math.max(1, PAPER_LEAVES)); // one sheet's thickness in the stack
  const BT = EPS * 2.8; // coated cover stock, visibly thicker than an interior sheet
  const COVER_FLEX = 0.24;
  const COVER_TAIL = 0.18;
  const COVER_TWIST = 0.2;
  const COVER_TURN_GAP = 500; // minimum interval after releasing an opening cover
  const ENTRY_AZIMUTH = -55 * PI / 180;
  const ENTRY_ELEVATION = 20 * PI / 180;
  const ENTRY_DISTANCE = 1.3;
  const ENTRY_HOVER_TURN = 7 * PI / 180;
  const VIEW_DURATION = 2000;
  const M = 0; // covers are trimmed to the same width and height as the paper
  const GUTTER = 0.32; // angle at which a page climbs out of the gutter
  const SG = 0.15; // arc length of that climb
  const HOVER_STRENGTH = 0.3; // fraction of the original hover preview
  const isBoard = (i: number) => i === 0 || i === LEAVES - 1;

  // PDF faces are pre-rendered at their original aspect ratio. Only a small
  // neighbourhood is decoded/uploaded to the GPU; never load the 388 MB PDF here.
  const blank = document.createElement('canvas');
  blank.width = blank.height = 4;
  const blankContext = blank.getContext('2d')!;
  blankContext.fillStyle = '#ffffff';
  blankContext.fillRect(0, 0, 4, 4);
  const textures = manifest.faces.map(() => {
    const texture = new T.Texture(blank);
    texture.colorSpace = T.NoColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  });
  const spineTexture = manifest.spine ? new T.Texture(blank) : null;
  if (spineTexture) {
    spineTexture.colorSpace = T.NoColorSpace;
    spineTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    spineTexture.needsUpdate = true;
  }
  const loadSpine = async () => {
    if (!spineTexture || !manifest.spine) return;
    const image = new Image();
    image.decoding = 'async'; image.src = manifest.spine.src;
    await image.decode();
    if (disposed) return;
    spineTexture.dispose(); spineTexture.image = image; spineTexture.needsUpdate = true;
    dirty = true;
  };
  const resident = new Set<number>();
  const pending = new Map<string, Promise<void>>();
  const loadedSources = new Map<number, string>();
  let desiredSources = new Map<number, string>();
  let wanted = new Set<number>();
  let disposed = false;
  const loadFace = (index: number): Promise<void> => {
    if (index < 0 || index >= textures.length) return Promise.resolve();
    const source = desiredSources.get(index)!;
    if (resident.has(index) && loadedSources.get(index) === source) return Promise.resolve();
    const key = `${index}:${source}`;
    if (pending.has(key)) return pending.get(key)!;
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    const promise = image.decode().then(() => {
      if (disposed || !wanted.has(index) || desiredSources.get(index) !== source) return;
      const texture = textures[index];
      texture.dispose();
      texture.image = image;
      texture.needsUpdate = true;
      resident.add(index);
      loadedSources.set(index, source);
      dirty = true;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
  const loadOpening = async (opening: number) => {
    const center = opening * 2;
    const indices = new Set([0, 1, textures.length - 2, textures.length - 1]);
    const fullResolution = new Set([center - 1, center]);
    for (let i = Math.max(0, center - 4); i <= Math.min(textures.length - 1, center + 5); i++) indices.add(i);
    // A moving sheet must keep both of its faces, even during a quick jump.
    for (const leaf of leaves) if (leaf.dragging || leaf.t !== leaf.target || (leaf.t > 0 && leaf.t < 1)) {
      // Both sides of the turning sheet and the resting pages revealed below it.
      for (const index of [leaf.i * 2 - 1, leaf.i * 2, leaf.i * 2 + 1, leaf.i * 2 + 2]) {
        if (index >= 0 && index < textures.length) {
          indices.add(index); fullResolution.add(index);
        }
      }
    }
    wanted = indices;
    // High-resolution images use four times the GPU memory. Nearby off-screen
    // faces keep their existing previews; visible and turning faces use originals.
    desiredSources = new Map([...indices].map(index => [index,
      fullResolution.has(index) ? manifest.faces[index].src : manifest.faces[index].previewSrc ?? manifest.faces[index].src]));
    for (const index of resident) if (!wanted.has(index)) {
      const texture = textures[index];
      texture.dispose();
      texture.image = blank;
      texture.needsUpdate = true;
      resident.delete(index);
      loadedSources.delete(index);
    }
    await Promise.all([...indices].map(loadFace));
  };
  const warmOpening = (opening: number) => {
    loadOpening(opening).catch(error => {
      if (!disposed) root.dispatchEvent(new CustomEvent('book-asset-error', { detail: error }));
    });
  };
  const hexRgb = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  // ---------------------------------------------------------------- shaders
  // A row of the sheet is three joined arcs from the spine: the climb out of the gutter, the body (curvature
  // k1), the tail (k1 + k2). Every angle stays between the two resting stacks, so a page never dives through.
  const BEND = `
    uniform float uW, uH, uAR, uAL, uSG;
    vec2 arcP(float a, float k, float L) {
      if (abs(k) < 1e-4) return vec2(cos(a), sin(a)) * L;
      return vec2(sin(a + k * L) - sin(a), cos(a) - cos(a + k * L)) / k;
    }
    vec3 bendRow(float s, float yn, float A, float K, float K2, float G, float gut, out vec3 n) {
      float a = clamp(A + G * yn * sin(A), uAR, uAL);
      float a0 = clamp(a + gut, uAR, uAL);
      float s0 = uW * 0.5;
      float kg = (a - a0) / uSG;
      float k1 = clamp(K * (1.0 + 0.45 * G * yn), (uAR - a) / (s0 - uSG), (uAL - a) / (s0 - uSG));
      float a1 = a + k1 * (s0 - uSG);
      float k2 = clamp(k1 + K2, (uAR - a1) / (uW - s0), (uAL - a1) / (uW - s0));
      vec2 q; float phi;
      if (s <= uSG) { q = arcP(a0, kg, s); phi = a0 + kg * s; }
      else if (s <= s0) { q = arcP(a0, kg, uSG) + arcP(a, k1, s - uSG); phi = a + k1 * (s - uSG); }
      else { q = arcP(a0, kg, uSG) + arcP(a, k1, s0 - uSG) + arcP(a1, k2, s - s0); phi = a1 + k2 * (s - s0); }
      n = vec3(-sin(phi), 0.0, cos(phi));
      return vec3(q.x, 0.0, q.y);
    }
  `;
  const VERT = `
    ${BEND}
    uniform float uA, uK, uK2, uG, uGut;
    uniform vec3 uOffC, uOffP, uBinding;
    varying vec2 vUv; varying vec3 vN; varying vec3 vL; varying vec3 vW; varying float vS;
    void main() {
      vUv = uv;
      vec3 n;
      vec3 p = bendRow(position.x, position.y / (uH * 0.5), uA, uK, uK2, uG, uGut, n);
      p.y = position.y;
      // Every sheet meets the same binding line. Independent stack heights at
      // s=0 otherwise leave a subpixel slit into the next printed page.
      vec3 stackOffset = uOffC + uOffP * mix(0.18, 1.0, smoothstep(0.0, 0.22 * uW, position.x));
      float unbound = smoothstep(0.0, 0.055 * uW, position.x);
      p += mix(uBinding, stackOffset, unbound);
      vL = p; vS = position.x;
      vN = normalize(mat3(modelMatrix) * n);
      vec4 w = modelMatrix * vec4(p, 1.0);
      vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `;
  const LIGHT = `
    uniform float uLightIntensity, uShadowStrength, uDiffusion;
    const float PAPER_TEXTURE_OPACITY = 0.24;
    const float GUTTER_SHADOW_OPACITY = 0.5;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float paperNoise(vec2 p) {
      // Fade subpixel grain to its mean instead of letting it sparkle during a turn.
      vec2 footprint = fwidth(p);
      float visibility = 1.0 - smoothstep(0.65, 1.6, max(footprint.x, footprint.y));
      return mix(0.5, vnoise(p), visibility);
    }
    vec2 lightSample(vec3 n, vec3 V, vec3 direction, float exponent) {
      vec3 L = normalize(direction);
      return vec2(max(dot(n, L), 0.0), pow(max(dot(n, normalize(L + V)), 0.0), exponent));
    }
    vec3 shade(vec3 col, vec3 n, vec3 wp, float g, float shine) {
      vec3 V = normalize(cameraPosition - wp);
      // Five samples across a broad luminous panel, with bright ambient fill.
      // This approximates a diffuser without introducing shadow-map noise.
      vec3 key = vec3(-0.42, 0.62, 1.0);
      float radius = uDiffusion * 1.1;
      float exponent = mix(30.0, 9.0, uDiffusion);
      vec2 response = lightSample(n, V, key, exponent) * 0.25;
      response += lightSample(n, V, key + vec3(-radius, -radius, 0.0), exponent) * 0.1875;
      response += lightSample(n, V, key + vec3( radius, -radius, 0.0), exponent) * 0.1875;
      response += lightSample(n, V, key + vec3(-radius,  radius, 0.0), exponent) * 0.1875;
      response += lightSample(n, V, key + vec3( radius,  radius, 0.0), exponent) * 0.1875;
      float ambient = mix(0.66, 0.97, uDiffusion);
      float light = ambient + (1.0 - ambient) * response.x;
      col *= light * (1.0 + (g - 0.5) * 0.07);
      float highlight = response.y * shine * mix(0.14, 0.035, uDiffusion);
      return (col + highlight) * uLightIntensity;
    }
  `;
  const FRAG = `
    ${BEND}
    ${LIGHT}
    uniform sampler2D uFront, uBack;
    uniform float uShine, uAir, uSelf, uCOn, uCA, uCK, uCK2, uCG, uCZ;
    varying vec2 vUv; varying vec3 vN; varying vec3 vL; varying vec3 vW; varying float vS;
    void main() {
      vec3 n = normalize(vN);
      vec2 fuv = vUv, buv = vec2(1.0 - vUv.x, vUv.y);
      vec3 col, thru;
      if (gl_FrontFacing) { col = texture2D(uFront, fuv).rgb; thru = texture2D(uBack, buv).rgb; }
      else { col = texture2D(uBack, buv).rgb; thru = texture2D(uFront, fuv).rgb; n = -n; }
      // the ink on the reverse shows faintly through the sheet, more when it is held up to the light
      float tl = dot(thru, vec3(0.333));
      col *= 1.0 - (1.0 - tl) * (0.005 + 0.025 * uAir);

      float g = paperNoise(vUv * vec2(936.0, 1296.0)) * 0.75 + paperNoise(vUv * vec2(180.0, 246.0)) * 0.25;
      // a sheet in the air ripples faintly: a slow, wide wrinkle across the diagonal
      float wr = sin(dot(vUv, vec2(7.0, 4.0))) * 0.5 + 0.5;
      vec3 smoothNormal = normalize(n + vec3((wr - 0.5) * 0.12 * uAir, 0.0, 0.0));
      vec3 texturedNormal = normalize(n + vec3((g - 0.5) * 0.06 + (wr - 0.5) * 0.12 * uAir, 0.0, 0.0));
      // Blend only the added paper grain at 24% opacity; the printed page stays opaque.
      col = mix(shade(col, smoothNormal, vW, 0.5, uShine),
                shade(col, texturedNormal, vW, g, uShine), PAPER_TEXTURE_OPACITY);
      // the gutter falls into shade where the paper dives toward the spine; the fore-edge darkens a touch
      float gutterWidth = mix(0.2, 0.32, uDiffusion) * uW;
      col *= mix(1.0, mix(0.72, 1.0, smoothstep(0.0, gutterWidth, vS)), GUTTER_SHADOW_OPACITY * uShadowStrength);
      col *= mix(1.0, mix(0.94, 1.0, smoothstep(0.0, mix(0.03, 0.07, uDiffusion), uW - vS)), uShadowStrength);

      // soft shadow from the sheet in the air onto everything beneath it
      if (uCOn > 0.5 && uSelf < 0.5) {
        float yn = vL.y / (uH * 0.5);
        vec3 tn;
        vec3 tip = bendRow(uW, yn, uCA, uCK, uCK2, uCG, 0.0, tn);
        vec3 mid = bendRow(uW * 0.55, yn, uCA, uCK, uCK2, uCG, 0.0, tn);
        float zMax = max(max(tip.z, mid.z) - vL.z + uCZ, 0.0);
        // light comes from the upper left, so the shadow drifts right and down
        float x = vL.x - zMax * 0.24;
        float lo = min(0.0, min(tip.x, mid.x)), hi = max(0.0, max(tip.x, mid.x));
        // Signed distance gives one continuous, feathered edge on either side.
        float d = max(lo - x, x - hi);
        float penumbra = mix(0.012, 0.12, uDiffusion) + zMax * mix(0.15, 1.3, uDiffusion);
        float sh = 0.55 * (1.0 - smoothstep(-penumbra, penumbra, d));
        sh *= clamp(zMax * 6.0, 0.0, 1.0);
        col *= 1.0 - sh * 0.5 * uShadowStrength;
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;
  // Covers use the same bend as paper, with stiffer stock and a thin edge.
  const BOARD_VERT = `
    ${BEND}
    uniform float uA, uK, uK2, uG, uGut;
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main() {
      vUv = uv;
      vec3 n;
      vec3 p = bendRow(position.x, position.y / (uH * 0.5), uA, uK, uK2, uG, uGut, n);
      p.y = position.y;
      p += n * position.z;
      vec3 bentNormal = vec3(n.z, 0.0, -n.x) * normal.x + vec3(0.0, normal.y, 0.0) + n * normal.z;
      // Keep the hinge pivot for stacking; apply only the flexible deviation
      // locally, since its base turn angle is already on the cover group.
      float ca = cos(uA), sa = sin(uA);
      p = vec3(ca * p.x + sa * p.z, p.y, -sa * p.x + ca * p.z);
      n = vec3(ca * bentNormal.x + sa * bentNormal.z, bentNormal.y, -sa * bentNormal.x + ca * bentNormal.z);
      vN = normalize(mat3(modelMatrix) * n);
      vec4 w = modelMatrix * vec4(p, 1.0);
      vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `;
  const BOARD_FRAG = `
    ${LIGHT}
    uniform sampler2D uMap; uniform vec3 uColor; uniform float uUseMap, uShine, uCloth;
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main() {
      vec3 col = uUseMap > 0.5 ? texture2D(uMap, vUv).rgb : uColor;
      float g = paperNoise(vUv * vec2(540.0, 756.0)) * 0.8 + paperNoise(vUv * vec2(120.0, 165.0)) * 0.2;
      col = shade(col, normalize(vN), vW, mix(0.5, g, uCloth * PAPER_TEXTURE_OPACITY), uShine * 0.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `;
  // the page block: a slab whose top follows the gutter, with a fine line for every sheet on its edges
  const BLOCK_VERT = `
    uniform float uThick, uSide, uGutH, uW, uClosed;
    varying vec3 vN; varying vec3 vW; varying float vZ; varying float vTop;
    void main() {
      vec3 p = position;
      float s = p.x;
      float top = step(0.5, p.z);
      // The unprinted block must taper below the shared paper binding, rather
      // than poking through the printed sheets at the gutter.
      // A closed cover hides the paper binding. Fill its full rectangular
      // head/tail edge instead of exposing the open book's tapered gutter.
      float ramp = mix(smoothstep(0.0, 0.22 * uW, s), 1.0, uClosed);
      float climb = uGutH * smoothstep(0.0, 0.3 * uW, s);
      p.z = top * (uThick * ramp + climb * step(0.0001, uThick));
      vZ = p.z / max(uThick, 1e-4);
      vTop = top;
      p.z *= uSide;
      vec3 nn = normal; nn.z *= uSide;
      vN = normalize(mat3(modelMatrix) * nn);
      vec4 w = modelMatrix * vec4(p, 1.0);
      vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `;
  const BLOCK_FRAG = `
    ${LIGHT}
    uniform vec3 uColor; uniform float uThick, uSheets;
    varying vec3 vN; varying vec3 vW; varying float vZ; varying float vTop;
    void main() {
      vec3 n = normalize(vN);
      // Individual sheets become subpixel in an oblique view. Fade to their
      // average before Nyquist instead of drawing broken/moire edge stripes.
      float sheetPhase = vZ * uSheets;
      float lineVisibility = 1.0 - smoothstep(0.25, 0.75, fwidth(sheetPhase));
      float lines = 0.5 + 0.5 * sin(sheetPhase * 6.2831853) * lineVisibility;
      float edgeLines = mix(1.0, 0.86 + 0.1 * lines, step(abs(n.z), 0.6));
      vec3 col = uColor * mix(1.0, edgeLines, mix(1.0, 0.35, uDiffusion));
      col = shade(col, n, vW, 0.5, 0.0);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // ---------------------------------------------------------------- the book
  const book = new T.Group();
  scene.add(book);
  // A real binding face closes the gap between the two coated covers.
  const bindingDepth = PAPER_LEAVES * EPS + 2 * BT;
  const spineGeo = new T.PlaneGeometry(bindingDepth, H);
  spineGeo.rotateY(-PI / 2);
  spineGeo.translate(-.0004, 0, bindingDepth / 2);
  const spineMat = new T.ShaderMaterial({
    uniforms: { ...lightingUniforms, uColor: { value: new T.Color().setRGB(.58, .60, .62) },
      uMap: { value: spineTexture }, uUseMap: { value: spineTexture ? 1 : 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `${LIGHT} uniform vec3 uColor; uniform sampler2D uMap; uniform float uUseMap;
      varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      void main() { vec3 col = uUseMap > .5 ? texture2D(uMap, vUv).rgb : uColor;
        gl_FragColor = vec4(shade(col, normalize(vN), vW, .5, 0.0), 1.0); }`,
    side: T.DoubleSide, extensions: { derivatives: true },
  });
  const bindingFace = new T.Mesh(spineGeo, spineMat);
  bindingFace.userData.bookSurface = true;
  book.add(bindingFace);
  const geo = new T.PlaneGeometry(W, H, 80, 20);
  geo.translate(W / 2, 0, 0);

  type Leaf = {
    i: number;
    mesh: any; // a bent sheet, or the pivot of a board
    u: any;
    coverU?: any;
    paperReadyAt?: number;
    t: number; // 0 = lying right, 1 = lying left
    v: number;
    vs: number; // smoothed velocity: the tail trails by it
    target: number;
    w: number; // spring rate of the current turn
    g: number;
    gTarget: number;
    h: number; // hover lift, signed toward the other side
    hv: number;
    hTarget: number;
    jit: number;
    dragging: boolean;
  };
  const bindingUniform = { value: new T.Vector3(0, 0, BT + EPS * 0.5) };
  const sharedU = () => ({
    ...lightingUniforms,
    uW: { value: W },
    uH: { value: H },
    uAR: { value: 0 },
    uAL: { value: PI },
    uSG: { value: SG },
    uBinding: bindingUniform,
  });
  const leaves: Leaf[] = [];
  const boardMats: any[] = [];
  const edgeMats: any[] = [];
  const boardGeo = new T.BoxGeometry(W + M, H + M * 2, BT, 80, 20, 1);
  boardGeo.translate((W + M) / 2, 0, 0);
  const boardFaceGeo = new T.PlaneGeometry(W + M, H + M * 2, 80, 20);
  boardFaceGeo.translate((W + M) / 2, 0, 0);
  const boardInsideGeo = boardFaceGeo.clone();
  boardInsideGeo.rotateY(PI);
  boardInsideGeo.translate(W + M, 0, -BT / 2);
  boardFaceGeo.translate(0, 0, BT / 2);
  const boardMat = (map: any, coverU: any) => {
    const m = new T.ShaderMaterial({
      uniforms: { ...coverU, uMap: { value: map }, uColor: { value: new T.Color() }, uUseMap: { value: map ? 1 : 0 }, uShine: { value: props.shine }, uCloth: { value: 1 } },
      vertexShader: BOARD_VERT,
      fragmentShader: BOARD_FRAG,
      extensions: { derivatives: true },
    });
    boardMats.push(m);
    return m;
  };
  const hidden = new T.MeshBasicMaterial({ visible: false });
  for (let i = 0; i < LEAVES; i++) {
    if (isBoard(i)) {
      const coverU = {
        ...sharedU(), uA: { value: 0 }, uK: { value: 0 }, uK2: { value: 0 },
        uG: { value: 0 }, uGut: { value: 0 },
      };
      const pivot = new T.Group();
      const edgeMat = boardMat(null, coverU);
      edgeMats.push(edgeMat);
      const box = new T.Mesh(boardGeo, [edgeMat, edgeMat, edgeMat, edgeMat, hidden, hidden]);
      const out = new T.Mesh(boardFaceGeo, boardMat(textures[i * 2], coverU));
      const ins = new T.Mesh(boardInsideGeo, boardMat(textures[i * 2 + 1], coverU));
      pivot.add(box, out, ins);
      book.add(pivot);
      leaves.push({ i, mesh: pivot, u: null, coverU, t: 0, v: 0, vs: 0, target: 0, w: 6.5, g: 0, gTarget: 0, h: 0, hv: 0, hTarget: 0, jit: 1, dragging: false });
      continue;
    }
    const u = {
      ...sharedU(),
      uA: { value: 0 },
      uK: { value: 0 },
      uK2: { value: 0 },
      uG: { value: 0 },
      uGut: { value: GUTTER },
      uOffC: { value: new T.Vector3() },
      uOffP: { value: new T.Vector3() },
      uFront: { value: textures[i * 2] },
      uBack: { value: textures[i * 2 + 1] },
      uShine: { value: props.shine },
      uAir: { value: 0 },
      uSelf: { value: 0 },
      uCOn: { value: 0 },
      uCA: { value: 0 },
      uCK: { value: 0 },
      uCK2: { value: 0 },
      uCG: { value: 0 },
      uCZ: { value: 0 },
    };
    const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, side: T.DoubleSide, extensions: { derivatives: true } });
    const mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false; // The vertex shader bends beyond the unmodified geometry bounds.
    book.add(mesh);
    leaves.push({ i, mesh, u, t: 0, v: 0, vs: 0, target: 0, w: 6.5, g: 0, gTarget: 0, h: 0, hv: 0, hTarget: 0, jit: 1, dragging: false });
  }

  // page blocks under the top sheet of each side
  const blockGeo = new T.BoxGeometry(W - 0.006, H - 0.008, 1, 40, 1, 1);
  blockGeo.translate((W - 0.006) / 2, 0, 0.5);
  const blockU = (side: number) => ({
    ...lightingUniforms,
    uW: { value: W },
    uThick: { value: 0 },
    uSide: { value: side },
    uGutH: { value: 0 },
    uClosed: { value: 0 },
    uSheets: { value: 1 },
    uColor: { value: new T.Color() },
    uShine: { value: 0 },
  });
  // The printed sheets supply the horizontal surfaces. Drawing slab caps too
  // creates coplanar faces on the inner cover during rapid consecutive turns.
  const blockMaterial = (side: number) => new T.ShaderMaterial({
    uniforms: blockU(side), vertexShader: BLOCK_VERT, fragmentShader: BLOCK_FRAG,
    side: side > 0 ? T.FrontSide : T.BackSide, extensions: { derivatives: true },
  });
  const blockRMat = blockMaterial(1), blockLMat = blockMaterial(-1);
  const blockR = new T.Mesh(blockGeo, [blockRMat, blockRMat, blockRMat, blockRMat, hidden, hidden]);
  const blockL = new T.Mesh(blockGeo, [blockLMat, blockLMat, blockLMat, blockLMat, hidden, hidden]);
  const pivR = new T.Group();
  const pivL = new T.Group();
  pivR.add(blockR);
  pivL.add(blockL);
  book.add(pivR, pivL);

  // contact shadow under the book
  const shCv = document.createElement('canvas');
  shCv.width = shCv.height = 256;
  const shc = shCv.getContext('2d')!;
  const grd = shc.createRadialGradient(128, 128, 8, 128, 128, 128);
  grd.addColorStop(0, 'rgba(0,0,0,0.38)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.16)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  shc.fillStyle = grd;
  shc.fillRect(0, 0, 256, 256);
  const shadowTex = new T.CanvasTexture(shCv);
  const shadow = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  scene.add(shadow);

  // A compact, sharper footprint attaches the boards to the ground. The wider
  // radial layer remains behind it, so contact definition need not darken the pages.
  const contactCv = document.createElement('canvas');
  contactCv.width = contactCv.height = 512;
  const contactContext = contactCv.getContext('2d')!;
  contactContext.fillStyle = 'rgba(0,0,0,0.58)';
  contactContext.shadowColor = 'rgba(0,0,0,0.58)';
  contactContext.shadowBlur = 6;
  contactContext.shadowOffsetX = 3;
  contactContext.shadowOffsetY = 3;
  contactContext.fillRect(32, 32, 448, 448);
  const contactTex = new T.CanvasTexture(contactCv);
  const contactShadow = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false }));
  scene.add(contactShadow);

  const recolour = (backgroundTransitionMs = 0) => {
    const c = (h: string) => new T.Color().setRGB(...(hexRgb(h).map((v) => v / 255) as [number, number, number]));
    backgroundTarget.copy(c(props.background));
    if (!reduced && backgroundTransitionMs > 0 && !backgroundColor.equals(backgroundTarget)) {
      backgroundFrom.copy(backgroundColor);
      backgroundStarted = performance.now();
      backgroundDuration = backgroundTransitionMs;
    } else {
      backgroundDuration = 0;
      backgroundColor.copy(backgroundTarget);
    }
    for (const edge of edgeMats) {
      edge.uniforms.uColor.value.copy(c(props.ink)).multiplyScalar(0.8);
      edge.uniforms.uCloth.value = 0;
    }
    const blockCol = c(props.paper).multiplyScalar(0.9 + 0.09 * props.diffusion);
    blockRMat.uniforms.uColor.value.copy(blockCol);
    blockLMat.uniforms.uColor.value.copy(blockCol);
    root.style.setProperty('--ml-paper', props.paper);
    root.style.setProperty('--ml-ink', props.ink);
    root.style.setProperty('--ml-accent', props.accent);
    root.style.setProperty('--ml-background', props.background);
    lightingUniforms.uLightIntensity.value = props.lightIntensity;
    lightingUniforms.uShadowStrength.value = props.shadowStrength;
    lightingUniforms.uDiffusion.value = props.diffusion;
    shadow.material.opacity = props.shadowStrength * (1 - 0.35 * props.diffusion);
    contactShadow.material.opacity = props.shadowStrength * (0.9 - 0.18 * props.diffusion);
  };

  // ---------------------------------------------------------------- turning
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  // A page's own curve: the edge leads on the way up and trails on the way down.
  const curlFor = (t: number) => (props.curl * 1.7 * Math.sin(PI * t) * (1 - 1.45 * t)) / W;
  let spine = 0; // how far each half is raised off the table: 0 lies flat, more makes a V
  let spineTarget = 0;
  let spineV = 0;

  const turned = () => leaves.filter((l) => l.target >= 1).length;
  let previousOpening = -1;
  let previousViewState = '';
  const updateCounter = () => {
    const k = turned();
    const left = k > 0 ? k * 2 - 1 : null;
    const right = k < LEAVES ? k * 2 : null;
    // The white inside front cover is page 0; the first right-hand page is 1.
    const pageNumbers = k === 1 ? '1' : `${k * 2 - 2}–${k * 2 - 1}`;
    const label = k === 0 ? (coverView === 'overview' ? 'Angled view' : 'Front cover') : k === LEAVES ? 'Back cover' : `${pageNumbers} / ${manifest.faces.length - 2}`;
    const cover = k === 0 || k === LEAVES;
    pageCounter?.update({ opening: k, text: cover ? label : pageNumbers, cover, label });
    if (prevBtn) prevBtn.disabled = !!viewTransition || (k === 0 && coverView === 'overview');
    if (nextBtn) nextBtn.disabled = !!viewTransition || k === LEAVES;
    root.dataset.opening = String(k);
    root.dataset.coverView = coverView;
    root.dataset.viewTransition = String(!!viewTransition);
    canvas.style.cursor = viewTransition ? 'default' : coverView === 'overview' ? 'pointer' : 'grab';
    canvas.setAttribute('aria-label', coverView === 'overview' ? '표지와 책등을 비스듬히 보는 화면. 클릭하거나 오른쪽 방향키를 누르면 2초 동안 카메라가 정면 관람 위치로 이동합니다.' : '책 모서리를 잡아 넘기세요. 표지에서 왼쪽 방향키를 누르면 첫 사선 구도로 돌아갑니다. 핀치 또는 세로 스크롤로 책 크기를 조절할 수 있습니다.');
    const viewState = `${coverView}:${!!viewTransition}`;
    if (k !== previousOpening || viewState !== previousViewState) {
      if (k !== previousOpening) warmOpening(k);
      previousOpening = k;
      previousViewState = viewState;
      onChange?.({ opening: k, total: LEAVES, left, right, label, transitioning: !!viewTransition, view: coverView });
    }
  };
  const clearHover = () => leaves.forEach((l) => (l.hTarget = 0));
  let pendingTurn: { dir: 1 | -1; gamma: number } | null = null;
  const isLayerMoving = (l: Leaf) => l.dragging || l.t !== l.target || l.h !== 0 || Math.abs(l.vs) > 0.002;
  const coverClearsPaper = (cover: Leaf) => !cover.dragging &&
    (cover.i === 0 ? cover.target === 1 && cover.t + cover.h >= 0.5 :
      cover.i === LEAVES - 1 && cover.target === 0 && cover.t + cover.h <= 0.5);
  // Give the cover and first sheet a short, predictable interval, without
  // waiting for the entire spring tail. Closing still waits for paper below.
  const hasCoverConflict = (leaf: Leaf) => leaves.some(other => other !== leaf && (
    (!isBoard(leaf.i) && isBoard(other.i) && performance.now() < (other.paperReadyAt ?? 0)) ||
    (isLayerMoving(other) && (isBoard(leaf.i) || isBoard(other.i)) &&
      !(!isBoard(leaf.i) && isBoard(other.i) && coverClearsPaper(other)))));
  const clearOpeningCovers = (leaf: Leaf) => {
    if (isBoard(leaf.i)) return;
    for (const cover of leaves) if (isBoard(cover.i) && isLayerMoving(cover) && coverClearsPaper(cover)) {
      // Finish smoothly ahead of even a fast paper drag, rather than snapping
      // the cover flat or waiting for tiny residual velocities to decay.
      cover.t = Math.max(0, Math.min(1, cover.t + cover.h));
      cover.h = cover.hv = cover.hTarget = 0;
      cover.w = Math.max(28, 28 * props.speed);
    }
  };

  const launch = (l: Leaf, target: number, rate: number, gamma: number) => {
    clearOpeningCovers(l);
    if (isBoard(l.i)) {
      const opening = l.i === 0 ? target === 1 : target === 0;
      l.paperReadyAt = opening ? performance.now() + COVER_TURN_GAP : 0;
    }
    l.target = target;
    l.w = rate;
    l.gTarget = props.cone * gamma;
    l.jit = rand(0.85, 1.2);
    if (l.h) {
      l.t = Math.max(0, Math.min(1, l.t + l.h));
      l.h = 0;
      l.hv = 0;
    }
    l.hTarget = 0;
    if (reduced) (l.t = target), (l.v = 0);
  };
  const nextLeaf = (dir: 1 | -1, paperOnly = false) => {
    if (dir > 0) return leaves.find((l) => l.target < 1 && !l.dragging && !(paperOnly && isBoard(l.i)));
    const c = leaves.filter((l) => l.target >= 1 && !l.dragging && !(paperOnly && isBoard(l.i)));
    return c[c.length - 1];
  };
  const showCoverView = (target: CoverView) => {
    if (viewTransition || turned() !== 0 || leaves.some(l => l.dragging || l.t !== l.target) || coverView === target) return;
    clearHover(); pendingTurn = null;
    for (const leaf of leaves) { leaf.h = leaf.hv = leaf.hTarget = leaf.g = leaf.gTarget = leaf.vs = 0; }
    coverView = target;
    overviewHoverTarget = overviewHoverVelocity = 0;
    viewTransition = { from: viewAmount, to: target === 'overview' ? 1 : 0,
      fromHover: overviewHover, started: performance.now() };
    updateCounter();
    dirty = true;
  };
  const turn = (dir: 1 | -1, gamma = 0.18) => {
    if (press || drag || viewTransition) return;
    if (coverView === 'overview') { if (dir > 0) showCoverView('front'); return; }
    if (dir < 0 && turned() === 0) { showCoverView('overview'); return; }
    const l = nextLeaf(dir);
    if (!l) return;
    clearHover();
    if (hasCoverConflict(l)) {
      pendingTurn = { dir, gamma };
      dirty = true;
      return;
    }
    pendingTurn = null;
    launch(l, dir > 0 ? 1 : 0, 6.5 * props.speed, gamma);
    updateCounter();
    dirty = true;
  };
  const openAt = (k: number) => {
    pendingTurn = null;
    k = Math.max(0, Math.min(LEAVES, Math.round(k)));
    leaves.forEach((l, i) => {
      l.t = l.target = i < k ? 1 : 0;
      l.v = l.vs = l.h = l.hv = l.hTarget = 0;
      l.g = l.gTarget = 0;
      l.paperReadyAt = 0;
    });
    updateCounter();
    dirty = true;
  };

  // ---------------------------------------------------------------- pointer
  const ray = new T.Raycaster();
  const plane = new T.Plane(new T.Vector3(0, 0, 1), 0);
  const hit = new T.Vector3();
  const overviewBounds = new T.Box3(new T.Vector3(-.001, -H / 2 - M, 0),
    new T.Vector3(W + M, H / 2 + M, bindingDepth));
  const overviewRay = new T.Ray();
  const inverseBook = new T.Matrix4();
  const overviewCorner = new T.Vector3();
  const overviewHoverAt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
    // Hit-test the resting view so the moving silhouette cannot oscillate
    // under a pointer resting near an edge. Test only the closed book itself.
    ray.setFromCamera(new T.Vector2(pointerX,
      -((e.clientY - r.top) / r.height) * 2 + 1), overviewHitCamera);
    book.updateMatrixWorld(true);
    overviewRay.copy(ray.ray).applyMatrix4(inverseBook.copy(book.matrixWorld).invert());
    if (!overviewRay.intersectsBox(overviewBounds)) return 0;
    // Measure screen-left/right against the same resting silhouette. Left
    // reveals more cover; right reveals more binding, with no jump at center.
    let left = Infinity, right = -Infinity;
    for (const x of [overviewBounds.min.x, overviewBounds.max.x])
      for (const y of [overviewBounds.min.y, overviewBounds.max.y])
        for (const z of [overviewBounds.min.z, overviewBounds.max.z]) {
          overviewCorner.set(x, y, z).applyMatrix4(book.matrixWorld).project(overviewHitCamera);
          left = Math.min(left, overviewCorner.x); right = Math.max(right, overviewCorner.x);
        }
    return Math.max(-1, Math.min(1, (left + right - 2 * pointerX) / (right - left)));
  };
  // the pointer in the book's own frame
  const toBook = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    book.updateMatrixWorld(true);
    plane.setComponents(0, 0, 1, 0).applyMatrix4(book.matrixWorld);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    book.worldToLocal(hit);
    return { x: hit.x, y: hit.y };
  };
  const tFromX = (x: number) => Math.acos(Math.max(-1, Math.min(1, x / W))) / PI;
  const onBook = (p: { x: number; y: number } | null) => !!p && Math.abs(p.y) < H / 2 + M + 0.03 && Math.abs(p.x) < W + M + 0.03;

  type Press = { leaf: Leaf | undefined; side: 1 | -1; x0: number; y0: number; px0: number; y: number; at: number; timer: number; id: number; viewOnly?: boolean; moved?: boolean };
  let press: Press | null = null;
  let drag: { leaf: Leaf; px0: number; t0: number; lastX: number; lastT: number; vx: number } | null = null;
  let userTouched = false;

  const topOf = (side: 1 | -1) => nextLeaf(side > 0 ? 1 : -1);
  const split = () => 0;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || press || drag || !e.isPrimary || viewTransition) return;
    if (coverView === 'overview') {
      if (e.pointerType === 'touch') overviewHoverTarget = 0;
      e.preventDefault(); canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId);
      press = { leaf: undefined, side: 1, x0: e.clientX, y0: e.clientY, px0: 0, y: 0,
        at: performance.now(), timer: 0, id: e.pointerId, viewOnly: true };
      return;
    }
    const p = toBook(e);
    if (!onBook(p)) return;
    userTouched = true;
    let side: 1 | -1 = p!.x >= split() ? 1 : -1;
    // a shut book only turns one way, wherever it is pressed
    if (!topOf(side)) side = side > 0 ? -1 : 1;
    const leaf = topOf(side);
    if (!leaf) return;
    clearHover();
    if (hasCoverConflict(leaf)) { dirty = true; return; }
    clearOpeningCovers(leaf);
    pendingTurn = null;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    press = { leaf, side, x0: e.clientX, y0: e.clientY, px0: p!.x, y: p!.y, at: performance.now(), timer: 0, id: e.pointerId };
  };
  const beginDrag = (p: { x: number; y: number }) => {
    if (!press || !press.leaf) return;
    const l = press.leaf;
    clearTimeout(press.timer);
    const t0 = Math.max(0, Math.min(1, l.t + l.h));
    l.t = l.target = t0;
    l.h = l.hv = l.hTarget = 0;
    l.dragging = true;
    l.w = 22;
    // On the left, decreasing the row angle lifts the grabbed corner.
    // Keep that origin-side sign for the full drag and its release.
    l.gTarget = press.side * props.cone * 0.9 * Math.max(-1, Math.min(1, press.y / (H / 2)));
    drag = { leaf: l, px0: press.px0, t0, lastX: p.x, lastT: performance.now(), vx: 0 };
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent) => {
    if (press && e.pointerId !== press.id) return;
    if (press?.viewOnly) { press.moved ||= Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > 8; return; }
    if (viewTransition) return;
    if (coverView === 'overview') {
      overviewHoverTarget = !reduced && e.pointerType === 'mouse' && !e.buttons ? overviewHoverAt(e) : 0;
      dirty = true;
      return;
    }
    const p = toBook(e);
    if (press && !drag && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > 6 && p) beginDrag(p);
    if (drag) {
      if (!p) return;
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT);
      drag.vx = drag.vx * 0.6 + ((p.x - drag.lastX) / dt) * 1000 * 0.4;
      drag.lastX = p.x;
      drag.lastT = now;
      drag.leaf.target = Math.max(0, Math.min(1, drag.t0 + tFromX(p.x) - tFromX(drag.px0)));
      dirty = true;
      return;
    }
    if (press || reduced || e.pointerType === 'touch') return;
    // hover: the top sheet under the pointer lifts toward you, more the nearer you are to its outer edge
    clearHover();
    if (onBook(p)) {
      userTouched = true;
      const side: 1 | -1 = p!.x >= split() ? 1 : -1;
      const l = topOf(side);
      if (l && !pendingTurn && !hasCoverConflict(l)) {
        const f = Math.min(1, Math.abs(p!.x) / W);
        const yn = Math.max(-1, Math.min(1, p!.y / (H / 2)));
        const corner = Math.max(0, Math.abs(yn) - 0.55) / 0.45;
        const lift = (isBoard(l.i) ? 0.025 : 0.02) + (isBoard(l.i) ? 0.04 : 0.1) * Math.pow(f, 2.4) * (1 + 0.6 * corner);
        l.hTarget = (side > 0 ? lift : -lift) * HOVER_STRENGTH;
        l.gTarget = side * props.cone * 1.5 * yn * f * (isBoard(l.i) ? 0.2 : 1) * HOVER_STRENGTH;
      }
    }
    dirty = true;
  };
  const onUp = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    const cancelled = e.type === 'pointercancel' || e.type === 'lostpointercapture';
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
    canvas.style.cursor = 'grab';
    const pr = press;
    press = null;
    if (pr) clearTimeout(pr.timer);
    if (pr.viewOnly) {
      if (!cancelled && !pr.moved) showCoverView('front');
      else {
        overviewHoverTarget = !cancelled && !reduced && e.pointerType === 'mouse' ? overviewHoverAt(e) : 0;
        canvas.style.cursor = 'pointer'; dirty = true;
      }
      return;
    }
    if (drag) {
      const d = drag;
      drag = null;
      d.leaf.dragging = false;
      // A pause cancels the earlier fling velocity. A held half-turn stays held.
      const velocity = performance.now() - d.lastT < 120 ? d.vx : 0;
      const fling = cancelled ? (pr?.side === 1 ? 0 : 1) : velocity < -0.8 ? 1 : velocity > 0.8 ? 0 : d.leaf.target > 0.5 ? 1 : 0;
      launch(d.leaf, fling, 6.5 * props.speed, d.leaf.gTarget / Math.max(props.cone, 0.001) * 0.6);
      d.leaf.w = 7.5 * props.speed;
      updateCounter();
      dirty = true;
      return;
    }
    if (pr && !cancelled) {
      turn(pr.side > 0 ? 1 : -1, 0.7 * pr.side * Math.max(-1, Math.min(1, pr.y / (H / 2))));
    }
  };
  const onLeave = () => {
    overviewHoverTarget = 0;
    if (!press) clearHover();
    dirty = true;
  };
  const cancelPageTurn = () => {
    overviewHoverTarget = 0;
    if (press) onUp(new PointerEvent('pointercancel', { pointerId: press.id }));
    clearHover();
  };
  const onBlur = () => {
    cancelPageTurn();
    zoomInput.reset();
    zoomTarget = zoom;
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      userTouched = true;
      turn(e.key === 'ArrowRight' ? 1 : -1);
      e.preventDefault();
    }
    if ((e.key === 'Enter' || e.key === ' ') && coverView === 'overview') {
      showCoverView('front'); e.preventDefault();
    }
  };
  const onPrev = () => {
    userTouched = true;
    turn(-1);
  };
  const onNext = () => {
    userTouched = true;
    turn(1);
  };
  const noMenu = (e: Event) => e.preventDefault();
  root.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  prevBtn?.addEventListener('click', onPrev);
  nextBtn?.addEventListener('click', onNext);

  // ---------------------------------------------------------------- layout
  const CAMERA_TILT = 0.06;
  const anchorZ = PAPER_LEAVES * EPS / 2 + BT;
  let zoom = ZOOM_DEFAULT;
  let zoomTarget = zoom;
  let renderWidth = 0, renderHeight = 0;
  let readingDistance = 1;
  const applyCameraView = () => {
    // An arc around the visual center avoids the unwanted push-in that a
    // straight position lerp would produce. Entry hover and explicit entry/
    // return transitions change this pose; page geometry never does.
    const azimuth = (ENTRY_AZIMUTH + ENTRY_HOVER_TURN * overviewHover) * viewAmount;
    const elevation = -CAMERA_TILT + (ENTRY_ELEVATION + CAMERA_TILT) * viewAmount;
    camera.fov = READING_FOV + (ENTRY_FOV - READING_FOV) * viewAmount;
    // A wider entry lens needs a proportionally closer camera to retain the
    // framing. The reading endpoint is exactly the original 5-degree camera.
    const lensScale = Math.tan(READING_FOV * PI / 360) / Math.tan(camera.fov * PI / 360);
    const distance = readingDistance * (1 + (ENTRY_DISTANCE - 1) * viewAmount) * lensScale;
    const horizontal = Math.cos(elevation) * distance;
    camera.position.set(Math.sin(azimuth) * horizontal, Math.sin(elevation) * distance,
      anchorZ + Math.cos(azimuth) * horizontal);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, anchorZ);
    // Entry contains only the closed book. Tight depth planes keep adjacent
    // sheets/boards precise even though the wide lens brings the camera near.
    const closedRadius = Math.hypot(W / 2, H / 2, bindingDepth / 2) + .1;
    const depthRadius = (2 * W + H + 1) * (1 - viewAmount) + closedRadius * viewAmount;
    camera.near = Math.max(.05, distance - depthRadius);
    camera.far = distance + depthRadius;
    camera.updateProjectionMatrix();
    overviewHitCamera.copy(camera);
    const restingAzimuth = ENTRY_AZIMUTH * viewAmount;
    overviewHitCamera.position.set(Math.sin(restingAzimuth) * horizontal, Math.sin(elevation) * distance,
      anchorZ + Math.cos(restingAzimuth) * horizontal);
    overviewHitCamera.lookAt(0, 0, anchorZ);
    overviewHitCamera.updateMatrixWorld(true);
  };
  const resize = () => {
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
    if (w !== renderWidth || h !== renderHeight) {
      renderer.setSize(w, h, false);
      renderWidth = w; renderHeight = h;
    }
    camera.aspect = w / h;
    // Shared maximum for a flat book, upright pages, corner pulls, and covers.
    // All page tangents stay in [0, PI], so a raised sheet cannot exceed its
    // own width in height. Include the stack and cover/hinge clearance.
    const tilt = CAMERA_TILT;
    const frame = fitBookFrame({ width: renderWidth, height: renderHeight, fov: READING_FOV,
      tilt, zoom, anchorZ, halfWidth: W + M + .04, halfHeight: H / 2 + M + .003,
      minZ: -2 * BT, maxZ: W + PAPER_LEAVES * EPS + 2 * BT + .006 });
    readingDistance = frame.distance;
    applyCameraView();
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  const zoomInput = attachZoomInput(canvas, {
    getTarget: () => zoomTarget,
    setTarget: value => { zoomTarget = value; dirty = true; },
    cancelPageTurn,
    isPageDragging: () => !!press || !!drag,
  });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextmenu', noMenu);

  // ---------------------------------------------------------------- loop
  let dirty = true;
  let raf = 0;
  let visible = true;
  let last = performance.now();
  const offR = new T.Vector3();
  const offL = new T.Vector3();
  const posePivot = new T.Vector3();

  const step = (now: number) => {
    raf = requestAnimationFrame(step);
    const elapsed = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!visible) return;

    let moving = false;
    if (viewTransition) {
      const progress = Math.max(0, Math.min(1, (now - viewTransition.started) / VIEW_DURATION));
      // Quintic smootherstep: zero velocity AND acceleration at both ends.
      // https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-5-implementing-improved-perlin-noise
      // Evaluate the nearer endpoint to avoid cancellation/overshoot near 1.
      const t = Math.min(progress, 1 - progress);
      const halfEase = t * t * t * (t * (t * 6 - 15) + 10);
      const ease = progress <= .5 ? halfEase : 1 - halfEase;
      viewAmount = viewTransition.from + (viewTransition.to - viewTransition.from) * ease;
      overviewHover = viewTransition.fromHover * (1 - ease);
      if (progress === 1) { viewAmount = viewTransition.to; overviewHover = 0; viewTransition = null; updateCounter(); }
      applyCameraView();
      moving = true;
    } else if (overviewHover !== overviewHoverTarget || Math.abs(overviewHoverVelocity) > .0001) {
      // Exact critically damped spring: soft starts, continuous reversals,
      // and no bounce. Keep the lens and radius fixed during a hover.
      const omega = 10;
      const offset = overviewHover - overviewHoverTarget;
      const rate = overviewHoverVelocity + omega * offset;
      const decay = Math.exp(-omega * elapsed);
      overviewHover = overviewHoverTarget + (offset + rate * elapsed) * decay;
      overviewHoverVelocity = (overviewHoverVelocity - omega * rate * elapsed) * decay;
      if (Math.abs(overviewHover - overviewHoverTarget) < .0001 && Math.abs(overviewHoverVelocity) < .001)
        { overviewHover = overviewHoverTarget; overviewHoverVelocity = 0; }
      applyCameraView();
      moving = true;
    }
    if (Math.abs(zoomTarget - zoom) > .001) {
      zoom += (zoomTarget - zoom) * (reduced ? 1 : 1 - Math.exp(-elapsed / .09));
      if (Math.abs(zoomTarget - zoom) < .01) zoom = zoomTarget;
      resize();
      onZoomChange?.(zoom);
      moving = true;
    }
    if (backgroundDuration > 0) {
      const progress = Math.max(0, Math.min(1, (now - backgroundStarted) / backgroundDuration));
      // Smoothstep matches the interface's easing and starts a reversal from
      // the colour currently on screen, without resetting the book or pages.
      backgroundColor.lerpColors(backgroundFrom, backgroundTarget, progress * progress * (3 - 2 * progress));
      if (progress === 1) {
        backgroundColor.copy(backgroundTarget);
        backgroundDuration = 0;
      }
      moving = true;
    }
    const steps = Math.max(1, Math.ceil(elapsed / (1 / 120)));
    const dt = elapsed / steps;
    for (let k = 0; k < steps; k++) {
      for (const l of leaves) {
        const w = l.dragging ? 22 : l.w;
        l.v += (w * w * (l.target - l.t) - 2 * w * l.v) * dt;
        l.t += l.v * dt;
        if (l.t < 0) (l.t = 0), (l.v = 0);
        if (l.t > 1) (l.t = 1), (l.v = 0);
        l.vs += (l.v - l.vs) * Math.min(1, dt * 9);
        l.g += (l.gTarget - l.g) * Math.min(1, dt * 7);
        // hover follows the pointer on a slightly bouncy spring
        const hw = 13;
        l.hv += (hw * hw * (l.hTarget - l.h) - 2 * 0.72 * hw * l.hv) * dt;
        l.h += l.hv * dt;
      }
      spineV += (60 * (spineTarget - spine) - 2 * 0.9 * Math.sqrt(60) * spineV) * dt;
      spine += spineV * dt;
    }
    for (const l of leaves) {
      if (!l.dragging && Math.abs(l.target - l.t) < 0.0004 && Math.abs(l.v) < 0.002) {
        l.t = l.target;
        l.v = 0;
        if (l.hTarget === 0 && (l.t === 0 || l.t === 1)) l.gTarget = 0;
      }
      if (Math.abs(l.h - l.hTarget) < 0.0003 && Math.abs(l.hv) < 0.002) (l.h = l.hTarget), (l.hv = 0);
      if (l.t !== l.target || Math.abs(l.g - l.gTarget) > 0.001 || Math.abs(l.vs) > 0.002 || l.h !== l.hTarget) moving = true;
    }
    if (Math.abs(spine - spineTarget) > 0.0005 || Math.abs(spineV) > 0.001) moving = true;
    else spine = spineTarget;

    if (pendingTurn && !press && !drag) {
      const next = nextLeaf(pendingTurn.dir);
      if (!next) pendingTurn = null;
      else if (!hasCoverConflict(next)) {
        const request = pendingTurn;
        pendingTurn = null;
        turn(request.dir, request.gamma);
        moving = true;
      }
    }

    if (!moving && !dirty) return;
    dirty = false;

    // where each sheet sits in the stack: everything still lying beneath it on each side, eased by t so a
    // sheet crossing over hands its thickness from one pile to the other continuously
    const te = leaves.map((l) => Math.max(0, Math.min(1, l.t + l.h)));
    // pages only climb out of a gutter while the book is open; shut, they lie flat under the board
    const open = te[0] * (1 - te[LEAVES - 1]);
    const thick = (i: number) => (isBoard(i) ? BT : EPS);
    const aR = spine;
    const aL = PI - spine;
    const nR = [-Math.sin(aR), 0, Math.cos(aR)];
    const upL = [Math.sin(aL), 0, -Math.cos(aL)];
    // Leave half a sheet of clearance over the inside-cover faces.
    bindingUniform.value.set(0, 0, (BT + EPS * 0.5) * Math.cos(spine));
    let caster: Leaf | null = null;
    let best = 0.02;
    leaves.forEach((l, i) => {
      let rc = 0, rp = 0, lc = 0, lp = 0;
      for (let j = i + 1; j < LEAVES; j++) isBoard(j) ? (rc += (1 - te[j]) * BT) : (rp += (1 - te[j]) * EPS);
      for (let j = 0; j < i; j++) isBoard(j) ? (lc += te[j] * BT) : (lp += te[j] * EPS);
      const t = te[i];
      offR.set(nR[0], nR[1], nR[2]);
      offL.set(upL[0], upL[1], upL[2]);
      const A = aR + (aL - aR) * t;
      const air = Math.sin(PI * t);
      const k = (curlFor(t) * l.jit - l.vs * 0.16 * props.curl) * (l.dragging ? 1.15 : 1);
      if (isBoard(i)) {
        const C = l.coverU;
        C.uA.value = A;
        C.uK.value = (k + l.h * 2.2 * props.curl) * COVER_FLEX;
        C.uK2.value = (-l.vs * 0.5 * props.curl + l.h * 1.2 * props.curl) * COVER_TAIL;
        C.uG.value = l.g * COVER_TWIST;
        C.uAR.value = aR;
        C.uAL.value = aL;
        l.mesh.rotation.y = -A;
        const side = 1 - 2 * t;
        l.mesh.position.set(
          offR.x * (rc + rp) * (1 - t) + offL.x * (lc + lp) * t - Math.sin(A) * (BT / 2) * side,
          0,
          offR.z * (rc + rp) * (1 - t) + offL.z * (lc + lp) * t + Math.cos(A) * (BT / 2) * side,
        );
      } else {
        const U = l.u;
        U.uA.value = A;
        U.uK.value = k + (l.h ? Math.abs(l.h) * 2.2 * props.curl * Math.sign(l.h) : 0);
        U.uK2.value = -l.vs * 0.5 * props.curl + l.h * 1.2 * props.curl;
        U.uG.value = l.g;
        U.uGut.value = GUTTER * open * Math.cos(PI * t) * (1 - air * 0.6);
        U.uOffC.value.set(offR.x * rc * (1 - t) + offL.x * lc * t, 0, offR.z * rc * (1 - t) + offL.z * lc * t);
        U.uOffP.value.set(offR.x * rp * (1 - t) + offL.x * lp * t, 0, offR.z * rp * (1 - t) + offL.z * lp * t);
        U.uAir.value = air;
        U.uAR.value = aR;
        U.uAL.value = aL;
      }
      if (air > best && !isBoard(i)) {
        best = air;
        caster = l;
      }
    });

    // Only the top sheet of each resting pile can be seen; skip drawing the ones beneath it.
    const still = (l: Leaf) => l.t === l.target && (l.t === 0 || l.t === 1) && l.h === 0 && !l.dragging;
    let topRi = -1;
    let topLi = -1;
    for (let i = 0; i < LEAVES; i++) if (still(leaves[i]) && leaves[i].t === 0 && !isBoard(i)) { topRi = i; break; }
    for (let i = LEAVES - 1; i >= 0; i--) if (still(leaves[i]) && leaves[i].t === 1 && !isBoard(i)) { topLi = i; break; }
    leaves.forEach((l, i) => {
      if (isBoard(i)) {
        // A flat printed sheet fully covers its board. Culling the covered
        // board also prevents the gutter's curved paper edge exposing a rim.
        const covered = still(l) && ((i === 0 && l.t === 1 && topLi >= 0) ||
          (i === LEAVES - 1 && l.t === 0 && topRi >= 0));
        l.mesh.visible = !covered;
        return;
      }
      const behindClosedCover = still(l) &&
        ((l.t === 0 && te[0] === 0) || (l.t === 1 && te[LEAVES - 1] === 1));
      l.mesh.visible = !behindClosedCover && (!still(l) || i === topRi || i === topLi);
    });

    // page blocks: the sheets lying under each pile's top sheet
    let rCount = 0, lCount = 0, rBase = 0, lBase = 0;
    leaves.forEach((l, i) => {
      if (isBoard(i)) {
        if (i === LEAVES - 1) rBase += (1 - te[i]) * BT;
        else lBase += te[i] * BT;
      } else if (still(l)) {
        // Airborne sheets must not create a phantom slab on the exposed cover.
        rCount += l.t === 0 ? 1 : 0;
        lCount += l.t === 1 ? 1 : 0;
      }
    });
    const bR = blockRMat.uniforms;
    const bL = blockLMat.uniforms;
    bR.uThick.value = Math.max(0, rCount - 1) * EPS;
    bL.uThick.value = Math.max(0, lCount - 1) * EPS;
    bR.uSheets.value = Math.max(1, rCount - 1);
    bL.uSheets.value = Math.max(1, lCount - 1);
    bR.uGutH.value = bL.uGutH.value = SG * Math.sin(GUTTER) * 0.4 * open;
    bR.uClosed.value = te[0] === 0 ? 1 : 0;
    bL.uClosed.value = te[LEAVES - 1] === 1 ? 1 : 0;
    blockR.visible = rCount > 1.05;
    blockL.visible = lCount > 1.05;
    pivR.rotation.y = -aR;
    pivL.rotation.y = -aL;
    blockR.position.set(0.003, 0, 0);
    blockL.position.set(0.003, 0, 0);
    pivR.position.set(nR[0] * rBase, 0, nR[2] * rBase);
    pivL.position.set(upL[0] * lBase, 0, upL[2] * lBase);

    // The book keeps its reading pose; the entry view moves the camera instead.
    const shutFront = 1 - te[0];
    const shutBack = te[LEAVES - 1];
    const centerShift = (-W / 2) * shutFront + (W / 2) * shutBack;
    book.rotation.set(-spine * .35, 0, 0);
    // Rotate around the book's visual center, rather than its binding hinge.
    posePivot.set(-centerShift, 0, anchorZ).applyEuler(book.rotation);
    book.position.set(-posePivot.x, -posePivot.y, spine * .12 + anchorZ - posePivot.z);
    bindingFace.visible = te[0] === 0 && te[LEAVES - 1] === 0;
    const frontEdge = (W + M) * Math.cos(aR + (aL - aR) * te[0]);
    const backEdge = (W + M) * Math.cos(aR + (aL - aR) * te[LEAVES - 1]);
    book.updateMatrixWorld(true);
    let footprintLeft = Infinity, footprintRight = -Infinity, footprintBottom = Infinity, footprintTop = -Infinity, floorZ = 0;
    for (const x of [Math.min(0, frontEdge, backEdge), Math.max(0, frontEdge, backEdge)])
      for (const y of [-H / 2, H / 2]) for (const z of [0, bindingDepth]) {
        posePivot.set(x, y, z).applyMatrix4(book.matrixWorld);
        footprintLeft = Math.min(footprintLeft, posePivot.x); footprintRight = Math.max(footprintRight, posePivot.x);
        footprintBottom = Math.min(footprintBottom, posePivot.y); footprintTop = Math.max(footprintTop, posePivot.y);
        floorZ = Math.min(floorZ, posePivot.z);
      }
    const footprintWidth = Math.max(0.02, footprintRight - footprintLeft);
    const footprintHeight = Math.max(.02, footprintTop - footprintBottom);
    const footprintCenter = (footprintLeft + footprintRight) * 0.5;
    const footprintY = (footprintBottom + footprintTop) * .5;
    const shadowSpread = 1 + props.diffusion * 0.14;
    shadow.scale.set((footprintWidth + .5) * shadowSpread, (footprintHeight + .45) * shadowSpread, 1);
    shadow.position.set(footprintCenter + .035, footprintY - .045, floorZ - .028);
    contactShadow.scale.set(footprintWidth / .875, footprintHeight / .875, 1);
    contactShadow.position.set(footprintCenter, footprintY, floorZ - .001);

    const c = caster as Leaf | null;
    const all = leaves.filter((l) => l.u).map((l) => l.u);
    for (const U of all) {
      U.uShine.value = props.shine;
      U.uCOn.value = c ? 1 : 0;
      U.uSelf.value = c && U === c.u ? 1 : 0;
      if (c) {
        U.uCA.value = c.u.uA.value;
        U.uCK.value = c.u.uK.value;
        U.uCK2.value = c.u.uK2.value;
        U.uCG.value = c.u.uG.value;
        U.uCZ.value = c.u.uOffC.value.length() + c.u.uOffP.value.length();
      }
    }
    boardMats.forEach((m) => (m.uniforms.uShine.value = props.shine));
    renderer.render(scene, camera);
  };

  const io = new IntersectionObserver((es) => {
    visible = es[0].isIntersecting && !document.hidden;
    if (visible) (dirty = true), (last = performance.now());
  });
  io.observe(root);
  const onVis = () => {
    if (document.hidden) onBlur();
    visible = !document.hidden;
    if (visible) (dirty = true), (last = performance.now());
  };
  document.addEventListener('visibilitychange', onVis);

  recolour();
  openAt(props.spread);
  resize();
  raf = requestAnimationFrame(step);
  const ready = Promise.all([loadOpening(props.spread), loadSpine()]).then(() => { if (!disposed) root.dataset.mlReady = '1'; });
  if (reduced) root.dataset.mlReduced = '1';

  return {
    ready,
    async goTo(opening: number) {
      if (press || drag) return;
      const target = Math.max(0, Math.min(LEAVES, Math.round(opening)));
      await loadOpening(target);
      if (!disposed) {
        viewTransition = null; coverView = 'front'; viewAmount = 0;
        overviewHover = overviewHoverTarget = overviewHoverVelocity = 0;
        applyCameraView(); openAt(target);
      }
    },
    turn,
    setZoom(value: number) {
      zoomTarget = zoom = Number.isFinite(value) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value)) : ZOOM_DEFAULT;
      resize();
      onZoomChange?.(zoom);
      return zoom;
    },
    getState() {
      return { opening: turned(), total: LEAVES, dragging: !!drag, zoom, view: coverView, viewAmount, overviewHover, transitioning: !!viewTransition,
        leaves: leaves.filter(l => l.dragging || (l.t > 0 && l.t < 1)).map(l => ({ index: l.i, progress: l.t, target: l.target, curve: l.u?.uK.value ?? l.coverU?.uK.value ?? 0 })),
        residentFaces: resident.size };
    },
    update(next: Props, backgroundTransitionMs = 0) {
      const reopen = next.spread !== props.spread;
      props = next;
      recolour(backgroundTransitionMs);
      if (reopen) {
        viewTransition = null; coverView = 'front'; viewAmount = 0;
        overviewHover = overviewHoverTarget = overviewHoverVelocity = 0;
        applyCameraView(); openAt(props.spread);
      }
      dirty = true;
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      if (press) clearTimeout(press.timer);
      io.disconnect();
      ro.disconnect();
      zoomInput.destroy();
      pageCounter?.destroy();
      window.removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', resize);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('lostpointercapture', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', noMenu);
      root.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      prevBtn?.removeEventListener('click', onPrev);
      nextBtn?.removeEventListener('click', onNext);
      textures.forEach((t) => t.dispose());
      spineTexture?.dispose();
      shadowTex.dispose();
      contactTex.dispose();
      shadow.geometry.dispose();
      contactShadow.geometry.dispose();
      geo.dispose();
      boardGeo.dispose();
      boardFaceGeo.dispose();
      boardInsideGeo.dispose();
      blockGeo.dispose();
      spineGeo.dispose();
      scene.traverse((o: any) => {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose());
      });
      renderer.dispose();
      canvas.remove();
    },
  };
}
