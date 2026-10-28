import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The karts (modelled in tools/build_karts.py) and how each one drives.
// Stats are 1-5 for the select screen; the numbers below them are the physics,
// in metres and seconds: top speeds of ~103-112 km/h, like a fast race kart.
export const MODELS = [
  {
    id: 'fiber', name: 'FIBER', file: 'kart-fiber.glb',
    blurb: 'Light through glass: the fastest kart, but it takes wide turns.',
    perk: 'Compression boost lasts 50% longer',
    stats: { SPEED: 5, HANDLING: 2, ACCEL: 3, WEIGHT: 2 },
    top: 31, turn: 2.0, accel: 17, mass: 1, grip: 13, boost: 1.5, recover: 1, jamRange: 1,
  },
  {
    id: '5g', name: '5G', file: 'kart-5g.glb',
    blurb: 'Small and nimble: sharp turns and the quickest start.',
    perk: 'Shakes off jams and spins 40% faster',
    stats: { SPEED: 3, HANDLING: 5, ACCEL: 5, WEIGHT: 1 },
    top: 28.5, turn: 2.75, accel: 22, mass: 0.8, grip: 18, boost: 1, recover: 0.6, jamRange: 1,
  },
  {
    id: 'satellite', name: 'SATELLITE', file: 'kart-satellite.glb',
    blurb: 'Heavy and steady: slow to get going, but it wins every shove.',
    perk: 'Its jammer reaches 1.6× further',
    stats: { SPEED: 4, HANDLING: 3, ACCEL: 2, WEIGHT: 5 },
    top: 29.5, turn: 2.2, accel: 14.5, mass: 1.8, grip: 15, boost: 1, recover: 1, jamRange: 1.6,
  },
  {
    id: 'radio', name: 'RADIO', file: 'kart-radio.glb',
    blurb: 'A classic all-rounder with a whip antenna: good at everything.',
    perk: 'Carries two power-ups at once',
    stats: { SPEED: 3, HANDLING: 3, ACCEL: 3, WEIGHT: 3 },
    top: 29.5, turn: 2.35, accel: 18.5, mass: 1.2, grip: 15, boost: 1, recover: 1, jamRange: 1, slots: 2,
  },
  {
    id: 'laser', name: 'LASER', file: 'kart-laser.glb',
    blurb: 'A beam of light on wheels: quick and light, cuts corners over the grass.',
    perk: 'Loses far less speed on the grass',
    stats: { SPEED: 4, HANDLING: 4, ACCEL: 4, WEIGHT: 1 },
    top: 30, turn: 2.45, accel: 20, mass: 0.75, grip: 11, boost: 1, recover: 1, jamRange: 1, offroad: 0.85,
  },
];

export const PALETTE = [0x3df5ff, 0xff9a1f, 0xff3fd2, 0x9dff3a, 0xffe03d, 0xff3b4a, 0xf4f6ff, 0x8a7dff];

const templates = {};
const clearances = {}; // per model: how far the body may drop over a wheel

// Measures the smallest gap between each tyre and the body around it: rays
// straight up from the tyre (for broad surfaces above it) and the distance
// from the tyre to every nearby body vertex in any direction (for parts
// beside it, like sidepods, that swing in when the body rolls). Cached.
function measureClearance(modelId, body, wheels, group) {
  if (clearances[modelId]) return clearances[modelId];
  group.updateMatrixWorld(true);
  const meshes = [];
  body.traverse((o) => o.isMesh && meshes.push(o));
  const ray = new THREE.Raycaster();
  const spots = [];
  let gap = 0.3;
  const v = new THREE.Vector3();
  for (const w of wheels) {
    const box = new THREE.Box3().setFromObject(w);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = size.y / 2;
    const halfW = size.x / 2;
    spots.push({ x: c.x, y: c.y + r, z: c.z });
    for (const m of meshes) {
      const pos = m.geometry.attributes.position;
      for (let n = 0; n < pos.count; n++) {
        v.fromBufferAttribute(pos, n).applyMatrix4(m.matrixWorld);
        const dx = Math.abs(v.x - c.x) - halfW;
        const dr = Math.hypot(v.y - c.y, v.z - c.z) - r;
        if (dx > 0.5 || dr > 0.5) continue;
        gap = Math.min(gap, dx <= 0 && dr <= 0 ? 0 : Math.hypot(Math.max(dx, 0), Math.max(dr, 0)));
      }
    }
    for (let ix = 0; ix <= 4; ix++) {
      for (let iz = -3; iz <= 3; iz++) {
        const dz = (iz / 3) * r * 0.85;
        const top = c.y + Math.sqrt(Math.max(r * r - dz * dz, 0));
        ray.set(new THREE.Vector3(box.min.x + (size.x * ix) / 4, top - 0.005, c.z + dz), new THREE.Vector3(0, 1, 0));
        const hit = ray.intersectObjects(meshes, false)[0];
        if (hit) gap = Math.min(gap, hit.distance);
      }
    }
  }
  clearances[modelId] = { gap, spots };
  return clearances[modelId];
}

// Keeps the suspension inside the wheel arches: works out how far the body
// around each wheel would move (heave, plus the swing from pitch and roll,
// which grows with distance from the body's pivot) and scales the motion down
// if it would close the gap to any tyre. Used by the game and its tests.
export function limitSuspension(parts, s) {
  const room = Math.max(0.01, parts.clearance.gap - 0.025);
  let worst = 0;
  for (const { x, y, z } of parts.clearance.spots) {
    worst = Math.max(worst, Math.abs(s.y) + Math.abs(s.pitch) * Math.hypot(z, y) + Math.abs(s.roll) * Math.hypot(x, y));
  }
  if (worst <= room) return;
  const f = room / worst;
  s.y *= f;
  s.pitch *= f;
  s.roll *= f;
  s.vy *= f;
  s.pv *= f;
  s.rv *= f;
}

// Loads every kart model once, before the game starts. A model that fails to
// load falls back to the simple built-in kart.
export async function loadKarts() {
  const loader = new GLTFLoader();
  await Promise.all(
    MODELS.map(async (m) => {
      try {
        // GP's karts have wheel arches carved for the suspension (tools/build_karts.py --arches).
        templates[m.id] = (await loader.loadAsync(`${import.meta.env.BASE_URL}models/gp/${m.file}`)).scene;
      } catch (e) {
        console.warn(`Jam Kart: could not load ${m.file}, using the fallback kart`, e);
      }
    })
  );
}

let glowTex;
// Soft round falloff for the underglow (shared by every kart).
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

// Simple box kart, used only if a model file is missing.
function fallbackBody() {
  const body = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ name: 'Paint', roughness: 0.35, metalness: 0.4 });
  const glow = new THREE.MeshStandardMaterial({ name: 'Glow', color: 0x050505 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    body.add(m);
  };
  add(new THREE.BoxGeometry(2.2, 0.45, 3.4), paint, 0, 0.55, 0);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.12, 0.14, 3.1), glow, s * 1.12, 0.62, 0);
  add(new THREE.SphereGeometry(0.45, 16, 12), paint, 0, 1.1, -0.3);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.8 });
  const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.42, 16).rotateZ(Math.PI / 2);
  for (const [x, z] of [[-1.2, 1.15], [1.2, 1.15], [-1.2, -1.15], [1.2, -1.15]]) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.name = 'Wheel';
    w.position.set(x, 0.46, z);
    body.add(w);
  }
  return body;
}

// A kart ready for the scene: the model, an underglow, a boost flame and a
// shield bubble. setColor() repaints it (the select screen uses this).
export function makeKart(modelId, color) {
  const group = new THREE.Group();
  const template = templates[modelId];
  const body = template ? template.clone(true) : fallbackBody();
  group.add(body);

  const paint = [];
  const glow = [];
  const hubs = []; // glowing wheel hubs, kept dimmer so they don't bloom into orbs
  const wheels = [];
  body.traverse((o) => {
    // A multi-material wheel arrives as a group of meshes: spin only the group.
    if (o.name.startsWith('Wheel') && !o.parent?.name.startsWith('Wheel')) wheels.push(o);
    if (!o.isMesh) return;
    o.material = [].concat(o.material).map((m) => {
      const c = m.clone();
      if (/^Paint/.test(c.name)) paint.push(c);
      const inWheel = o.name.startsWith('Wheel') || o.parent?.name.startsWith('Wheel');
      // Big polished metal (the dish) mirrors the lights into a bloom blob,
      // so dull it; rims stay bright so you can see them spin.
      if (/^Metal/.test(c.name)) {
        c.roughness = inWheel ? 0.35 : 0.55;
        c.color.multiplyScalar(inWheel ? 1.1 : 0.6);
        // With no reflections in the scene, fully metallic rims render black.
        if (inWheel) c.metalness = 0.3;
      }
      if (/^Glow/.test(c.name)) (inWheel ? hubs : glow).push(c);
      return c;
    });
    if (o.material.length === 1) o.material = o.material[0];
  });

  // In daylight the kart casts a soft contact shadow instead of a neon glow.
  // Wheels hang off the kart itself, not the body, so the body can ride on
  // its suspension while the wheels stay planted. Front wheels sit on a
  // steering pivot; every wheel spins by its own radius.
  for (const w of wheels) group.attach(w);
  const clearance = measureClearance(modelId, body, wheels, group);
  body.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  for (const w of wheels) w.traverse((o) => o.isMesh && (o.castShadow = true));
  const steer = [];
  for (const w of wheels) {
    w.userData.radius = new THREE.Box3().setFromObject(w).getSize(new THREE.Vector3()).y / 2;
    if (!/F[LR]/.test(w.name)) continue;
    const pivot = new THREE.Object3D();
    pivot.position.copy(w.position);
    group.add(pivot);
    pivot.attach(w);
    steer.push(pivot);
  }

  const under = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 5.2),
    new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false })
  );
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.06;
  group.add(under);

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.35, 1.6, 10),
    new THREE.MeshBasicMaterial({ color: 0x9dff3a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  flame.rotation.x = -Math.PI / 2;
  flame.position.set(0, 0.7, -2.5);
  flame.visible = false;
  group.add(flame);

  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(2.9, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true })
  );
  shield.position.y = 1.1;
  shield.visible = false;
  group.add(shield);

  const parts = {
    group, body, wheels, steer, under, flame, shield, clearance,
    setColor(hex) {
      for (const m of paint) m.color.setHex(hex);
      for (const m of glow) {
        m.emissive.setHex(hex);
        m.emissiveIntensity = 1.8;
      }
      for (const m of hubs) {
        m.emissive.setHex(hex);
        m.emissiveIntensity = 0.35;
      }

    },
  };
  parts.setColor(color);
  return parts;
}
