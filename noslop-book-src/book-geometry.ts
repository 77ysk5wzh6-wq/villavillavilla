import type { Object3D } from 'three';

type Point = { x: number; y: number; z: number };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (end: number, x: number) => { const t = clamp(x / end, 0, 1); return t * t * (3 - 2 * t); };
const arc = (p: Point, a: number, k: number, length: number) => {
  if (Math.abs(k) < 1e-4) {
    p.x += Math.cos(a) * length; p.z += Math.sin(a) * length;
  } else {
    p.x += (Math.sin(a + k * length) - Math.sin(a)) / k;
    p.z += (Math.cos(a) - Math.cos(a + k * length)) / k;
  }
};

// CPU equivalent of the paper, cover, and page-block vertex shaders, retained
// for regression tests of the fixed camera envelope. Production framing never
// changes with the current vertices. Shadows are excluded from clipping tests.
export function bookVertex(mesh: any, x: number, y: number, z: number, out: Point): Point {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const u = material.uniforms;
  out.x = x; out.y = y; out.z = z;
  const width = u.uW.value;
  if (u.uThick) {
    const thick = u.uThick.value;
    const ramp = smooth(.22 * width, x) * (1 - u.uClosed.value) + u.uClosed.value;
    out.z = (z >= .5 ? 1 : 0) * (thick * ramp +
      u.uGutH.value * smooth(.3 * width, x) * (thick >= .0001 ? 1 : 0)) * u.uSide.value;
  } else {
    const A = u.uA.value, low = u.uAR.value, high = u.uAL.value;
    const yn = y / (u.uH.value * .5), gutter = u.uSG.value, middle = width * .5;
    const a = clamp(A + u.uG.value * yn * Math.sin(A), low, high);
    const a0 = clamp(a + u.uGut.value, low, high);
    const k0 = (a - a0) / gutter;
    const k1 = clamp(u.uK.value * (1 + .45 * u.uG.value * yn), (low - a) / (middle - gutter), (high - a) / (middle - gutter));
    const a1 = a + k1 * (middle - gutter);
    const k2 = clamp(k1 + u.uK2.value, (low - a1) / (width - middle), (high - a1) / (width - middle));
    out.x = out.z = 0;
    let phi: number;
    if (x <= gutter) {
      arc(out, a0, k0, x); phi = a0 + k0 * x;
    } else if (x <= middle) {
      arc(out, a0, k0, gutter); arc(out, a, k1, x - gutter); phi = a + k1 * (x - gutter);
    } else {
      arc(out, a0, k0, gutter); arc(out, a, k1, middle - gutter); arc(out, a1, k2, x - middle); phi = a1 + k2 * (x - middle);
    }
    if (u.uOffC) {
      const unbound = smooth(.055 * width, x), paper = .18 + .82 * smooth(.22 * width, x);
      const binding = u.uBinding.value, coverOffset = u.uOffC.value, paperOffset = u.uOffP.value;
      out.x += binding.x * (1 - unbound) + (coverOffset.x + paperOffset.x * paper) * unbound;
      out.y += binding.y * (1 - unbound) + (coverOffset.y + paperOffset.y * paper) * unbound;
      out.z += binding.z * (1 - unbound) + (coverOffset.z + paperOffset.z * paper) * unbound;
    } else {
      const bx = out.x - Math.sin(phi) * z, bz = out.z + Math.cos(phi) * z;
      out.x = Math.cos(A) * bx + Math.sin(A) * bz;
      out.z = -Math.sin(A) * bx + Math.cos(A) * bz;
    }
  }
  const e = mesh.matrixWorld.elements, px = out.x, py = out.y, pz = out.z;
  out.x = e[0] * px + e[4] * py + e[8] * pz + e[12];
  out.y = e[1] * px + e[5] * py + e[9] * pz + e[13];
  out.z = e[2] * px + e[6] * py + e[10] * pz + e[14];
  return out;
}

export function visitBookVertices(book: Object3D, visit: (x: number, y: number, z: number) => void) {
  book.updateMatrixWorld(true);
  const point = { x: 0, y: 0, z: 0 };
  book.traverseVisible((mesh: any) => {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const vertices = mesh.geometry?.attributes?.position;
    if (!vertices) return;
    if (mesh.userData?.bookSurface) {
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < vertices.count; i++) {
        const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
        visit(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      return;
    }
    if (!material?.uniforms?.uW) return;
    for (let i = 0; i < vertices.count; i++) {
      bookVertex(mesh, vertices.getX(i), vertices.getY(i), vertices.getZ(i), point);
      visit(point.x, point.y, point.z);
    }
  });
}
