import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The three karts (modelled in tools/build_karts.py) and how each one drives.
// Stats are 1-5 for the select screen; the numbers below them are the physics.
export const MODELS = [
  {
    id: 'fiber', name: 'FIBER', file: 'kart-fiber.glb',
    blurb: 'Light through glass: the fastest kart, but it takes wide turns.',
    perk: 'Compression boost lasts 50% longer',
    stats: { SPEED: 5, HANDLING: 2, ACCEL: 3, WEIGHT: 2 },
    top: 47, turn: 2.0, accel: 25, mass: 1, grip: 13, boost: 1.5, recover: 1, jamRange: 1,
  },
  {
    id: '5g', name: '5G', file: 'kart-5g.glb',
    blurb: 'Small and nimble: sharp turns and the quickest start.',
    perk: 'Shakes off jams and spins 40% faster',
    stats: { SPEED: 3, HANDLING: 5, ACCEL: 5, WEIGHT: 1 },
    top: 43, turn: 2.75, accel: 32, mass: 0.8, grip: 18, boost: 1, recover: 0.6, jamRange: 1,
  },
  {
    id: 'satellite', name: 'SATELLITE', file: 'kart-satellite.glb',
    blurb: 'Heavy and steady: slow to get going, but it wins every shove.',
    perk: 'Its jammer reaches 1.6× further',
    stats: { SPEED: 4, HANDLING: 3, ACCEL: 2, WEIGHT: 5 },
    top: 45, turn: 2.2, accel: 21, mass: 1.8, grip: 15, boost: 1, recover: 1, jamRange: 1.6,
  },
  {
    id: 'radio', name: 'RADIO', file: 'kart-radio.glb',
    blurb: 'A classic all-rounder with a whip antenna: good at everything.',
    perk: 'Carries two power-ups at once',
    stats: { SPEED: 3, HANDLING: 3, ACCEL: 3, WEIGHT: 3 },
    top: 44.5, turn: 2.35, accel: 27, mass: 1.2, grip: 15, boost: 1, recover: 1, jamRange: 1, slots: 2,
  },
  {
    id: 'laser', name: 'LASER', file: 'kart-laser.glb',
    blurb: 'A beam of light on wheels: quick and light, but slippery.',
    perk: 'Drift boosts charge 50% faster',
    stats: { SPEED: 4, HANDLING: 4, ACCEL: 4, WEIGHT: 1 },
    top: 45.5, turn: 2.45, accel: 29, mass: 0.75, grip: 11, boost: 1, recover: 1, jamRange: 1, driftRate: 1.5,
  },
];

export const PALETTE = [0x3df5ff, 0xff9a1f, 0xff3fd2, 0x9dff3a, 0xffe03d, 0xff3b4a, 0xf4f6ff, 0x8a7dff];

const templates = {};

// Loads every kart model once, before the game starts. A model that fails to
// load falls back to the simple built-in kart.
export async function loadKarts() {
  const loader = new GLTFLoader();
  await Promise.all(
    MODELS.map(async (m) => {
      try {
        templates[m.id] = (await loader.loadAsync(`${import.meta.env.BASE_URL}models/${m.file}`)).scene;
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
      // Polished metal mirrors the lights into a bloom blob; dull it a little.
      if (/^Metal/.test(c.name)) {
        c.roughness = 0.55;
        c.color.multiplyScalar(0.6);
      }
      const inWheel = o.name.startsWith('Wheel') || o.parent?.name.startsWith('Wheel');
      if (/^Glow/.test(c.name)) (inWheel ? hubs : glow).push(c);
      return c;
    });
    if (o.material.length === 1) o.material = o.material[0];
  });

  // In daylight the kart casts a soft contact shadow instead of a neon glow.
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
    group, body, wheels, under, flame, shield,
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
