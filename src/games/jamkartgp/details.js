import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildScenery } from './scenery.js';
import { litByHeadlights } from './headlights.js';
import { TRACK_W, SAMPLES, HAZARDS, sampleAt, surfaceY, vergeY, locate, canvasTexture, rng, strip, bandStrip, vergeLats } from './track.js';

// Everything around the GP circuit that makes it a racetrack: sky, kerbs,
// gravel traps, armco, grandstands with a crowd, the pit building,
// start lights, a bridge, billboards, TV towers and comms kit (dishes and a
// cell tower). The buildings are Blender models from tools/build_track_props.py.
const PROPS = ['grandstand', 'pits', 'start', 'bridge', 'camera', 'dish'];
const props = {};

// The official IEEE ComSoc logo (white), used on banners and billboards.
let comsocLogo = null;

export async function loadProps() {
  const loader = new GLTFLoader();
  const logo = new Image();
  logo.src = `${import.meta.env.BASE_URL}brand/comsoc-white.png`;
  await logo.decode().then(() => (comsocLogo = logo)).catch(() => console.warn('Jam Kart GP: ComSoc logo missing'));
  await Promise.all(
    PROPS.map(async (name) => {
      try {
        props[name] = (await loader.loadAsync(`${import.meta.env.BASE_URL}models/gp/${name}.glb`)).scene;
      } catch (e) {
        console.warn(`Jam Kart GP: could not load prop ${name}`, e);
      }
    })
  );
}

// 'LOGO' panels show the ComSoc logo on IEEE blue.
const SPONSORS = [
  ['LOGO', '', '#00629b', '#ffffff'],
  ['IEEE', 'ComSoc AUS', '#00629b', '#ffffff'],
  ['IEEE FEST', '2026', '#111418', '#ff4a3d'],
  ['5G NR', 'faster than your kart', '#ffffff', '#00629b'],
  ['Wi-Fi 7', '46 Gbit/s', '#7a1fa2', '#ffffff'],
  ['SIGNAL', 'strength: full bars', '#ffcc00', '#111418'],
  ['FIBRE', 'light speed data', '#111418', '#9dff3a'],
  ['ComSoc', 'Communications Society', '#ffffff', '#ff4a3d'],
  ['AUS', 'IEEE Student Branch', '#8a1538', '#ffffff'],
];

// Draws one sponsor into a w x h panel at (x, 0), never stretched: text is
// sized to fit, and the logo keeps its proportions.
function drawSponsor(g, [title, sub, bg, fg], x, w, h) {
  g.fillStyle = bg;
  g.fillRect(x, 0, w, h);
  if (title === 'LOGO' && comsocLogo) {
    const scale = Math.min((w * 0.82) / comsocLogo.width, (h * 0.8) / comsocLogo.height);
    const lw = comsocLogo.width * scale;
    const lh = comsocLogo.height * scale;
    g.drawImage(comsocLogo, x + (w - lw) / 2, (h - lh) / 2, lw, lh);
    return;
  }
  const label = title === 'LOGO' ? 'IEEE ComSoc' : title;
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fit = (text, size, weight, maxW) => {
    g.font = `${weight} ${size}px "Arial Black", Arial, sans-serif`;
    const k = Math.min(1, maxW / Math.max(g.measureText(text).width, 1));
    g.font = `${weight} ${size * k}px "Arial Black", Arial, sans-serif`;
  };
  fit(label, h * (sub ? 0.46 : 0.6), 900, w * 0.86);
  g.fillText(label, x + w / 2, sub ? h * 0.42 : h * 0.52);
  if (sub) {
    fit(sub, h * 0.17, 700, w * 0.86);
    g.fillText(sub, x + w / 2, h * 0.8);
  }
}

// Artwork for a banner of the given width/height ratio: as many ~4:1
// sponsor panels as fit side by side, so nothing gets squished.
function sponsorTexture(start, aspect) {
  const h = Math.min(256, Math.floor(4096 / aspect));
  const w = Math.round(h * aspect);
  const panels = Math.max(1, Math.round(aspect / 4));
  return canvasTexture(w, h, (g) => {
    for (let n = 0; n < panels; n++) {
      const x0 = Math.round((n * w) / panels);
      const x1 = Math.round(((n + 1) * w) / panels);
      drawSponsor(g, SPONSORS[(start + n) % SPONSORS.length], x0, x1 - x0, h);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(x1 - 2, 0, 4, h);
    }
  });
}

export function buildDetails(scene, track, terrainY, reserved) {
  const updates = [];
  const rand = rng(33);
  const at = (i, lat) => {
    const p = track.pts[i];
    const s = track.side[i];
    return [p.x + s.x * lat, p.y + s.y * lat];
  };
  const heading = (i) => Math.atan2(track.tan[i].x, track.tan[i].y);
  // Distance from (x, z) to the nearest bit of track centre line.
  const trackDist = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < SAMPLES; i += 2) {
      const p = track.pts[i];
      best = Math.min(best, (p.x - x) ** 2 + (p.y - z) ** 2);
    }
    return Math.sqrt(best);
  };
  const free = (x, z, r) => reserved.every(([px, pz, pr]) => Math.hypot(px - x, pz - z) > pr + r);
  // True if a w x d footprint centred beside sample i (front facing the
  // road) keeps `gap` metres clear of every part of the circuit.
  const fits = (i, lat, w, d, gap = 3) => {
    const p = track.pts[i];
    const s = track.side[i];
    const t = track.tan[i];
    const sg = Math.sign(lat);
    for (let a = -w / 2; a <= w / 2; a += 3) {
      for (let b = -d / 2; b <= d / 2; b += 3) {
        const l = lat + sg * b;
        const x = p.x + s.x * l + t.x * a;
        const z = p.y + s.y * l + t.y * a;
        if (trackDist(x, z) < TRACK_W / 2 + gap) return false;
      }
    }
    return true;
  };
  // Places a model beside the track facing the road (front is +Z).
  const place = (obj, i, lat, extraRot = 0) => {
    obj.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    const [x, z] = at(i, lat);
    const s = track.side[i];
    const toRoad = Math.atan2(-s.x * Math.sign(lat), -s.y * Math.sign(lat));
    obj.position.set(x, terrainY(x, z), z);
    obj.rotation.y = toRoad + extraRot;
    scene.add(obj);
    return obj;
  };

  buildKerbs(scene, track);
  buildGravel(scene, track);
  buildArmco(scene, track);
  const crowd = buildStands(scene, track, place, reserved, at, fits);
  buildPits(scene, track, place, reserved, at, fits);
  const lights = buildStartGantry(scene, track);
  buildBridge(scene, track);
  buildBillboards(scene, track, at, heading, terrainY, reserved, rand, fits);
  buildCameraTowers(scene, track, place, reserved, at, fits);
  buildComms(scene, track, at, terrainY, reserved, updates);
  const signs = buildSigns(scene, track, at, heading, terrainY);
  const scenery = buildScenery(scene, track, terrainY, { trackDist, free, rand });

  updates.push((t) => crowd(t), (t) => scenery.update(t));
  return {
    update: (t) => updates.forEach((f) => f(t)),
    setStartLights: lights,
    setWind: scenery.setWind,
    setMeadows: scenery.setMeadows,
    setSigns: (on) => Object.entries(signs).forEach(([type, list]) => list.forEach((g) => (g.visible = !!on[type]))),
  };
}

// ------------------------------------------------------------------ trackside

// Red/white kerbs on both edges through every corner.
function buildKerbs(scene, track) {
  // Lit like the road (so they darken at night and catch the headlights),
  // with the stripes painted in the shader every 2 m.
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vKerbUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvKerbUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vKerbUv;')
      .replace('#include <map_fragment>', 'diffuseColor.rgb = mix(vec3(0.62), vec3(0.55, 0.035, 0.03), step(0.5, fract(vKerbUv.y / 2.0)));');
  };
  litByHeadlights(mat, 'kerb');
  forCorners(track, 0.012, (i0, i1) => {
    for (const s of [1, -1]) {
      const a = s * (TRACK_W / 2);
      const b = s * (TRACK_W / 2 - 1.2);
      const kerb = new THREE.Mesh(strip(track, a, b, (k, lat) => surfaceY(track, k, lat) + 0.05, { i0, i1 }), mat);
      kerb.receiveShadow = true;
      scene.add(kerb);
    }
  });
}

// Calls fn(i0, i1) for each stretch of track curving more than `minCurv`.
function forCorners(track, minCurv, fn) {
  let start = -1;
  for (let i = 0; i <= SAMPLES; i++) {
    const on = i < SAMPLES && Math.abs(track.curv[i]) > minCurv;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start > 6) fn(Math.max(0, start - 4), Math.min(SAMPLES, i + 4));
      start = -1;
    }
  }
}

// Gravel run-off on the outside of the tight corners.
function buildGravel(scene, track) {
  const tex = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#b9a27a';
    g.fillRect(0, 0, w, h);
    for (let n = 0; n < 2500; n++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(90,70,40,0.4)' : 'rgba(240,225,190,0.4)';
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 0.25);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
  litByHeadlights(mat, 'gravel');
  forCorners(track, 0.03, (i0, i1) => {
    const mid = (i0 + i1) >> 1;
    const out = track.curv[mid] > 0 ? -1 : 1; // the outside of the bend
    const a = out * (TRACK_W / 2 + 0.6);
    const b = out * (TRACK_W / 2 + 9);
    const lats = vergeLats(out, Math.abs(a), Math.abs(b));
    const gravel = new THREE.Mesh(bandStrip(track, lats, (k, lat) => vergeY(track, k, lat) + 0.015, { i0, i1 }), mat);
    gravel.userData.ground = 'gravel';
    scene.add(gravel);
  });
}

// Double-rail armco on posts along both sides, left out wherever it would
// cross another part of the circuit.
function buildArmco(scene, track) {
  const lat = TRACK_W / 2 + 6;
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8bec6, roughness: 0.35, metalness: 0.85, side: THREE.DoubleSide });
  const postGeo = new THREE.BoxGeometry(0.15, 1.1, 0.15);
  const posts = [];
  const clear = (i, l) => {
    const p = track.pts[i];
    const s = track.side[i];
    const x = p.x + s.x * l;
    const z = p.y + s.y * l;
    for (let j = 0; j < SAMPLES; j += 2) {
      const d = Math.min(Math.abs(j - i), SAMPLES - Math.abs(j - i));
      if (d < 40) continue;
      const q = track.pts[j];
      if ((q.x - x) ** 2 + (q.y - z) ** 2 < (TRACK_W / 2 + 7) ** 2) return false;
    }
    return true;
  };
  for (const s of [1, -1]) {
    let start = -1;
    for (let i = 0; i <= SAMPLES; i++) {
      const ok = i < SAMPLES && clear(i, s * lat);
      if (ok && start < 0) start = i;
      if ((!ok || i === SAMPLES) && start >= 0) {
        for (const h of [0.45, 0.85]) {
          const g = strip(track, s * lat, s * lat, (k, l, e) => vergeY(track, k, l) + h + (e ? 0.28 : 0), { i0: start, i1: i });
          scene.add(new THREE.Mesh(g, mat));
        }
        for (let k = start; k < i; k += 3) posts.push([k, s * lat]);
        start = -1;
      }
    }
  }
  const mesh = new THREE.InstancedMesh(postGeo, mat, posts.length);
  const m = new THREE.Matrix4();
  posts.forEach(([k, l], n) => {
    const p = track.pts[k];
    const sd = track.side[k];
    m.makeTranslation(p.x + sd.x * l, vergeY(track, k, l) + 0.55, p.y + sd.y * l);
    mesh.setMatrixAt(n, m);
  });
  scene.add(mesh);
}

// ------------------------------------------------------------------ buildings

function bannerize(obj, sponsorIdx) {
  let n = sponsorIdx;
  obj.traverse((o) => {
    if (o.isMesh && /^Banner/.test(o.name)) {
      // Size the artwork to this banner's real proportions.
      o.geometry.computeBoundingBox();
      const size = o.geometry.boundingBox.getSize(new THREE.Vector3());
      const [long, short] = [size.x, size.y, size.z].sort((a, b) => b - a);
      const map = sponsorTexture(n, long / short);
      n += Math.max(1, Math.round(long / short / 4));
      // glTF models expect textures the other way up from canvas art.
      map.flipY = false;
      o.material = new THREE.MeshBasicMaterial({ map, color: 0xdddddd });
    }
  });
  return obj;
}

// Grandstands packed with a crowd that bobs and waves.
function buildStands(scene, track, place, reserved, at, fits) {
  const spots = [[0.03, 1], [0.01, 1], [0.075, -1], [0.905, 1], [0.15, -1], [0.38, 1], [0.03, -1], [0.62, 1], [0.79, 1]];
  const people = [];
  const stands = [];
  for (const [u, s] of spots) {
    if (!props.grandstand) break;
    const i = sampleAt(u);
    const lat = s * (TRACK_W / 2 + 17);
    if (!fits(i, lat, 26, 11) || !reserved.every(([px, pz, pr]) => Math.hypot(px - at(i, lat)[0], pz - at(i, lat)[1]) > pr + 13)) continue;
    const stand = place(bannerize(props.grandstand.clone(true), stands.length), i, lat);
    stand.updateMatrixWorld();
    stands.push(stand);
    reserved.push([...at(i, lat), 16]);
    for (let t = 0; t < 8; t++) {
      for (let x = -11; x <= 11; x += 0.75) {
        if (Math.random() < 0.18) continue;
        const local = new THREE.Vector3(x + (Math.random() - 0.5) * 0.2, 1.25 + t * 0.55, 3.85 - t * 1.1);
        people.push({ pos: local.applyMatrix4(stand.matrixWorld), phase: Math.random() * 6.28, wave: Math.random() < 0.15 });
      }
    }
  }
  if (!people.length) return () => {};
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.75, 0.35), new THREE.MeshStandardMaterial({ roughness: 0.8 }), people.length);
  const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshStandardMaterial({ color: 0xc98f6b, roughness: 0.7 }), people.length);
  const shirts = [0xff4a3d, 0x00629b, 0xffffff, 0xffcc00, 0x2a9d4a, 0x111111, 0x7a1fa2, 0xff8c1a];
  const col = new THREE.Color();
  people.forEach((p, n) => body.setColorAt(n, col.setHex(shirts[n % shirts.length])));
  const m = new THREE.Matrix4();
  const update = (t) => {
    people.forEach((p, n) => {
      const bob = p.wave ? Math.max(0, Math.sin(t * 6 + p.phase)) * 0.35 : Math.sin(t * 2 + p.phase) * 0.03;
      m.makeTranslation(p.pos.x, p.pos.y + bob, p.pos.z);
      body.setMatrixAt(n, m);
      m.makeTranslation(p.pos.x, p.pos.y + 0.55 + bob, p.pos.z);
      head.setMatrixAt(n, m);
    });
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
  };
  update(0);
  scene.add(body, head);
  return update;
}

function buildPits(scene, track, place, reserved, at, fits) {
  if (!props.pits) return;
  // The pit building goes on the first long straight with room for it,
  // with a little ground station of dishes behind.
  for (const u of [0.03, 0.75, 0.72, 0.24]) {
    const i = sampleAt(u);
    for (const s of [1, -1]) {
      const lat = s * (TRACK_W / 2 + 16);
      if (!fits(i, lat, 62, 14)) continue;
      place(bannerize(props.pits.clone(true), 2), i, lat);
      reserved.push([...at(i, lat), 34]);
      if (props.dish) {
        for (const off of [-18, 18]) {
          const k = (i + Math.round(off / track.dist[1]) + SAMPLES) % SAMPLES;
          const l = s * (TRACK_W / 2 + 36);
          if (!fits(k, l, 8, 8)) continue;
          place(props.dish.clone(true), k, l, off > 0 ? 0.4 : -0.4).scale.setScalar(1.2);
          reserved.push([...at(k, l), 8]);
        }
      }
      return;
    }
  }
}

// The start gantry over the line; setStartLights(n) lights n of 5 pairs.
function buildStartGantry(scene, track) {
  if (!props.start) return () => {};
  const g = bannerize(props.start.clone(true), 0);
  const i = 3;
  const p = track.pts[i];
  const t = track.tan[i];
  g.position.set(p.x, surfaceY(track, i, 0), p.y);
  g.rotation.y = Math.atan2(-t.x, -t.y); // lights face the grid
  scene.add(g);
  const lamps = [];
  g.traverse((o) => {
    if (o.isMesh && /^Light_\d/.test(o.name)) {
      o.material = o.material.clone();
      lamps.push({ n: +o.name[6], mat: o.material });
    }
  });
  return (n) => {
    for (const l of lamps) {
      l.mat.emissive.setHex(0xff1a0a);
      l.mat.emissiveIntensity = l.n <= n ? 2.2 : 0;
      l.mat.color.setHex(l.n <= n ? 0x550000 : 0x150000);
    }
  };
}

function buildBridge(scene, track) {
  if (!props.bridge) return;
  for (const u of [0.25, 0.75]) {
    const b = bannerize(props.bridge.clone(true), u > 0.5 ? 4 : 1);
    const i = sampleAt(u);
    const p = track.pts[i];
    const t = track.tan[i];
    b.position.set(p.x, track.base[i] - 0.6, p.y);
    b.rotation.y = Math.atan2(-t.x, -t.y);
    scene.add(b);
  }
}

// Billboards along the straights, angled towards oncoming karts.
function buildBillboards(scene, track, at, heading, terrainY, reserved, rand, fits) {
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.5, metalness: 0.6 });
  const back = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.8 });
  let n = 0;
  for (let i = 0; i < SAMPLES; i += 18) {
    if (Math.abs(track.curv[i]) > 0.01 || rand() < 0.35) continue;
    const s = n % 2 ? 1 : -1;
    const lat = s * (TRACK_W / 2 + 8.5);
    const [x, z] = at(i, lat);
    if (!fits(i, lat, 9, 1, 0.4) || !reserved.every(([px, pz, pr]) => Math.hypot(px - x, pz - z) > pr + 4)) continue;
    const g = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 0.2), [back, back, back, back, new THREE.MeshBasicMaterial({ map: sponsorTexture(n, 9 / 2.2), color: 0xdddddd }), back]);
    board.position.y = 2.6;
    g.add(board);
    for (const lx of [-3.5, 3.5]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, 0.2), legMat);
      leg.position.set(lx, 1.3, -0.15);
      g.add(leg);
    }
    g.position.set(x, terrainY(x, z), z);
    g.rotation.y = heading(i) + Math.PI + s * 0.5;
    scene.add(g);
    reserved.push([x, z, 6]);
    n++;
  }
}

function buildCameraTowers(scene, track, place, reserved, at, fits) {
  if (!props.camera) return;
  for (const [u, s] of [[0.085, 1], [0.17, 1], [0.31, -1], [0.38, -1], [0.55, 1], [0.91, -1]]) {
    const i = sampleAt(u);
    const lat = s * (TRACK_W / 2 + 13);
    if (!fits(i, lat, 3, 3, 4)) continue;
    place(props.camera.clone(true), i, lat);
    reserved.push([...at(i, lat), 4]);
  }
}

// Comms kit on the hills: lattice cell towers with blinking beacons.
function buildComms(scene, track, at, terrainY, reserved, updates) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa1ab, roughness: 0.4, metalness: 0.8 });
  const panel = new THREE.MeshStandardMaterial({ color: 0xe8ebef, roughness: 0.5 });
  const beacons = [];
  for (const [u, lat] of [[0.19, 40], [0.62, -45], [0.47, 42]]) {
    const i = sampleAt(u);
    const [x, z] = at(i, lat);
    const g = new THREE.Group();
    const H = 38;
    const rod = (a, b, r) => {
      const d = new THREE.Vector3().subVectors(b, a);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 6), steel);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      g.add(m);
    };
    const leg = (lx, lz, h) => new THREE.Vector3(lx * (1 - h / H * 0.7), h, lz * (1 - h / H * 0.7));
    const legs = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
    for (let n = 0; n < 4; n++) {
      const [ax, az] = legs[n];
      const [bx, bz] = legs[(n + 1) % 4];
      rod(leg(ax, az, 0), leg(ax, az, H), 0.18);
      for (let h = 0; h < H - 2; h += 4) {
        rod(leg(ax, az, h), leg(bx, bz, h + 4), 0.06);
        rod(leg(bx, bz, h), leg(ax, az, h + 4), 0.06);
      }
    }
    for (let n = 0; n < 3; n++) {
      const a = (n / 3) * Math.PI * 2;
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.2, 0.35), panel);
      p.position.set(Math.cos(a) * 1.5, H - 3, Math.sin(a) * 1.5);
      p.rotation.y = -a + Math.PI / 2;
      g.add(p);
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff2030 }));
    beacon.position.y = H + 0.6;
    g.add(beacon);
    beacons.push(beacon);
    g.position.set(x, terrainY(x, z), z);
    scene.add(g);
    reserved.push([x, z, 8]);
  }
  updates.push((t) => beacons.forEach((b, n) => (b.visible = Math.floor(t * 1.5 + n) % 2 === 0)));
}

function signTexture(title, sub, color) {
  return canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#111418';
    g.fillRect(10, 10, w - 20, h - 20);
    g.textAlign = 'center';
    g.fillStyle = color;
    g.font = '900 86px "Arial Black", Arial, sans-serif';
    g.fillText(title, w / 2, 130);
    g.fillStyle = '#e8ecf2';
    g.font = '700 34px Arial, sans-serif';
    g.fillText(sub, w / 2, 190);
  });
}

// Warning boards before the track features, plus 150/100/50 m countdown
// boards before the big braking zones.
function buildSigns(scene, track, at, heading, terrainY) {
  const post = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.4, metalness: 0.7 });
  const board = (tex, i, lat, w, h, y) => {
    const [x, z] = at(i, lat);
    const g = new THREE.Group();
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, y, 0.15), post);
    leg.position.y = y / 2;
    g.add(leg);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, color: 0xdddddd, side: THREE.DoubleSide }));
    b.position.y = y + h / 2;
    g.add(b);
    g.position.set(x, terrainY(x, z), z);
    g.rotation.y = heading(i) + Math.PI;
    scene.add(g);
    return g;
  };
  const signs = { rain: [], gates: [] };
  const list = [
    ['rain', 'WET', 'TRACK AHEAD', '#5fc8ff', HAZARDS.rain?.[0]?.u0],
    ['rain', 'WET', 'TRACK AHEAD', '#5fc8ff', HAZARDS.rain?.[1]?.u0],
    ['gates', 'GATES', 'OPEN ON THE BEAT', '#ff3b4a', HAZARDS.gates?.[0]?.u0],
  ];
  for (const [type, title, sub, color, u] of list) {
    if (u === undefined) continue;
    const i = (sampleAt(u) - 28 + SAMPLES) % SAMPLES;
    const out = track.curv[i] > 0 ? -1 : 1;
    signs[type].push(board(signTexture(title, sub, color), i, out * (TRACK_W / 2 + 3.5), 3.6, 1.8, 1.8));
  }
  // Braking boards before the two hairpins and the chicane.
  for (const u of [0.066, 0.296, 0.346, 0.889]) {
    const corner = sampleAt(u);
    for (const m of [150, 100, 50]) {
      const i = (corner - Math.round(m / track.dist[1]) + SAMPLES) % SAMPLES;
      const tex = canvasTexture(128, 128, (g, w, h) => {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#111418';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = '900 64px Arial, sans-serif';
        g.fillText(String(m), w / 2, h / 2 + 4);
      });
      const out = track.curv[corner] > 0 ? -1 : 1;
      board(tex, i, out * (TRACK_W / 2 + 2.5), 1.1, 1.1, 0.9);
    }
  }
  return signs;
}
