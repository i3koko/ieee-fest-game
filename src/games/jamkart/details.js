import * as THREE from 'three';
import { TRACK_W, SAMPLES, HAZARDS, sampleAt, surfaceY, locate, canvasTexture, rng } from './track.js';

// Set dressing for the circuit board: signs, cable arches, glowing data
// traces, a radio tower, LED "crowds", kerbs, a sky and floating dust.
// Nothing here affects the race. Returns update(time) for the animated bits.
export function buildDetails(scene, track, reserved) {
  const updates = [];
  const rand = rng(21);
  const at = (i, lat) => {
    const p = track.pts[i];
    const s = track.side[i];
    return [p.x + s.x * lat, p.y + s.y * lat];
  };
  const angle = (i) => Math.atan2(track.tan[i].x, track.tan[i].y);
  const offTrack = (x, z, r) => Math.abs(locate(track, x, z).lat) > TRACK_W / 2 + r;
  const free = (x, z, r) => reserved.every(([px, pz, pr]) => Math.hypot(px - x, pz - z) > pr + r);

  buildSky(scene, updates);
  buildKerbs(scene, track);
  buildSigns(scene, track, at, angle);
  buildArches(scene, track, at, angle);
  buildTraces(scene, rand, offTrack, free, updates);
  buildTower(scene, track, at, reserved, updates);
  buildCrowds(scene, track, at, angle, reserved, updates);
  buildProcessor(scene, offTrack, free, reserved, updates);

  return { update: (t) => updates.forEach((f) => f(t)) };
}

// ------------------------------------------------------------------ sky

function buildSky(scene, updates) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(520, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          // Matches the fog at the horizon, fading to black overhead, with a
          // faint glow band where the board meets the sky.
          vec3 horizon = vec3(0.004, 0.022, 0.016);
          vec3 top = vec3(0.0, 0.002, 0.005);
          vec3 col = mix(horizon, top, smoothstep(-0.02, 0.35, h));
          col += vec3(0.02, 0.1, 0.07) * exp(-abs(h) * 30.0);
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // Slow-drifting motes of "data" in the air.
  const n = 500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 500;
    pos[i * 3 + 1] = 2 + Math.random() * 40;
    pos[i * 3 + 2] = -80 + (Math.random() - 0.5) * 500;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0x7dffc0, size: 0.35, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  scene.add(dust);
  updates.push((t) => {
    dust.position.y = Math.sin(t * 0.3) * 1.5;
    dust.rotation.y = t * 0.004;
  });
}

// ------------------------------------------------------------------ kerbs

// Striped kerbs on the outside of every banked corner.
function buildKerbs(scene, track) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        float s = step(0.5, fract(vUv.y / 2.4));
        gl_FragColor = vec4(mix(vec3(0.85, 0.85, 0.8), vec3(0.85, 0.12, 0.1), s) * 0.55, 1.0);
      }`,
  });
  let start = -1;
  for (let i = 0; i <= SAMPLES; i++) {
    const on = i < SAMPLES && Math.abs(track.bank[i]) > 0.07;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start > 6) {
        const out = track.bank[start + ((i - start) >> 1)] > 0 ? -1 : 1;
        const a = out * (TRACK_W / 2);
        const b = out * (TRACK_W / 2 - 1.1);
        scene.add(new THREE.Mesh(kerbStrip(track, a, b, start, i), mat));
      }
      start = -1;
    }
  }
}

function kerbStrip(track, latA, latB, i0, i1) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j <= i1 - i0; j++) {
    const k = (i0 + j) % SAMPLES;
    const p = track.pts[k];
    const s = track.side[k];
    for (const lat of [latA, latB]) pos.push(p.x + s.x * lat, surfaceY(track, k, lat) + 0.05, p.y + s.y * lat);
    uv.push(0, track.dist[k], 1, track.dist[k]);
    if (j < i1 - i0) idx.push(j * 2, j * 2 + 2, j * 2 + 1, j * 2 + 1, j * 2 + 2, j * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ signs

function signTexture(title, sub, color) {
  return canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#0b0d10';
    g.fillRect(0, 0, w, h);
    // Hazard stripes along the top and bottom.
    for (const y of [0, h - 26]) {
      for (let x = -40; x < w; x += 40) {
        g.fillStyle = '#ffcc00';
        g.beginPath();
        g.moveTo(x, y + 26);
        g.lineTo(x + 20, y);
        g.lineTo(x + 40, y);
        g.lineTo(x + 20, y + 26);
        g.fill();
      }
    }
    g.textAlign = 'center';
    g.fillStyle = color;
    g.font = '900 78px "Arial Black", Arial, sans-serif';
    g.fillText(title, w / 2, 128);
    g.fillStyle = '#e8ecf2';
    g.font = '700 34px Arial, sans-serif';
    g.fillText(sub, w / 2, 184);
  });
}

// A warning board before every hazard (and the jump), facing oncoming karts.
function buildSigns(scene, track, at, angle) {
  const list = [
    ['⚠ JUMP', 'KEEP YOUR SPEED UP', '#ffcc00', 0.4],
    ['⚠ FLUX', 'SLIPPERY SURFACE', '#5ff2e0', HAZARDS.flux?.[0]?.u0],
    ['FIBER ⇢', 'BOOST STRIP AHEAD', '#9dff3a', HAZARDS.boost?.[1]?.u0],
    ['⚠ EMI', 'INTERFERENCE ZONE', '#ff5ad8', HAZARDS.emi?.[0]?.u0],
    ['⚠ FAN', 'CROSSWIND', '#9fd8ff', HAZARDS.fan?.[0]?.u0],
    ['⚠ CLOCK', 'GATES OPEN ON THE BEAT', '#ff3b4a', HAZARDS.gates?.[0]?.u0],
  ];
  const post = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.4, metalness: 0.7 });
  for (const [title, sub, color, u] of list) {
    if (u === undefined) continue;
    const i = (sampleAt(u) - 30 + SAMPLES) % SAMPLES;
    const out = track.bank[i] > 0 ? -1 : 1;
    const [x, z] = at(i, out * (TRACK_W / 2 + 2.6));
    const y = surfaceY(track, i, out * (TRACK_W / 2));
    const g = new THREE.Group();
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4.2, 0.2), post);
      leg.position.set(s * 2.2, 2.1, 0);
      g.add(leg);
    }
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 2.7),
      new THREE.MeshBasicMaterial({ map: signTexture(title, sub, color), color: 0xb0b0b0, side: THREE.DoubleSide })
    );
    board.position.y = 4.4;
    g.add(board);
    g.position.set(x, y, z);
    // Face back down the road, turned slightly in towards the driver.
    g.rotation.y = angle(i) + Math.PI + out * 0.35;
    scene.add(g);
  }
}

// ------------------------------------------------------------------ cable arches

function ribbonTexture() {
  return canvasTexture(256, 32, (g, w, h) => {
    const colors = ['#5a3a1e', '#d42a2a', '#ff8c1a', '#f2d21c', '#2a9d4a', '#2a5bd4', '#8a4fd4', '#8f949c', '#f4f6f8', '#1b1b1b'];
    colors.forEach((c, n) => {
      g.fillStyle = c;
      g.fillRect((n * w) / colors.length, 0, w / colors.length - 2, h);
    });
  });
}

// Flat rainbow ribbon cables looping over the road, with connectors at the feet.
function buildArches(scene, track, at, angle) {
  const tex = ribbonTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide });
  const plug = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.4, metalness: 0.3 });
  for (const u of [0.13, 0.585, 0.81]) {
    const i = sampleAt(u);
    const t = track.tan[i];
    const span = TRACK_W / 2 + 3;
    const base = surfaceY(track, i, 0);
    const pos = [];
    const uv = [];
    const idx = [];
    const n = 32;
    for (let k = 0; k <= n; k++) {
      const a = k / n;
      const lat = -span + a * span * 2;
      const [x, z] = at(i, lat);
      const y = base + 0.5 + Math.sin(a * Math.PI) * 10;
      for (const w of [-1.3, 1.3]) {
        pos.push(x + t.x * w, y, z + t.y * w);
        uv.push((w + 1.3) / 2.6, a * 6);
      }
      if (k < n) idx.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, mat));
    for (const s of [-1, 1]) {
      const [x, z] = at(i, s * span);
      const c = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 1.4), plug);
      c.position.set(x, base + 0.7, z);
      c.rotation.y = angle(i) + Math.PI / 2;
      scene.add(c);
    }
  }
}

// ------------------------------------------------------------------ data traces

// L-shaped copper traces across the board with light pulses running along them.
function buildTraces(scene, rand, offTrack, free, updates) {
  const pos = [];
  const uv = [];
  const phase = [];
  const idx = [];
  let quads = 0;
  const seg = (x0, z0, x1, z1, ph) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const nx = (-(z1 - z0) / len) * 0.35;
    const nz = ((x1 - x0) / len) * 0.35;
    pos.push(x0 + nx, 0.05, z0 + nz, x0 - nx, 0.05, z0 - nz, x1 + nx, 0.05, z1 + nz, x1 - nx, 0.05, z1 - nz);
    uv.push(0, 0, 0, 1, len, 0, len, 1);
    phase.push(ph, ph, ph, ph);
    const b = quads * 4;
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    quads++;
  };
  const clearLine = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    for (let d = 0; d <= len; d += 4) {
      const x = x0 + ((x1 - x0) * d) / len;
      const z = z0 + ((z1 - z0) * d) / len;
      if (!offTrack(x, z, 3) || !free(x, z, 1)) return false;
    }
    return true;
  };
  for (let n = 0; n < 400 && quads < 120; n++) {
    const x0 = -260 + rand() * 520;
    const z0 = -300 + rand() * 410;
    const x1 = x0 + (rand() - 0.5) * 120;
    const z1 = z0 + (rand() - 0.5) * 120;
    if (!clearLine(x0, z0, x1, z0) || !clearLine(x1, z0, x1, z1)) continue;
    const ph = rand();
    seg(x0, z0, x1, z0, ph);
    seg(x1, z0, x1, z1, ph + Math.abs(x1 - x0) / 40);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      varying vec2 vUv;
      varying float vPhase;
      varying float vDist;
      void main() {
        vUv = uv;
        vPhase = aPhase;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vPhase;
      varying float vDist;
      void main() {
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        float p = fract(vUv.x / 40.0 - uTime * 0.35 + vPhase);
        float pulse = smoothstep(0.92, 1.0, p);
        vec3 col = vec3(0.1, 0.5, 0.25) * 0.25 + vec3(0.5, 1.0, 0.6) * pulse * 1.4;
        float fade = 1.0 - smoothstep(90.0, 220.0, vDist);
        gl_FragColor = vec4(col * edge * fade, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(g, mat));
  updates.push((t) => (mat.uniforms.uTime.value = t));
}

// ------------------------------------------------------------------ radio tower

function rod(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 6), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

// A lattice cell tower by the start straight, with panel antennas and a beacon.
function buildTower(scene, track, at, reserved, updates) {
  const i = sampleAt(0.04);
  const out = 1;
  const [x, z] = at(i, out * (TRACK_W / 2 + 16));
  const steel = new THREE.MeshStandardMaterial({ color: 0x8d949e, roughness: 0.4, metalness: 0.8 });
  const g = new THREE.Group();
  const H = 34;
  const legs = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
  const top = 0.9;
  const pt = ([lx, lz], h) => new THREE.Vector3(lx * (1 - (h / H) * (1 - top / 3)), h, lz * (1 - (h / H) * (1 - top / 3)));
  for (let n = 0; n < 4; n++) {
    const a = legs[n];
    const b = legs[(n + 1) % 4];
    g.add(rod(pt(a, 0), pt(a, H), 0.18, steel));
    for (let h = 0; h < H - 2; h += 4) {
      g.add(rod(pt(a, h), pt(b, h + 4), 0.07, steel));
      g.add(rod(pt(b, h), pt(a, h + 4), 0.07, steel));
    }
  }
  // Sector panels and microwave dishes near the top.
  const panel = new THREE.MeshStandardMaterial({ color: 0xe8ebef, roughness: 0.5 });
  for (let n = 0; n < 3; n++) {
    const a = (n / 3) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.2, 0.35), panel);
    p.position.set(Math.cos(a) * 1.6, H - 3, Math.sin(a) * 1.6);
    p.rotation.y = -a + Math.PI / 2;
    g.add(p);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.4, 20), panel);
    dish.rotation.x = Math.PI / 2;
    dish.rotation.z = a;
    dish.position.set(Math.cos(a + 1) * 1.8, H - 8, Math.sin(a + 1) * 1.8);
    g.add(dish);
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff2030 }));
  beacon.position.y = H + 0.6;
  g.add(beacon);
  // A slow sweep of "signal" rings broadcasting from the top.
  const rings = [];
  for (let n = 0; n < 3; n++) {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.06, 6, 48),
      new THREE.MeshBasicMaterial({ color: 0x9dff3a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    r.rotation.x = Math.PI / 2;
    r.position.y = H - 3;
    g.add(r);
    rings.push(r);
  }
  g.position.set(x, 0, z);
  scene.add(g);
  reserved.push([x, z, 8]);
  updates.push((t) => {
    beacon.visible = Math.floor(t * 1.5) % 2 === 0;
    rings.forEach((r, n) => {
      const p = (t * 0.4 + n / 3) % 1;
      r.scale.setScalar(2 + p * 30);
      r.material.opacity = 0.6 * (1 - p);
    });
  });
}

// ------------------------------------------------------------------ LED crowds

// Grandstands of LEDs along the straights that ripple like a crowd doing the wave.
function buildCrowds(scene, track, at, angle, reserved, updates) {
  const stands = [0.965, 0.02, 0.5, 0.56];
  const per = 14 * 5;
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshBasicMaterial(), stands.length * per);
  const frame = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.5, metalness: 0.5 });
  const m = new THREE.Matrix4();
  const spots = [];
  stands.forEach((u, s) => {
    const i = sampleAt(u);
    const out = track.bank[i] > 0 ? -1 : 1;
    const [x, z] = at(i, out * (TRACK_W / 2 + 7));
    const base = surfaceY(track, i, 0);
    const rot = angle(i);
    const g = new THREE.Group();
    const step = new THREE.Mesh(new THREE.BoxGeometry(16, 5, 4), frame);
    step.position.y = 2.5 + Math.max(0, base - 1);
    g.add(step);
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    scene.add(g);
    g.updateMatrixWorld();
    reserved.push([x, z, 9]);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 14; c++) {
        const local = new THREE.Vector3(-7 + c * (14 / 13), 1 + r * 0.95 + Math.max(0, base - 1), (r - 2) * 0.7 * -out + out * 2.1);
        local.applyMatrix4(g.matrixWorld);
        spots.push([local, c + s * 14, r]);
      }
    }
  });
  spots.forEach(([p], n) => {
    m.makeTranslation(p.x, p.y, p.z);
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, new THREE.Color(0x000000));
  });
  scene.add(mesh);
  const col = new THREE.Color();
  const palette = [0x3df5ff, 0xff3fd2, 0x9dff3a, 0xffe03d];
  updates.push((t) => {
    spots.forEach(([, c, r], n) => {
      const wave = Math.sin(c * 0.45 - t * 4) * 0.5 + 0.5;
      col.setHex(palette[(c + r) % palette.length]).multiplyScalar(0.25 + wave * 0.9);
      mesh.setColorAt(n, col);
    });
    mesh.instanceColor.needsUpdate = true;
  });
}

// ------------------------------------------------------------------ processor

// A big processor with a finned heat sink and a spinning fan, in a free spot.
function buildProcessor(scene, offTrack, free, reserved, updates) {
  const spots = [[-60, -40], [-40, -170], [90, -110], [-150, -150], [60, 60], [-170, 70]];
  const spot = spots.find(([x, z]) => offTrack(x, z, 16) && free(x, z, 14));
  if (!spot) return;
  const [x, z] = spot;
  const g = new THREE.Group();
  const pkg = new THREE.Mesh(new THREE.BoxGeometry(22, 1.2, 22), new THREE.MeshStandardMaterial({ color: 0x1f5a2e, roughness: 0.6 }));
  pkg.position.y = 0.6;
  g.add(pkg);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(16, 0.8, 16), new THREE.MeshStandardMaterial({ color: 0xb8bdc6, roughness: 0.3, metalness: 0.9 }));
  lid.position.y = 1.6;
  g.add(lid);
  const finMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.35, metalness: 0.85 });
  const fins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 5, 15), finMat, 22);
  const m = new THREE.Matrix4();
  for (let n = 0; n < 22; n++) fins.setMatrixAt(n, m.makeTranslation(-7.5 + n * (15 / 21), 4.5, 0));
  g.add(fins);
  const shroud = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 0.8, 40, 1, true), new THREE.MeshStandardMaterial({ color: 0x15171c, side: THREE.DoubleSide }));
  shroud.position.y = 7.4;
  g.add(shroud);
  const blades = new THREE.Group();
  for (let n = 0; n < 9; n++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 5.6), new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.5 }));
    b.position.z = 3;
    b.rotation.z = 0.4;
    const arm = new THREE.Group();
    arm.rotation.y = (n / 9) * Math.PI * 2;
    arm.add(b);
    blades.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.6, 24), new THREE.MeshBasicMaterial({ color: 0x3df5ff }));
  blades.add(hub);
  blades.position.y = 7.4;
  g.add(blades);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(6.6, 0.12, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x3df5ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 7.85;
  g.add(ring);
  g.position.set(x, 0, z);
  scene.add(g);
  reserved.push([x, z, 16]);
  updates.push((t) => (blades.rotation.y = t * 6));
}
