export const ZOOM_MIN = 60;
export const ZOOM_MAX = 100;
export const ZOOM_DEFAULT = 95;

type FrameOptions = {
  width: number; height: number; fov: number; tilt: number; zoom: number; anchorZ: number;
  halfWidth: number; halfHeight: number; minZ: number; maxZ: number;
};

// Fit one fixed envelope that contains the complete page/cover motion.
// Recompute only for viewport or user zoom changes, never for a page's pose.
export function fitBookFrame(o: FrameOptions) {
  const width = Math.max(1, o.width), height = Math.max(1, o.height);
  const margin = Math.min(6, width * .012, height * .012);
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number.isFinite(o.zoom) ? o.zoom : ZOOM_DEFAULT));
  const tanV = Math.tan(o.fov * Math.PI / 360);
  const roomX = tanV * width / height * (1 - 2 * margin / width) * zoom / 100;
  const roomY = tanV * (1 - 2 * margin / height) * zoom / 100;
  const sin = Math.sin(o.tilt), cos = Math.cos(o.tilt);
  let distance = .1;
  for (const x of [-o.halfWidth, o.halfWidth])
    for (const y of [-o.halfHeight, o.halfHeight])
      for (const worldZ of [o.minZ, o.maxZ]) {
        const z = worldZ - o.anchorZ;
        const cameraY = y * cos + z * sin;
        const depth = -y * sin + z * cos;
        distance = Math.max(distance, depth + Math.max(Math.abs(x) / roomX, Math.abs(cameraY) / roomY));
      }
  return { distance, zoom, margin };
}
