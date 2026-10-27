import * as THREE from 'three';

// The circuit: a copper trace looping around a circuit board, sampled into
// evenly spaced points so karts can find where they are on it.
export const TRACK_W = 16;
export const SAMPLES = 800;

const SCALE = 1.35; // sized so a lap takes about 22 seconds
const CONTROL = [
  [0, 0], [60, -10], [110, -40], [140, -100], [110, -150], [50, -140], [20, -100],
  [-20, -80], [-70, -110], [-120, -90], [-140, -30], [-110, 20], [-50, 30],
].map(([x, z]) => [x * SCALE, z * SCALE]);

export const FOG = { color: 0x020a07, near: 70, far: 240 };

// Track features, each switchable. u is the share of a lap (0 = start line),
// lat the sideways span (+ is left).
export const HAZARDS = {
  flux: [{ u0: 0.3, u1: 0.335, lat: [0.5, 8] }, { u0: 0.345, u1: 0.375, lat: [-8, -0.5] }],
  boost: [{ u0: 0.085, u1: 0.1, lat: [1, 6.5] }, { u0: 0.535, u1: 0.55, lat: [-6.5, -1] }, { u0: 0.775, u1: 0.79, lat: [-2.8, 2.8] }],
  emi: [{ u0: 0.63, u1: 0.68, lat: [-8, 8] }],
  fan: [{ u0: 0.85, u1: 0.9, lat: [-8, 8] }],
  gates: [{ u0: 0.945 }],
};

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const bump = (u, c, w) => {
  const d = Math.min(Math.abs(u - c), 1 - Math.abs(u - c)) / w;
  return d < 1 ? 0.5 + 0.5 * Math.cos(Math.PI * d) : 0;
};

// Two rolling hills plus a kicker ramp: it steepens all the way to a sharp
// lip, so fast karts launch off it, then the road drops away underneath.
function heightAt(u) {
  let h = 7 * bump(u, 0.22, 0.075) + 5 * bump(u, 0.72, 0.065);
  if (u > 0.43 && u < 0.47) h += 4.5 * ((u - 0.43) / 0.04) ** 2;
  else if (u >= 0.47 && u < 0.5) h += 4.5 * (1 - smooth((u - 0.47) / 0.03));
  return h;
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
    return Math.max(-0.2, Math.min(0.2, (sum / 31) * 6));
  });
  // Lift banked corners so the low inside edge stays above the board.
  const height = dist.map((d, i) => heightAt(d / length) + Math.abs(bank[i]) * (TRACK_W / 2 + 0.6));
  return { pts, tan, side, dist, length, height, bank };
}

// Road surface height at sample i, `lat` from the centre line.
export const surfaceY = (track, i, lat) => track.height[i] - lat * track.bank[i];

// Smooth road height under (x, z), blending between neighbouring samples.
export function groundAt(track, i, x, z, lat) {
  const p = track.pts[i];
  const t = track.tan[i];
  const s = (x - p.x) * t.x + (z - p.y) * t.y;
  const j = wrap(i + (s >= 0 ? 1 : -1));
  const f = Math.min(Math.abs(s) / (track.dist[1] || 1), 1);
  return surfaceY(track, i, lat) * (1 - f) + surfaceY(track, j, lat) * f;
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

// ------------------------------------------------------------------ meshes

const fogUniforms = () => ({
  uFogColor: { value: new THREE.Color(FOG.color) },
  uFogNear: { value: FOG.near },
  uFogFar: { value: FOG.far },
});

const worldVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// Copper trace: dark copper, glowing gold edges, a dashed centre line,
// chevrons flowing along it and a chequered start line.
const trackFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFogColor;
  uniform float uFogNear, uFogFar;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    float u = vUv.x;
    float v = vUv.y;
    vec3 col = vec3(0.04, 0.017, 0.007) * (0.85 + 0.15 * sin(v * 0.9 + u * 40.0));
    float edge = smoothstep(0.045, 0.0, u) + smoothstep(0.955, 1.0, u);
    float bus = 0.0;
    for (int k = 1; k < 4; k++) {
      float c = float(k) * 0.25;
      bus += 1.0 - smoothstep(0.0, 0.006, abs(abs(u - 0.5) - c * 0.5 - 0.05) - 0.002);
    }
    float lane = (1.0 - smoothstep(0.0, 0.008, abs(u - 0.5))) * step(0.5, fract(v / 6.0));
    // Chevrons flowing forward show which way to drive.
    float c = fract((v + abs(u - 0.5) * 10.0) / 14.0 - uTime * 0.8);
    float pulse = smoothstep(0.0, 0.01, c) * smoothstep(0.05, 0.03, c) * step(abs(u - 0.5), 0.32);
    col += vec3(1.0, 0.55, 0.15) * edge * 1.1 + vec3(0.6, 0.3, 0.1) * bus * 0.12 + vec3(1.0, 0.75, 0.35) * lane * 0.35 + vec3(0.5, 1.0, 0.25) * pulse * 0.16;
    if (v < 3.0) {
      float c = mod(floor(u * 16.0) + floor(v * 2.0), 2.0);
      col = mix(col, vec3(c * 0.85), 0.9);
    }
    float fog = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
  }`;

// Green solder mask with faint traces and vias.
const boardFrag = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogNear, uFogFar;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 p = vWorld.xz / 6.0;
    vec2 cell = floor(p);
    vec2 f = fract(p);
    float h = hash(cell);
    float aa = fwidth(p.x) * 1.5;
    float w = 0.05;
    float tr = 0.0;
    if (h < 0.35) tr = 1.0 - smoothstep(w, w + aa, abs(f.y - 0.5));
    else if (h < 0.6) tr = 1.0 - smoothstep(w, w + aa, abs(f.x - 0.5));
    float r = length(f - 0.5);
    float ring = step(0.82, h) * smoothstep(0.1, 0.1 + aa, r) * (1.0 - smoothstep(0.17, 0.17 + aa, r));
    float d = length(vWorld - cameraPosition);
    float near = 1.0 - smoothstep(40.0, 140.0, d);
    vec3 col = vec3(0.01, 0.05, 0.03) + (vec3(0.03, 0.16, 0.07) * tr + vec3(0.5, 0.42, 0.2) * ring * 0.5) * near;
    gl_FragColor = vec4(mix(col, uFogColor, smoothstep(uFogNear, uFogFar, d)), 1.0);
  }`;

// A strip following the track at a sideways offset (a road, wall or decal).
// Each edge sits `offA`/`offB` above the road, or on the board if `ground`.
function strip(track, latA, latB, offA, offB, vScale, { i0 = 0, i1 = SAMPLES, groundA = false, groundB = false } = {}) {
  const pos = [];
  const uv = [];
  const idx = [];
  const n = i1 - i0;
  for (let j = 0; j <= n; j++) {
    const k = wrap(i0 + j);
    const p = track.pts[k];
    const s = track.side[k];
    const v = i0 + j === SAMPLES ? track.length : track.dist[k];
    const yA = groundA ? 0 : surfaceY(track, k, latA) + offA;
    const yB = groundB ? 0 : surfaceY(track, k, latB) + offB;
    pos.push(p.x + s.x * latA, yA, p.y + s.y * latA, p.x + s.x * latB, yB, p.y + s.y * latB);
    uv.push(0, v * vScale, 1, v * vScale);
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

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Seeded random so the board looks the same every round.
function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// Builds every static mesh. Returns materials that animate.
// Decals laid on the road for the hazards. kind: 0 flux, 1 boost, 2 EMI, 3 wind.
const decalFrag = /* glsl */ `
  uniform float uTime;
  uniform int uKind;
  varying vec2 vUv;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  void main() {
    float u = vUv.x;
    float v = vUv.y;
    float edge = smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.92, u);
    vec3 col;
    float a;
    if (uKind == 0) {
      // Oily flux: shifting teal/violet sheen with bright glints.
      float s = sin(v * 0.45 + uTime * 1.3 + sin(u * 9.0 + v * 0.2) * 2.0);
      col = mix(vec3(0.1, 0.9, 0.8), vec3(0.6, 0.25, 1.0), 0.5 + 0.5 * s) * 0.55;
      col += vec3(1.0) * pow(max(0.0, sin(v * 1.7 - uTime * 2.0 + u * 13.0)), 30.0) * 0.8;
      a = 0.6 * edge;
    } else if (uKind == 1) {
      // Fibre link: bright chevrons racing forward.
      float c = fract((v + abs(u - 0.5) * 6.0) / 3.0 - uTime * 2.5);
      float chev = smoothstep(0.0, 0.08, c) * smoothstep(0.45, 0.3, c);
      col = vec3(0.45, 1.0, 0.25) * (0.25 + chev * 1.3);
      a = 0.9 * edge;
    } else if (uKind == 2) {
      // EMI: crackling magenta noise.
      vec2 cell = floor(vec2(u * 30.0, v * 1.5 + floor(uTime * 12.0) * 7.0));
      float n = step(0.93, hash(cell));
      float wave = 0.5 + 0.5 * sin(v * 0.8 - uTime * 6.0);
      col = vec3(1.0, 0.2, 0.75) * (n * 1.2 + wave * 0.12);
      a = (0.35 + n * 0.5) * edge;
    } else {
      // Wind from the fan: faint stripes sliding across the road.
      float st = smoothstep(0.85, 1.0, fract(u * 3.0 - uTime * 1.8 + sin(v * 0.15) * 0.3));
      col = vec3(0.7, 0.9, 1.0) * st * 0.35;
      a = st * 0.5;
    }
    gl_FragColor = vec4(col, a);
  }`;

export function buildBoard(scene, track) {
  const trackMat = new THREE.ShaderMaterial({
    vertexShader: worldVert,
    fragmentShader: trackFrag,
    uniforms: { uTime: { value: 0 }, ...fogUniforms() },
    side: THREE.DoubleSide,
  });
  // Track uv.x runs left (+W/2) to right (-W/2); flip so u=0 is one edge.
  const road = new THREE.Mesh(strip(track, TRACK_W / 2, -TRACK_W / 2, 0.02, 0.02, 1), trackMat);
  scene.add(road);

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(1100, 1100),
    new THREE.ShaderMaterial({ vertexShader: worldVert, fragmentShader: boardFrag, uniforms: fogUniforms(), side: THREE.DoubleSide })
  );
  board.rotation.x = -Math.PI / 2;
  board.position.set(0, 0, -80);
  scene.add(board);

  // Glowing rails along both edges, and dark skirts down to the board where
  // the road is raised.
  const railMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffa030).multiplyScalar(0.7),
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x1a0f08, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    const lat = s * (TRACK_W / 2 + 0.2);
    scene.add(new THREE.Mesh(strip(track, lat, lat, 0, 0.9, 1), railMat));
    scene.add(new THREE.Mesh(strip(track, lat, lat, 0, 0, 1, { groundB: true }), skirtMat));
  }
  buildPillars(scene, track);

  const reserved = [];
  const hazards = buildHazards(scene, track, reserved);
  const lights = buildScenery(scene, track, reserved);
  buildGantry(scene, track);

  return {
    trackMat,
    lights,
    hazards,
    update(time) {
      trackMat.uniforms.uTime.value = time;
      for (const m of hazards.decals) m.uniforms.uTime.value = time;
      hazards.animate(time);
    },
  };
}

// Support columns under the raised sections.
function buildPillars(scene, track) {
  const spots = [];
  for (let i = 0; i < SAMPLES; i += 12) {
    if (track.height[i] < 1.2) continue;
    for (const s of [1, -1]) spots.push([i, s * (TRACK_W / 2 - 0.8)]);
  }
  const mesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.45, 0.6, 1, 10).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.4, metalness: 0.7 }),
    spots.length
  );
  const m = new THREE.Matrix4();
  spots.forEach(([i, lat], n) => {
    const p = track.pts[i];
    const sd = track.side[i];
    const h = surfaceY(track, i, lat);
    m.makeScale(1, h, 1).setPosition(p.x + sd.x * lat, 0, p.y + sd.y * lat);
    mesh.setMatrixAt(n, m);
  });
  scene.add(mesh);
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
  const movers = [];
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
    scene.add(new THREE.Mesh(strip(track, z.lat[1], z.lat[0], 0.06, 0.06, 1, { i0, i1 }), mat));
    decals.push(mat);
    return { i0, i1, lat: z.lat };
  };
  const beside = (i, lat) => {
    const p = track.pts[i];
    const s = track.side[i];
    return [p.x + s.x * lat, p.y + s.y * lat];
  };
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.35, metalness: 0.8 });

  for (const z of HAZARDS.flux ?? []) zones.push({ type: 'flux', ...decal(0, z) });
  for (const z of HAZARDS.boost ?? []) zones.push({ type: 'boost', ...decal(1, z) });

  for (const z of HAZARDS.emi ?? []) {
    zones.push({ type: 'emi', ...decal(2, z) });
    // A big copper inductor coil beside the road, crackling with arcs.
    const mid = sampleAt((z.u0 + z.u1) / 2);
    const out = track.bank[mid] > 0 ? -1 : 1; // outside of the bend
    const [x, zz] = beside(mid, out * (TRACK_W / 2 + 10));
    const base = surfaceY(track, mid, 0);
    const coil = new THREE.Group();
    const copper = new THREE.MeshStandardMaterial({ color: 0xc8742e, roughness: 0.3, metalness: 0.9, emissive: 0x401800 });
    for (let n = 0; n < 9; n++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4, 0.45, 10, 32), copper);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1 + n * 1.0;
      coil.add(ring);
    }
    const core = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 11, 20), metal);
    core.position.y = 5.5;
    coil.add(core);
    const arcMat = new THREE.LineBasicMaterial({ color: 0xff5ad8, transparent: true, opacity: 0.9 });
    const arcs = new THREE.LineSegments(new THREE.BufferGeometry(), arcMat);
    arcs.frustumCulled = false;
    coil.add(arcs);
    coil.position.set(x, Math.max(0, base - 1), zz);
    scene.add(coil);
    reserved.push([x, zz, 7]);
    movers.push((t) => {
      // Fresh random lightning from the coil towards the road a few times a second.
      if (Math.floor(t * 9) === coil.userData.f) return;
      coil.userData.f = Math.floor(t * 9);
      const pts = [];
      for (let a = 0; a < 4; a++) {
        let px = 0;
        let py = 4 + Math.random() * 6;
        let pz = 0;
        const dir = Math.random() * Math.PI * 2;
        for (let k = 0; k < 6; k++) {
          const nx = px + Math.cos(dir) * 2.2 + (Math.random() - 0.5) * 1.5;
          const ny = py + (Math.random() - 0.6) * 1.6;
          const nz = pz + Math.sin(dir) * 2.2 + (Math.random() - 0.5) * 1.5;
          pts.push(px, py, pz, nx, ny, nz);
          px = nx;
          py = ny;
          pz = nz;
        }
      }
      arcs.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    });
  }

  for (const z of HAZARDS.fan ?? []) {
    const info = decal(3, z);
    const mid = sampleAt((z.u0 + z.u1) / 2);
    const out = track.bank[mid] > 0 ? 1 : -1;
    // The fan stands on one side and blows karts towards the other.
    zones.push({ type: 'fan', ...info, push: -out });
    const [x, zz] = beside(mid, out * (TRACK_W / 2 + 7));
    const fan = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(12, 12, 1.6), metal);
    fan.add(frame);
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 1.8, 40), new THREE.MeshBasicMaterial({ color: 0x050607 }));
    hole.rotation.x = Math.PI / 2;
    fan.add(hole);
    const blades = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b0, roughness: 0.4, metalness: 0.6 });
    for (let n = 0; n < 7; n++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.6, 5.2, 0.15), bladeMat);
      b.position.y = 2.8;
      b.rotation.y = 0.5;
      const arm = new THREE.Group();
      arm.rotation.z = (n / 7) * Math.PI * 2;
      arm.add(b);
      blades.add(arm);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 1.2, 20), new THREE.MeshStandardMaterial({ color: 0x3df5ff, emissive: 0x0a5560 }));
    hub.rotation.x = Math.PI / 2;
    blades.add(hub);
    blades.position.z = 1;
    fan.add(blades);
    fan.position.set(x, surfaceY(track, mid, 0) + 6.2, zz);
    const t = track.tan[mid];
    // Face across the road, angled towards oncoming karts so they see it.
    fan.rotation.y = Math.atan2(t.x, t.y) + (out > 0 ? -Math.PI / 2 - 0.7 : Math.PI / 2 + 0.7);
    scene.add(fan);
    reserved.push([x, zz, 8]);
    movers.push((time) => (blades.rotation.z = -time * 9));
  }

  const gates = [];
  for (const z of HAZARDS.gates ?? []) {
    const i = sampleAt(z.u0);
    const t = track.tan[i];
    const stripe = new THREE.MeshBasicMaterial({ color: 0xff3b4a });
    [-5.2, 0, 5.2].forEach((lat, n) => {
      const g = new THREE.Group();
      const block = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.4, 1.4), metal);
      block.position.y = 1.2;
      const top = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.25, 1.5), stripe);
      top.position.y = 2.45;
      g.add(block, top);
      const [x, zz] = beside(i, lat);
      g.position.set(x, surfaceY(track, i, lat), zz);
      g.rotation.y = Math.atan2(t.x, t.y);
      scene.add(g);
      gates.push({ i, lat, x, z: zz, phase: n / 3, mesh: g, base: g.position.y });
    });
    // Slots in the road the pistons rise out of.
    zones.push({ type: 'gates', i0: i - 4, i1: i + 4, lat: [-8, 8] });
  }
  movers.push((time) => {
    for (const g of gates) g.mesh.position.y = g.base - 2.6 * (1 - gateHeight(g, time));
  });

  return { zones, decals, gates, animate: (t) => movers.forEach((f) => f(t)) };
}

function buildScenery(scene, track, reserved = []) {
  const rand = rng(7);
  const chipMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.45, metalness: 0.3 });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.3, metalness: 0.9 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x1b2f6e, roughness: 0.4, metalness: 0.2 });
  const capTopMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.9 });
  const ledColors = [0xff3048, 0x3dff7a, 0x3d9bff, 0xffc23d];
  const ledMats = ledColors.map((c) => new THREE.MeshBasicMaterial({ color: c }));
  const clear = (x, z, r) => Math.abs(locate(track, x, z).lat) > TRACK_W / 2 + r;

  const pins = [];
  const placed = [...reserved];
  const free = (x, z, r) => placed.every(([px, pz, pr]) => Math.hypot(px - x, pz - z) > pr + r);

  // The big chip in the infield carries the branch name.
  const label = canvasTexture(1024, 512, (g, w, h) => {
    g.fillStyle = '#15171c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#d8dde6';
    g.textAlign = 'center';
    g.font = '900 150px "Arial Black", Arial, sans-serif';
    g.fillText('IEEE', w / 2, 210);
    g.font = '700 82px Arial, sans-serif';
    g.fillText('ComSoc AUS', w / 2, 330);
    g.font = '500 44px Arial, sans-serif';
    g.globalAlpha = 0.6;
    g.fillText('JK-2026 · 2.4 GHz', w / 2, 420);
    g.beginPath();
    g.arc(90, 90, 26, 0, Math.PI * 2);
    g.fill();
  });
  const bigMats = [chipMat, chipMat, new THREE.MeshStandardMaterial({ map: label, roughness: 0.5 }), chipMat, chipMat, chipMat];
  const addChip = (x, z, w, d, rot, mats = chipMat) => {
    const chip = new THREE.Mesh(new THREE.BoxGeometry(w, 1.4, d), mats);
    chip.position.set(x, 0.7, z);
    chip.rotation.y = rot;
    scene.add(chip);
    for (const side of [-1, 1]) {
      for (let k = 0; k < Math.floor(w / 1.6); k++) {
        const px = -w / 2 + 0.8 + k * 1.6;
        pins.push([x, z, rot, px, side * (d / 2 + 0.5), 0.5, 0.25, 1.0]);
      }
      for (let k = 0; k < Math.floor(d / 1.6); k++) {
        const pz = -d / 2 + 0.8 + k * 1.6;
        pins.push([x, z, rot, side * (w / 2 + 0.5), pz, 1.0, 0.25, 0.5]);
      }
    }
    placed.push([x, z, Math.hypot(w, d) / 2 + 1]);
  };
  addChip(13, -80, 34, 17, 0.15, bigMats);

  for (let n = 0; n < 600 && placed.length < 70; n++) {
    const x = -270 + rand() * 540;
    const z = -310 + rand() * 430;
    const kind = rand();
    if (kind < 0.45) {
      const w = 6 + Math.floor(rand() * 4) * 2;
      const d = 6 + Math.floor(rand() * 3) * 2;
      const r = Math.hypot(w, d) / 2 + 1;
      if (clear(x, z, r + 3) && free(x, z, r)) addChip(x, z, w, d, Math.round(rand() * 4) * (Math.PI / 2));
    } else if (kind < 0.8) {
      const h = 2 + rand() * 3;
      if (!clear(x, z, 5) || !free(x, z, 2.5)) continue;
      const can = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, h, 20), capMat);
      can.position.set(x, h / 2, z);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.15, 20), capTopMat);
      top.position.set(x, h + 0.05, z);
      scene.add(can, top);
      placed.push([x, z, 2.5]);
    } else {
      if (!clear(x, z, 3) || !free(x, z, 1.5)) continue;
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), ledMats[Math.floor(rand() * ledMats.length)]);
      led.position.set(x, 0.55, z);
      scene.add(led);
      placed.push([x, z, 1.5]);
    }
  }

  const pinMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), pinMat, pins.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  pins.forEach(([x, z, rot, px, pz, sx, sy, sz], i) => {
    q.setFromAxisAngle(up, rot);
    const off = new THREE.Vector3(px, 0.2, pz).applyQuaternion(q);
    m.compose(new THREE.Vector3(x + off.x, off.y, z + off.z), q, new THREE.Vector3(sx, sy, sz));
    pinMesh.setMatrixAt(i, m);
  });
  scene.add(pinMesh);
  return ledMats.map((mat, i) => ({ mat, base: new THREE.Color(ledColors[i]), phase: i * 1.7 }));
}

// Start/finish arch over the line.
function buildGantry(scene, track) {
  const p = track.pts[0];
  const s = track.side[0];
  const t = track.tan[0];
  const postMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.4, metalness: 0.6 });
  const span = TRACK_W + 3;
  for (const k of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7, 0.8), postMat);
    post.position.set(p.x + (s.x * span * k) / 2, 3.5, p.y + (s.y * span * k) / 2);
    scene.add(post);
  }
  const sign = canvasTexture(1024, 128, (g, w, h) => {
    g.fillStyle = '#05080a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#9dff3a';
    g.shadowColor = '#9dff3a';
    g.shadowBlur = 18;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 78px "Arial Black", Arial, sans-serif';
    g.fillText('IEEE FEST  ·  JAM KART', w / 2, h / 2 + 4);
  });
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(span + 0.8, 2.2, 0.5),
    [postMat, postMat, postMat, postMat, new THREE.MeshBasicMaterial({ map: sign, color: 0x8a8a8a }), new THREE.MeshBasicMaterial({ map: sign, color: 0x8a8a8a })]
  );
  beam.position.set(p.x, 7.6, p.y);
  beam.rotation.y = Math.atan2(t.x, t.y);
  scene.add(beam);
}
