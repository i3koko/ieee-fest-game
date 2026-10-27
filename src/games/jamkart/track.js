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
  return { pts, tan, side, dist, length };
}

const wrap = (i) => ((i % SAMPLES) + SAMPLES) % SAMPLES;

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

// A strip following the track at a sideways offset (a road or a wall).
function strip(track, latA, latB, yA, yB, vScale) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const k = i % SAMPLES;
    const p = track.pts[k];
    const s = track.side[k];
    const v = i === SAMPLES ? track.length : track.dist[k];
    pos.push(p.x + s.x * latA, yA, p.y + s.y * latA, p.x + s.x * latB, yB, p.y + s.y * latB);
    uv.push(0, v * vScale, 1, v * vScale);
    if (i < SAMPLES) {
      const a = i * 2;
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

  // Glowing rails along both edges.
  const railMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xffa030).multiplyScalar(0.7),
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const s of [1, -1]) {
    const lat = s * (TRACK_W / 2 + 0.2);
    scene.add(new THREE.Mesh(strip(track, lat, lat, 0, 0.9, 1), railMat));
  }

  const lights = buildScenery(scene, track);
  buildGantry(scene, track);
  return { trackMat, lights };
}

function buildScenery(scene, track) {
  const rand = rng(7);
  const chipMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.45, metalness: 0.3 });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.3, metalness: 0.9 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x1b2f6e, roughness: 0.4, metalness: 0.2 });
  const capTopMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.9 });
  const ledColors = [0xff3048, 0x3dff7a, 0x3d9bff, 0xffc23d];
  const ledMats = ledColors.map((c) => new THREE.MeshBasicMaterial({ color: c }));
  const clear = (x, z, r) => Math.abs(locate(track, x, z).lat) > TRACK_W / 2 + r;

  const pins = [];
  const placed = [];
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
