import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildDetails } from './details.js';

// Jam Kart GP: a Grand Prix circuit in rolling forest, loosely inspired by the
// classic Belgian track: a hairpin after the start, a dip and steep climb, a
// long straight, a chicane, a hairpin, fast sweepers and a bus-stop chicane.
export const TRACK_W = 12; // kart-track width
export const SAMPLES = 800;

const SCALE = 0.56; // about 1 km, so a lap takes ~40 s at kart speeds
const CONTROL = [
  [0, 10], [0, -80], [6, -108], [24, -118], [40, -106], [44, -70], [46, -30], [40, 0], [54, 22], [48, 46], [62, 76],
  [100, 150], [128, 205], [152, 226], [146, 252], [160, 274], [192, 288], [220, 270], [218, 240], [198, 230],
  [180, 210], [176, 178], [190, 142], [218, 120], [245, 95], [258, 60], [250, 10], [258, -60], [242, -130],
  [205, -165], [140, -150], [80, -172], [20, -162], [-40, -150], [-58, -100], [-56, -20], [-46, 20], [-62, 48],
  [-48, 74], [-24, 98], [0, 80], [0, 50],
].map(([x, z]) => [x * SCALE, z * SCALE]);

// Late-afternoon haze.
export const FOG = { color: 0xb7c6d3, near: 140, far: 520 };

// Track features. u is the share of a lap (0 = start line), lat the sideways
// span (+ is left). Delete a line (or set it to []) to switch a feature off.
export const HAZARDS = {
  rain: [{ u0: 0.425, u1: 0.455, lat: [0.5, 6] }, { u0: 0.098, u1: 0.12, lat: [-6, -0.5] }],
  boost: [{ u0: 0.02, u1: 0.035, lat: [1, 5] }, { u0: 0.225, u1: 0.24, lat: [-5, -1] }, { u0: 0.7, u1: 0.715, lat: [-2.2, 2.2] }],
  gates: [{ u0: 0.845 }],
};

// Height of the road along the lap: level start, a dip into the S-bends, a
// steep climb, the long drag up the straight, then a long descent through
// the far side and back up to the start.
const PROFILE = [
  [0, 3.5], [0.06, 3.5], [0.09, 4], [0.14, 1], [0.155, 0.6], [0.2, 7.5], [0.28, 10], [0.32, 10.5], [0.36, 8.5],
  [0.4, 6], [0.47, 3.5], [0.55, 2], [0.6, 1], [0.7, 2], [0.8, 3.5], [0.9, 3.5], [1, 3.5],
];
function heightAt(u) {
  for (let k = 1; k < PROFILE.length; k++) {
    const [u1, h1] = PROFILE[k];
    if (u <= u1) {
      const [u0, h0] = PROFILE[k - 1];
      const t = (u - u0) / (u1 - u0);
      return h0 + (h1 - h0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return PROFILE[0][1];
}

const wrap = (i) => ((i % SAMPLES) + SAMPLES) % SAMPLES;

export function buildTrack() {
  const curve = new THREE.CatmullRomCurve3(
    CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal'
  );
  const raw = curve.getSpacedPoints(SAMPLES);
  const pts = raw.slice(0, SAMPLES).map((p) => new THREE.Vector2(p.x, p.z));
  const tan = pts.map((_, i) => {
    const a = pts[(i - 1 + SAMPLES) % SAMPLES];
    const b = pts[(i + 1) % SAMPLES];
    return b.clone().sub(a).normalize();
  });
  // `side` points to the kart's left when driving forward.
  const side = tan.map((t) => new THREE.Vector2(t.y, -t.x));
  const dist = [0];
  for (let i = 1; i < SAMPLES; i++) dist.push(dist[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = dist[SAMPLES - 1] + pts[0].distanceTo(pts[SAMPLES - 1]);

  // Bank the corners: the outside edge rises with how tight the turn is.
  const ang = tan.map((t) => Math.atan2(t.x, t.y));
  const curv = ang.map((_, i) => {
    const a = ang[wrap(i + 6)] - ang[wrap(i - 6)];
    return Math.atan2(Math.sin(a), Math.cos(a)) / (dist[1] * 12);
  });
  const bank = curv.map((_, i) => {
    let sum = 0;
    for (let j = -15; j <= 15; j++) sum += curv[wrap(i + j)];
    return Math.max(-0.07, Math.min(0.07, (sum / 31) * 3));
  });
  // `base` is the ground the circuit is cut into; the tarmac sits on top.
  const base = dist.map((d) => heightAt(d / length));
  const height = base.map((h) => h + 0.3);
  return { pts, tan, side, dist, length, height, base, bank, curv };
}

// Road surface height at sample i, `lat` from the centre line.
export const surfaceY = (track, i, lat) => track.height[i] - lat * track.bank[i];

// Beyond the tarmac a grass verge slopes from the road edge down to the
// surrounding ground over VERGE metres.
const VERGE = 4;
export function vergeY(track, i, lat) {
  const a = Math.abs(lat);
  if (a <= TRACK_W / 2) return surfaceY(track, i, lat) + 0.02; // the tarmac mesh sits 2 cm up
  const edge = surfaceY(track, i, Math.sign(lat) * (TRACK_W / 2));
  const t = Math.min((a - TRACK_W / 2) / VERGE, 1);
  const y = edge + (track.base[i] - 0.5 - edge) * t;
  // Never below the visible ground, or karts on the grass sink into it.
  if (!track.terrainY) return y;
  const p = track.pts[i];
  const s = track.side[i];
  return Math.max(y, track.terrainY(p.x + s.x * lat, p.y + s.y * lat) + 0.08);
}

// Smooth ground height under (x, z), road or verge, blending neighbours.
export function groundAt(track, i, x, z, lat) {
  const p = track.pts[i];
  const t = track.tan[i];
  const s = (x - p.x) * t.x + (z - p.y) * t.y;
  const j = wrap(i + (s >= 0 ? 1 : -1));
  const f = Math.min(Math.abs(s) / (track.dist[1] || 1), 1);
  return vergeY(track, i, lat) * (1 - f) + vergeY(track, j, lat) * f;
}

export const sampleAt = (u) => Math.floor(u * SAMPLES) % SAMPLES;

// Nearest sample to (x, z), searching around `hint` (or everywhere if null).
// Returns the sample index and the signed sideways offset (+ is left).
export function locate(track, x, z, hint = null) {
  let best = 0;
  let bestD = Infinity;
  const from = hint === null ? 0 : hint - 30;
  const to = hint === null ? SAMPLES : hint + 30;
  for (let j = from; j < to; j++) {
    const i = wrap(j);
    const p = track.pts[i];
    const d = (p.x - x) ** 2 + (p.y - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const p = track.pts[best];
  const s = track.side[best];
  return { i: best, lat: (x - p.x) * s.x + (z - p.y) * s.y };
}

export const ahead = (i, n) => wrap(i + n);

// ------------------------------------------------------------------ helpers

export function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Seeded random so the circuit looks the same every round.
export function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// A strip following the track between two sideways offsets. y(k, lat) gives
// each vertex height; uv.x runs 0..1 across, uv.y is distance along.
export function strip(track, latA, latB, y, { i0 = 0, i1 = SAMPLES } = {}) {
  const pos = [];
  const uv = [];
  const idx = [];
  const n = i1 - i0;
  for (let j = 0; j <= n; j++) {
    const k = wrap(i0 + j);
    const p = track.pts[k];
    const s = track.side[k];
    const v = i0 + j === SAMPLES ? track.length : track.dist[k];
    pos.push(p.x + s.x * latA, y(k, latA, 0), p.y + s.y * latA, p.x + s.x * latB, y(k, latB, 1), p.y + s.y * latB);
    uv.push(0, v, 1, v);
    if (j < n) {
      const a = j * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Several strips side by side (between each pair of `lats`), merged into
// one mesh, so a surface with a kink across it (like the verge) is drawn
// exactly where the karts drive on it.
export function bandStrip(track, lats, y, opts) {
  const parts = [];
  for (let n = 0; n < lats.length - 1; n++) parts.push(strip(track, lats[n], lats[n + 1], y, opts));
  return mergeGeometries(parts);
}

// The verge's lateral sample points: dense enough to follow its slope, the
// flat beyond it and the terrain it may rise to meet.
export const vergeLats = (s, from = TRACK_W / 2, to = TRACK_W / 2 + 7) => {
  const out = [];
  for (let l = from; l < to; l += 0.8) out.push(s * l);
  if (!out.some((l) => Math.abs(Math.abs(l) - (TRACK_W / 2 + 4)) < 0.01) && to > TRACK_W / 2 + 4 && from < TRACK_W / 2 + 4) out.push(s * (TRACK_W / 2 + 4));
  out.push(s * to);
  return out.sort((a, b) => s * (a - b));
};

// Texture coordinates from world position, so grass meets grass seamlessly.
export function worldUV(geo, scale) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let k = 0; k < pos.count; k++) uv.setXY(k, pos.getX(k) / scale, pos.getZ(k) / scale);
  uv.needsUpdate = true;
  return geo;
}

const worldVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// Asphalt: fine grain, a darker rubbered racing line, white edge lines, the
// chequered start line and painted grid slots.
const roadFrag = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogNear, uFogFar, uLength, uHalf;
  uniform float uGrid[8];
  uniform float uGridSide[8];
  varying vec2 vUv;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float u = vUv.x;
    float v = vUv.y;
    vec2 q = vWorld.xz * 0.35;
    vec2 qi = floor(q);
    vec2 qf = fract(q);
    qf = qf * qf * (3.0 - 2.0 * qf);
    float patchy = mix(mix(hash(qi), hash(qi + vec2(1.0, 0.0)), qf.x), mix(hash(qi + vec2(0.0, 1.0)), hash(qi + vec2(1.0)), qf.x), qf.y);
    float d = length(vWorld - cameraPosition);
    float grain = hash(floor(vWorld.xz * 24.0)) * 0.035 * (1.0 - smoothstep(10.0, 40.0, d)) + patchy * 0.035;
    vec3 col = vec3(0.16, 0.165, 0.175) + grain;
    col *= 0.88 + 0.12 * smoothstep(0.15, 0.0, abs(u - 0.5 - 0.12 * sin(v * 0.01)));
    float edge = step(u, 0.022) + step(0.978, u);
    col = mix(col, vec3(0.92), edge);
    if (v < 2.5) {
      float c = mod(floor(u * 16.0) + floor(v * 2.0), 2.0);
      col = mix(vec3(0.05), vec3(0.95), c);
    }
    float lat = uHalf - u * uHalf * 2.0;
    for (int k = 0; k < 8; k++) {
      float gv = uGrid[k];
      float d = v - gv;
      bool box = (abs(d) < 0.18 && lat * uGridSide[k] > 1.1 && lat * uGridSide[k] < 4.5) ||
                 (d > 0.0 && d < 2.2 && abs(lat * uGridSide[k] - 4.4) < 0.12);
      if (box) col = vec3(0.92);
    }
    float fog = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
  }`;

// Hazard decals. kind 0: rain puddle, 1: fibre boost strip.
const decalFrag = /* glsl */ `
  uniform float uTime;
  uniform int uKind;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    float u = vUv.x;
    float v = vUv.y;
    float edge = smoothstep(0.0, 0.1, u) * smoothstep(1.0, 0.9, u);
    vec3 col;
    float a;
    if (uKind == 0) {
      // Standing water: dark and glossy, with rings spreading from raindrops.
      vec2 cell = floor(vWorld.xz / 2.0);
      vec2 f = fract(vWorld.xz / 2.0) - 0.5;
      float ph = fract(uTime * 0.8 + fract(sin(dot(cell, vec2(12.9, 78.2))) * 437.5));
      float ring = smoothstep(0.04, 0.0, abs(length(f) - ph * 0.5)) * (1.0 - ph);
      float sheen = 0.5 + 0.5 * sin(v * 0.3 + u * 6.0 + uTime * 0.6);
      col = vec3(0.12, 0.18, 0.26) + vec3(0.5, 0.6, 0.7) * (sheen * 0.12 + ring * 0.6);
      a = 0.75 * edge * smoothstep(0.0, 0.08, fract(v / 40.0) + 0.04);
    } else {
      float c = fract((v + abs(u - 0.5) * 6.0) / 3.0 - uTime * 2.5);
      float chev = smoothstep(0.0, 0.08, c) * smoothstep(0.45, 0.3, c);
      col = vec3(0.45, 1.0, 0.25) * (0.35 + chev * 1.2);
      a = 0.85 * edge;
    }
    gl_FragColor = vec4(col, a);
  }`;

// ------------------------------------------------------------------ terrain

function grassTexture() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#3f6b2c';
    g.fillRect(0, 0, w, h);
    // Mowing stripes.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 32, h);
    for (let n = 0; n < 3000; n++) {
      const v = Math.random();
      g.fillStyle = v < 0.5 ? 'rgba(20,40,10,0.25)' : 'rgba(140,180,90,0.18)';
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, 3);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let terrainGrass;

// Rolling hills that hug the circuit: near the road the ground sits just
// under the tarmac, further out it eases into gentle forested hills.
function buildTerrain(scene, track) {
  const size = 760;
  const n = 190;
  const cx = 55;
  const cz = 32;
  const heights = new Float32Array((n + 1) * (n + 1));
  const hills = (x, z) =>
    3 + 5 * Math.sin(x * 0.012 + 1.3) * Math.cos(z * 0.01 - 0.7) + 2.5 * Math.sin(x * 0.031 + z * 0.023) + 1.2 * Math.cos(z * 0.05 - x * 0.02);
  const geo = new THREE.PlaneGeometry(size, size, n, n);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k) + cx;
    const z = pos.getZ(k) + cz;
    let best = 0;
    let bd = Infinity;
    let lowest = Infinity; // lowest road ground within reach of this point
    for (let i = 0; i < SAMPLES; i += 2) {
      const p = track.pts[i];
      const d = (p.x - x) ** 2 + (p.y - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
      if (d < (TRACK_W / 2 + 9) ** 2) lowest = Math.min(lowest, track.base[i]);
    }
    const d = Math.sqrt(bd);
    const t = Math.min(Math.max((d - (TRACK_W / 2 + 5)) / 50, 0), 1);
    const ease = t * t * (3 - 2 * t);
    let h = (track.base[best] - 0.6) * (1 - ease) + Math.max(hills(x, z), track.base[best] - 6) * ease;
    // Where two parts of the circuit run close, keep the ground under both.
    h = Math.min(h, lowest - 0.6);
    pos.setY(k, h);
    heights[k] = h;
    uv.setXY(k, x / 18, z / 18);
  }
  geo.computeVertexNormals();
  const tex = grassTexture();
  const grass = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide });
  const ground = new THREE.Mesh(geo, grass);
  ground.userData.ground = 'terrain'; // drawn ground, for tests
  ground.position.set(cx, 0, cz);
  scene.add(ground);
  terrainGrass = grass;

  // Height of the ground anywhere, for placing scenery.
  const cell = size / n;
  return (x, z) => {
    const gx = Math.min(Math.max((x - cx + size / 2) / cell, 0), n - 0.001);
    const gz = Math.min(Math.max((z - cz + size / 2) / cell, 0), n - 0.001);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const at = (a, b) => heights[b * (n + 1) + a];
    return (at(ix, iz) * (1 - fx) + at(ix + 1, iz) * fx) * (1 - fz) + (at(ix, iz + 1) * (1 - fx) + at(ix + 1, iz + 1) * fx) * fz;
  };
}

// ------------------------------------------------------------------ board

export function buildBoard(scene, track) {
  const terrainY = buildTerrain(scene, track);
  track.terrainY = terrainY;

  // Grid slots: where JamKartGP's #placeGrid puts the eight karts.
  const grid = [];
  const gridSide = [];
  for (let slot = 0; slot < 8; slot++) {
    const back = 3 + Math.floor(slot / 2) * 6 + (slot % 2) * 2;
    const idx = (SAMPLES + 4 - back) % SAMPLES;
    grid.push(track.dist[idx] - 1.8);
    gridSide.push(slot % 2 === 0 ? 1 : -1);
  }
  const roadMat = new THREE.ShaderMaterial({
    vertexShader: worldVert,
    fragmentShader: roadFrag,
    uniforms: {
      uFogColor: { value: new THREE.Color(FOG.color) },
      uFogNear: { value: FOG.near },
      uFogFar: { value: FOG.far },
      uLength: { value: track.length },
      uHalf: { value: TRACK_W / 2 },
      uGrid: { value: grid },
      uGridSide: { value: gridSide },
    },
    side: THREE.DoubleSide,
  });
  const onRoad = (k, lat) => surfaceY(track, k, lat) + 0.02;
  const road = new THREE.Mesh(strip(track, TRACK_W / 2, -TRACK_W / 2, onRoad), roadMat);
  road.userData.ground = 'road';
  scene.add(road);
  // Grass verges from the tarmac's edge down to the ground on both sides,
  // sampled finely across so the grass is exactly where the karts sit, and
  // textured in world space so it blends into the terrain.
  for (const s of [1, -1]) {
    const g = worldUV(bandStrip(track, vergeLats(s), (k, lat) => vergeY(track, k, lat)), 18);
    const verge = new THREE.Mesh(g, terrainGrass);
    verge.userData.ground = 'verge';
    scene.add(verge);
  }

  const reserved = [];
  const hazards = buildHazards(scene, track, reserved);
  const details = buildDetails(scene, track, terrainY, reserved);

  return {
    lights: [],
    hazards,
    terrainY,
    setStartLights: details.setStartLights,
    setHazards(on) {
      hazards.set(on);
      details.setSigns(on);
    },
    update(time) {
      for (const m of hazards.decals) m.uniforms.uTime.value = time;
      hazards.animate(time);
      details.update(time);
    },
  };
}

// Gate pistons are up for 40% of every 2 s cycle, staggered so at least one
// lane is always open.
export const GATE_CYCLE = 2;
const GATE_UP = 0.4;
export function gateHeight(gate, time) {
  const ph = (time / GATE_CYCLE + gate.phase) % 1;
  return ph < GATE_UP ? Math.max(0, Math.min(1, Math.min(ph, GATE_UP - ph) * 14)) : 0;
}

function buildHazards(scene, track, reserved) {
  const zones = [];
  const decals = [];
  const meshes = { rain: [], boost: [], gates: [] };
  const decal = (kind, z) => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: worldVert,
      fragmentShader: decalFrag,
      uniforms: { uTime: { value: 0 }, uKind: { value: kind } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: kind === 0 ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    const i0 = sampleAt(z.u0);
    const i1 = sampleAt(z.u1);
    const mesh = new THREE.Mesh(strip(track, z.lat[1], z.lat[0], (k, lat) => surfaceY(track, k, lat) + 0.06, { i0, i1 }), mat);
    scene.add(mesh);
    meshes[kind === 0 ? 'rain' : 'boost'].push(mesh);
    decals.push(mat);
    return { i0, i1, lat: z.lat };
  };
  for (const z of HAZARDS.rain ?? []) zones.push({ type: 'rain', ...decal(0, z) });
  for (const z of HAZARDS.boost ?? []) zones.push({ type: 'boost', ...decal(1, z) });

  const gates = [];
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.35, metalness: 0.8 });
  for (const z of HAZARDS.gates ?? []) {
    const i = sampleAt(z.u0);
    const t = track.tan[i];
    const stripe = new THREE.MeshBasicMaterial({ color: 0xff3b4a });
    [-4, 0, 4].forEach((lat, n) => {
      const g = new THREE.Group();
      const block = new THREE.Mesh(new THREE.BoxGeometry(3.8, 2.4, 1.4), metal);
      block.position.y = 1.2;
      const top = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.25, 1.5), stripe);
      top.position.y = 2.45;
      g.add(block, top);
      const p = track.pts[i];
      const s = track.side[i];
      const x = p.x + s.x * lat;
      const zz = p.y + s.y * lat;
      g.position.set(x, surfaceY(track, i, lat), zz);
      g.rotation.y = Math.atan2(t.x, t.y);
      scene.add(g);
      meshes.gates.push(g);
      gates.push({ i, lat, x, z: zz, phase: n / 3, mesh: g, base: g.position.y });
    });
    zones.push({ type: 'gates', i0: i - 4, i1: i + 4, lat: [-TRACK_W / 2, TRACK_W / 2] });
  }
  const animate = (time) => {
    for (const g of gates) g.mesh.position.y = g.base - 2.6 * (1 - gateHeight(g, time));
  };
  const hazards = { zones, decals, gates, animate };
  // The in-game HAZARDS setting: show only the chosen features, and give
  // the game (and CPU drivers) only their zones and gates.
  hazards.set = (on) => {
    hazards.zones = zones.filter((z) => on[z.type]);
    hazards.gates = on.gates ? gates : [];
    for (const [type, list] of Object.entries(meshes)) for (const m of list) m.visible = !!on[type];
  };
  return hazards;
}
