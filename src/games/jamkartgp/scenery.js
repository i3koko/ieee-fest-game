import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK_W, LAKE, lakeEdge, canvasTexture } from './track.js';

// The countryside round the GP circuit: a mixed forest (pines, birches and
// autumn broadleaves), grass tufts and wild flowers beyond the verges, rocks
// on the hills, and a lake with reeds, a jetty and a rowing boat. Trees,
// grass, flowers and reeds sway in the wind, harder when the storm comes.

// Shared by every swaying material: the clock and the wind strength.
const wind = { uTime: { value: 0 }, uWind: { value: 1 } };

// Adds a sway to a material: vertices bend sideways in proportion to their
// height above `base`, each instance with its own phase.
function sway(mat, { base = 0, amount = 0.02, speed = 1.6 } = {}) {
  // Each sway setting compiles its own shader.
  mat.customProgramCacheKey = () => `sway ${base} ${amount} ${speed}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec2 at = instanceMatrix[3].xz;
          float ph = at.x * 0.37 + at.y * 0.21;
          float bend = max(position.y - ${base.toFixed(2)}, 0.0);
          float gust = sin(uTime * ${speed.toFixed(2)} * (0.8 + 0.4 * uWind) + ph) + 0.4 * sin(uTime * 3.7 + ph * 2.0);
          transformed.x += gust * bend * bend * ${amount.toFixed(4)} * uWind;
          transformed.z += gust * bend * bend * ${(amount * 0.5).toFixed(4)} * uWind;
        }`
      );
  };
  return mat;
}

// Fills an InstancedMesh from a list of { x, y, z, s, sy?, rot?, color? }.
function instances(scene, geo, mat, list, { shadow = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  list.forEach((o, n) => {
    q.setFromAxisAngle(up, o.rot ?? 0);
    m.compose(new THREE.Vector3(o.x, o.y, o.z), q, new THREE.Vector3(o.s, o.sy ?? o.s, o.s));
    mesh.setMatrixAt(n, m);
    if (o.color !== undefined) mesh.setColorAt(n, c.set(o.color));
  });
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// Colours a geometry with a vertical gradient (for grass and reeds).
function gradient(geo, bottom, top, h) {
  const a = new THREE.Color(bottom);
  const b = new THREE.Color(top);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    c.copy(a).lerp(b, Math.min(pos.getY(k) / h, 1));
    c.toArray(col, k * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// A tuft of blades: thin triangles fanned round in a circle.
function bladeTuft(blades, height, spread, width) {
  const pos = [];
  for (let n = 0; n < blades; n++) {
    const a = (n / blades) * Math.PI * 2 + n;
    const lean = spread * (0.5 + ((n * 7) % 5) / 8);
    const h = height * (0.7 + ((n * 3) % 4) / 10);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const px = -dz * width;
    const pz = dx * width;
    pos.push(-px, 0, -pz, px, 0, pz, dx * lean, h, dz * lean);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // Light from above, not from the blade's facing, so tufts don't flicker.
  const nrm = geo.attributes.normal;
  for (let k = 0; k < nrm.count; k++) nrm.setXYZ(k, 0, 1, 0);
  return geo;
}

export function buildScenery(scene, track, terrainY, { trackDist, free, rand }) {
  const near = (x, z) => trackDist(x, z) - TRACK_W / 2;
  const dry = (x, z, margin = 2) => lakeEdge(x, z) > margin;
  // Scatters up to `count` spots in the box, keeping those `ok` accepts.
  const scatter = (count, tries, box, ok) => {
    const out = [];
    for (let n = 0; n < tries && out.length < count; n++) {
      const x = box[0] + rand() * (box[1] - box[0]);
      const z = box[2] + rand() * (box[3] - box[2]);
      if (ok(x, z)) out.push([x, z]);
    }
    return out;
  };
  const MAP = [-240, 380, -300, 380];

  buildForest(scene, terrainY, rand, scatter, near, free, dry, MAP);
  const meadows = buildMeadows(scene, terrainY, rand, scatter, near, free, dry);
  buildRocks(scene, terrainY, rand, scatter, near, free, dry, MAP);
  const lake = buildLake(scene, terrainY, rand);

  return {
    update(t) {
      wind.uTime.value = t;
      lake.update(t);
    },
    // Graphics tier: the share of grass tufts and flowers drawn (0..1).
    setMeadows(f) {
      for (const m of meadows) {
        m.count = Math.floor(m.userData.total * f);
        m.visible = m.count > 0;
      }
    },
    setWind(w) {
      wind.uWind.value = w;
      lake.setRain(Math.max(0, w - 1) / 2.5);
    },
  };
}

// ------------------------------------------------------------------ forest

// Dense Ardennes-style pine forest on the hills, birches near the clearings
// and broadleaves turning gold, orange and red for the autumn.
function buildForest(scene, terrainY, rand, scatter, near, free, dry, box) {
  const spots = scatter(1700, 10000, box, (x, z) => {
    const d = near(x, z);
    if (d < 22 || !free(x, z, 4) || !dry(x, z, 4)) return false;
    // Thin out the trees near the track so the run-off stays open.
    return !(d < 34 && rand() < 0.6);
  });
  const pines = [];
  const broad = [];
  const birch = [];
  for (const [x, z] of spots) {
    const s = 0.8 + rand() * 0.9;
    const o = { x, y: terrainY(x, z) - 0.2, z, s, sy: s * (0.9 + rand() * 0.3), rot: rand() * 6.28 };
    const r = rand();
    // More birches and broadleaves where the forest meets the circuit.
    const edge = near(x, z) < 70 ? 0.2 : 0;
    if (r < 0.12 + edge) birch.push(o);
    else if (r < 0.3 + edge * 1.5) broad.push(o);
    else pines.push(o);
  }
  const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(0.8 + rand() * k);
  const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true, ...extra });

  // Pines: trunk and two cones.
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 6).translate(0, 1.5, 0);
  const pineTop = mergeGeometries([
    new THREE.ConeGeometry(2.6, 6.5, 8).translate(0, 5.5, 0),
    new THREE.ConeGeometry(1.8, 4.5, 8).translate(0, 8.5, 0),
  ]);
  instances(scene, trunk, flat(0x5a3c22), [...pines, ...broad], { shadow: true });
  instances(scene, pineTop, sway(flat(0xffffff), { base: 2, amount: 0.0012 }), pines.map((o) => ({ ...o, color: shade(0x2f6b34, 0.4) })), { shadow: true });

  // Broadleaves: a clump of three rough balls, in autumn colours.
  const canopy = mergeGeometries([
    new THREE.IcosahedronGeometry(2.6, 0).translate(0, 5.2, 0),
    new THREE.IcosahedronGeometry(2, 0).translate(1.6, 4.3, 0.6),
    new THREE.IcosahedronGeometry(1.9, 0).translate(-1.3, 4.6, -0.9),
  ]);
  const AUTUMN = [0x5a9a3c, 0x7da23a, 0xc9a227, 0xd9822b, 0xb8432a, 0x6f9440];
  instances(
    scene,
    canopy,
    sway(flat(0xffffff), { base: 2.5, amount: 0.002 }),
    broad.map((o) => ({ ...o, color: shade(AUTUMN[Math.floor(rand() * AUTUMN.length)], 0.3) })),
    { shadow: true }
  );

  // Birches: slim white trunks and light, airy yellow-green crowns.
  const birchTrunk = new THREE.CylinderGeometry(0.14, 0.2, 7, 6).translate(0, 3.5, 0);
  const birchTop = mergeGeometries([
    new THREE.IcosahedronGeometry(1.6, 0).scale(1, 1.6, 1).translate(0, 7, 0),
    new THREE.IcosahedronGeometry(1.2, 0).scale(1, 1.4, 1).translate(0.5, 5.4, 0.3),
  ]);
  instances(scene, birchTrunk, sway(flat(0xe8e4dc), { base: 1, amount: 0.0008 }), birch, { shadow: true });
  instances(scene, birchTop, sway(flat(0xffffff), { base: 1, amount: 0.0008 }), birch.map((o) => ({ ...o, color: shade(rand() < 0.4 ? 0xd2c045 : 0x9cbf4a, 0.3) })), {
    shadow: true,
  });
}

// ------------------------------------------------------------------ meadows

// Long grass tufts and patches of wild flowers beyond the verges.
function buildMeadows(scene, terrainY, rand, scatter, near, free, dry) {
  const box = [-120, 240, -200, 260];
  const tufts = scatter(5500, 40000, box, (x, z) => {
    const d = near(x, z);
    // Thick just past the run-off, thinning out into the hills.
    return d > 11 && rand() < 1.3 - d / 60 && free(x, z, 1) && dry(x, z, 1);
  }).map(([x, z]) => ({ x, y: terrainY(x, z) - 0.05, z, s: 0.7 + rand() * 0.7, rot: rand() * 6.28 }));
  const tuftGeo = gradient(bladeTuft(7, 0.9, 0.35, 0.06), 0x2c4a1c, 0x9cbf5a, 0.9);
  const tuftMat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }), { amount: 0.08, speed: 2.2 });
  const meshes = [instances(scene, tuftGeo, tuftMat, tufts)];

  // Flowers grow in patches: pick patch centres, then sprinkle round them.
  const COLORS = [0xffffff, 0xf5d90a, 0xe8493f, 0xb57edc, 0xffffff, 0xf29fc5];
  const centres = scatter(70, 3000, box, (x, z) => {
    const d = near(x, z);
    return d > 13 && d < 55 && free(x, z, 3) && dry(x, z, 3);
  });
  const flowers = COLORS.map(() => []);
  for (const [cx, cz] of centres) {
    const color = Math.floor(rand() * COLORS.length);
    const n = 30 + Math.floor(rand() * 40);
    for (let k = 0; k < n; k++) {
      const a = rand() * 6.28;
      const r = Math.sqrt(rand()) * 6;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (near(x, z) < 11) continue;
      flowers[color].push({ x, y: terrainY(x, z) - 0.05, z, s: 0.8 + rand() * 0.5, rot: rand() * 6.28 });
    }
  }
  const stem = new THREE.CylinderGeometry(0.008, 0.008, 0.36, 3).translate(0, 0.18, 0);
  const head = new THREE.CircleGeometry(0.13, 5).rotateX(-Math.PI / 2 + 0.3).translate(0, 0.37, 0);
  const centre = new THREE.CircleGeometry(0.045, 5).rotateX(-Math.PI / 2 + 0.3).translate(0, 0.375, 0.004);
  // One mesh per petal colour: green stems, coloured petals, yellow centres.
  const paint = (geo, hex) => {
    const c = new THREE.Color(hex);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: geo.attributes.position.count }, () => [c.r, c.g, c.b]).flat(), 3));
    return geo;
  };
  const flowerMat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }), { amount: 0.35, speed: 2 });
  COLORS.forEach((hex, n) => {
    if (!flowers[n].length) return;
    const geo = mergeGeometries([paint(stem.clone(), 0x4f8a35), paint(head.clone(), hex), paint(centre.clone(), 0xf2c200)].map((g) => g.toNonIndexed()));
    meshes.push(instances(scene, geo, flowerMat, flowers[n]));
  });
  // The scatter order is random, so drawing only the first part of each
  // list thins them out evenly.
  for (const m of meshes) m.userData.total = m.count;
  return meshes;
}

// ------------------------------------------------------------------ rocks

function buildRocks(scene, terrainY, rand, scatter, near, free, dry, box) {
  // A few lumpy rock shapes, picked per rock.
  const shapes = [0, 1, 2].map((v) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k);
      const y = p.getY(k);
      const z = p.getZ(k);
      const n = 0.75 + 0.35 * Math.abs(Math.sin(x * 3.1 + v * 2 + z * 1.7) * Math.cos(y * 2.3 - v));
      p.setXYZ(k, x * n * 1.3, Math.max(y * n * 0.75, -0.3), z * n);
    }
    g.computeVertexNormals();
    return g;
  });
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const groups = [[], [], []];
  // Rocks lie in little clusters.
  for (const [cx, cz] of scatter(60, 2000, box, (x, z) => near(x, z) > 16 && free(x, z, 4) && dry(x, z, 2))) {
    const n = 1 + Math.floor(rand() * 5);
    for (let k = 0; k < n; k++) {
      const x = cx + (rand() - 0.5) * 6;
      const z = cz + (rand() - 0.5) * 6;
      if (near(x, z) < 14) continue;
      const s = (k === 0 ? 1.4 : 0.5) + rand() * 1.1;
      const grey = 0.16 + rand() * 0.12;
      groups[Math.floor(rand() * 3)].push({ x, y: terrainY(x, z) - 0.15 * s, z, s, rot: rand() * 6.28, color: new THREE.Color(grey, grey * 0.97, grey * 0.92) });
    }
  }
  groups.forEach((list, v) => list.length && instances(scene, shapes[v], mat, list, { shadow: true }));
}

// ------------------------------------------------------------------ lake

function buildLake(scene, terrainY, rand) {
  const { x: lx, z: lz, r, level } = LAKE;
  // Ripples drawn into a normal map, scrolled two ways in the shader.
  const ripples = canvasTexture(256, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = (x / w) * Math.PI * 2;
        const b = (y / h) * Math.PI * 2;
        const dx = 0.5 * Math.cos(a * 3 + Math.sin(b * 2)) + 0.3 * Math.cos(a * 7 + b * 2);
        const dy = 0.5 * Math.cos(b * 4 + Math.sin(a * 3)) + 0.3 * Math.cos(b * 9 - a * 2);
        const k = (y * w + x) * 4;
        img.data[k] = 128 + dx * 60;
        img.data[k + 1] = 128 + dy * 60;
        img.data[k + 2] = 255;
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
  ripples.wrapS = ripples.wrapT = THREE.RepeatWrapping;
  ripples.repeat.set(10, 10);
  ripples.colorSpace = THREE.NoColorSpace;
  const water = new THREE.MeshStandardMaterial({
    color: 0x1d4a5a,
    roughness: 0.3,
    metalness: 0,
    envMapIntensity: 1.3,
    normalMap: ripples,
    normalScale: new THREE.Vector2(0.25, 0.25),
    transparent: true,
    opacity: 0.88,
  });
  const surface = new THREE.Mesh(new THREE.CircleGeometry(r * 1.45, 64).rotateX(-Math.PI / 2), water);
  surface.position.set(lx, level, lz);
  surface.receiveShadow = true;
  scene.add(surface);

  // Reeds in clumps round the shallows.
  const reeds = [];
  for (let n = 0; n < 900; n++) {
    const a = rand() * 6.28;
    const d = r * (0.7 + rand() * 0.8);
    const x = lx + Math.cos(a) * d;
    const z = lz + Math.sin(a) * d;
    const e = lakeEdge(x, z);
    // Only in a band from a little way out into the water up the bank, and
    // in clumps (the sine) rather than an even ring.
    if (e < -3.5 || e > 1.5 || Math.sin(a * 9) < -0.2) continue;
    reeds.push({ x, y: Math.max(terrainY(x, z), level - 1.5) - 0.05, z, s: 0.8 + rand() * 0.6, rot: rand() * 6.28 });
  }
  const reedGeo = gradient(bladeTuft(9, 2.4, 0.25, 0.04), 0x3a4a22, 0xb5a65a, 2.4);
  const reedMat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }), { amount: 0.03, speed: 1.4 });
  instances(scene, reedGeo, reedMat, reeds);

  // A wooden jetty out from the north bank (the side the track runs past).
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.85 });
  const jetty = new THREE.Group();
  const len = 12;
  for (let k = 0; k < len / 0.5; k++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.42), wood);
    plank.position.set(0, 0.55, -k * 0.5);
    plank.rotation.y = (rand() - 0.5) * 0.04;
    jetty.add(plank);
  }
  for (let k = 0; k <= len; k += 3) {
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3, 6), wood);
      post.position.set(s * 1.05, -0.8, -k);
      jetty.add(post);
    }
  }
  // Find where the north shore is, and run the jetty out over the water.
  const sx = lx + 4;
  let sz = lz + r;
  for (let d = 0; d < r * 2; d += 0.5) {
    if (lakeEdge(sx, lz + d) > 0) {
      sz = lz + d;
      break;
    }
  }
  jetty.position.set(sx, level, sz + 1.5);
  jetty.traverse((o) => o.isMesh && (o.castShadow = o.receiveShadow = true));
  scene.add(jetty);

  // A rowing boat tied up at the end of it.
  const boat = new THREE.Group();
  const hullShape = new THREE.Shape();
  hullShape.moveTo(0, -2);
  hullShape.quadraticCurveTo(0.95, -1.2, 0.85, 1.4);
  hullShape.lineTo(-0.85, 1.4);
  hullShape.quadraticCurveTo(-0.95, -1.2, 0, -2);
  const hull = new THREE.Mesh(
    new THREE.ExtrudeGeometry(hullShape, { depth: 0.5, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ color: 0xc9442f, roughness: 0.6 })
  );
  // The hull is solid, so the wooden boards are laid just over its top.
  const inside = new THREE.Mesh(
    new THREE.ShapeGeometry(hullShape).rotateX(Math.PI / 2).scale(0.82, 1, 0.85).translate(0, 0.51, 0),
    new THREE.MeshStandardMaterial({ color: 0x9a7650, roughness: 0.9, side: THREE.DoubleSide })
  );
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.3), inside.material);
  seat.position.y = 0.66;
  boat.add(hull, inside, seat);
  boat.traverse((o) => o.isMesh && (o.castShadow = true));
  boat.position.set(sx + 2.4, level - 0.22, sz - len + 3);
  boat.rotation.y = 0.15;
  scene.add(boat);

  let rain = 0;
  return {
    setRain(v) {
      rain = v;
    },
    update(t) {
      // Ripples drift with the breeze; rain roughens the water.
      ripples.offset.set(t * 0.012, t * 0.007);
      water.normalScale.setScalar(0.25 + rain * 0.25);
      water.roughness = 0.3 + rain * 0.15;
      boat.position.y = level - 0.22 + Math.sin(t * 1.3) * 0.04;
      boat.rotation.z = Math.sin(t * 0.9) * 0.03;
    },
  };
}
