import * as THREE from 'three';

// The gap the wave lives in. Its width stands for one second of signal,
// so "waves across the gap" is literally the frequency in Hz.
export const W = 12;
export const H = 10;
export const AMP_UNIT = 0.8; // world units per amplitude step
export const F_MIN = 1;
export const F_MAX = 5;
export const A_MIN = 1;
export const A_MAX = 4;

export const waveY = (u, f, a) => a * AMP_UNIT * Math.sin(2 * Math.PI * f * u);

// Samples the wave as [x, y] points across the gap.
export function sampleWave(f, a, n = 96) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pts.push([-W / 2 + u * W, waveY(u, f, a)]);
  }
  return pts;
}

// A flat strip that follows a 2D curve in the XY plane. Used for the
// player's wave and for the glowing edges of each slot.
export class Ribbon {
  constructor(n, width, material, { colors = false } = {}) {
    this.n = n;
    this.width = width;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    if (colors) {
      this.col = new Float32Array(n * 2 * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
  }

  set(points, offsetY = 0) {
    const n = this.n;
    const hw = this.width / 2;
    for (let i = 0; i < n; i++) {
      const [x, y] = points[i];
      const [x0, y0] = points[Math.max(0, i - 1)];
      const [x1, y1] = points[Math.min(n - 1, i + 1)];
      let tx = x1 - x0;
      let ty = y1 - y0;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      // Normal in the XY plane keeps the strip an even thickness on slopes.
      const nx = -ty * hw;
      const ny = tx * hw;
      this.pos.set([x + nx, y + offsetY + ny, 0, x - nx, y + offsetY - ny, 0], i * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  setColor(i, r, g, b) {
    this.col.set([r, g, b, r, g, b], i * 6);
  }
}

// The two solid halves of a wall, leaving a wave-shaped slot of
// half-height `gap` between them.
export function slotGeometries(f, a, gap) {
  const pts = sampleWave(f, a, 80);
  const top = new THREE.Shape();
  top.moveTo(-W / 2, H / 2);
  top.lineTo(W / 2, H / 2);
  for (let i = pts.length - 1; i >= 0; i--) top.lineTo(pts[i][0], pts[i][1] + gap);
  top.closePath();

  const bottom = new THREE.Shape();
  bottom.moveTo(-W / 2, -H / 2);
  bottom.lineTo(W / 2, -H / 2);
  for (let i = pts.length - 1; i >= 0; i--) bottom.lineTo(pts[i][0], pts[i][1] - gap);
  bottom.closePath();

  return { top: new THREE.ShapeGeometry(top), bottom: new THREE.ShapeGeometry(bottom), pts };
}
