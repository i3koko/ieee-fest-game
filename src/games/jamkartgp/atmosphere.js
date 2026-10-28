import * as THREE from 'three';
import { TRACK_W, SAMPLES, surfaceY, groundAt, canvasTexture } from './track.js';

// Race-day atmosphere for Jam Kart GP: tyre smoke and skid marks when karts
// lock up, spin or slide, marshals who wave yellow flags at a spin and the
// chequered flag at the finish, a TV helicopter following the leader,
// confetti over the line when karts finish, and fireworks once the race is won.

const REAR = 1.15; // rear axle behind the kart's centre
const TRACKW = 0.85; // half the rear track

export function buildAtmosphere(scene, track, terrainY) {
  const smoke = buildSmoke(scene);
  const skids = buildSkids(scene);
  const marshals = buildMarshals(scene, track, terrainY);
  const heli = buildHelicopter(scene);
  const confetti = buildConfetti(scene, track);
  const fireworks = buildFireworks(scene, track);

  return {
    // ctx: { wet, live, raceTime, finishing, watch (karts the cameras follow) }
    update(dt, time, karts, ctx) {
      for (const k of karts) {
        if (!k.skid || Math.abs(k.lat) > TRACK_W / 2 + 0.3) {
          k.skidFrom = null;
          continue;
        }
        const fx = Math.sin(k.h);
        const fz = Math.cos(k.h);
        const wheels = [-1, 1].map((s) => {
          const x = k.x - fx * REAR + fz * s * TRACKW;
          const z = k.z - fz * REAR - fx * s * TRACKW;
          return { x, z, y: groundAt(track, k.idx, x, z, k.lat + s * TRACKW) };
        });
        // Smoke only off dry tarmac; in the wet it's spray instead.
        if (Math.random() < (1 - ctx.wet) * 0.8) for (const w of wheels) smoke.emit(w.x, w.y + 0.3, w.z, k.vx * 0.15, k.vz * 0.15);
        if (k.skidFrom) {
          const moved = Math.hypot(wheels[0].x - k.skidFrom[0].x, wheels[0].z - k.skidFrom[0].z);
          if (moved < 0.25) continue;
          wheels.forEach((w, n) => skids.add(k.skidFrom[n], w));
        }
        k.skidFrom = wheels;
      }
      smoke.update(dt);
      marshals.update(dt, time, karts, ctx);
      heli.update(dt, time, karts, track);
      confetti.update(dt, time);
      fireworks.update(dt, ctx.watch);
    },
    confetti: (amount) => confetti.burst(amount),
    // Starts (or steps up) the fireworks show: 1 for a player's win.
    fireworks: (amount) => fireworks.start(amount),
    // Called with (distance) each time a shell bursts, for the sound.
    set onFirework(fn) {
      fireworks.onBurst = fn;
    },
    reset() {
      skids.clear();
      confetti.clear();
      fireworks.clear();
    },
  };
}

// ------------------------------------------------------------------ smoke

function softDot() {
  return canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
}

function buildSmoke(scene) {
  const n = 600;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.6, map: softDot(), vertexColors: true, transparent: true, depthWrite: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  const puffs = Array.from({ length: n }, () => ({ life: 0, max: 1, x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0 }));
  let next = 0;
  return {
    emit(x, y, z, vx, vz) {
      const p = puffs[next++ % n];
      p.max = p.life = 1 + Math.random() * 0.8;
      p.x = x + (Math.random() - 0.5) * 0.4;
      p.y = y;
      p.z = z + (Math.random() - 0.5) * 0.4;
      p.vx = vx + (Math.random() - 0.5) * 1.2;
      p.vy = 0.5 + Math.random() * 0.6;
      p.vz = vz + (Math.random() - 0.5) * 1.2;
    },
    update(dt) {
      const pos = geo.attributes.position;
      const col = geo.attributes.color;
      puffs.forEach((p, i) => {
        if (p.life > 0) {
          p.life -= dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += p.vz * dt;
          p.vx *= 1 - 1.5 * dt;
          p.vz *= 1 - 1.5 * dt;
        }
        const t = p.life / p.max; // 1 fresh .. 0 gone
        pos.setXYZ(i, p.x, p.life > 0 ? p.y : -10, p.z);
        col.setXYZW(i, 0.86, 0.86, 0.88, Math.max(0, t) * Math.min(1, (1 - t) * 8) * 0.4);
      });
      pos.needsUpdate = true;
      col.needsUpdate = true;
    },
  };
}

// ------------------------------------------------------------------ skid marks

// Dark rubber streaks laid on the tarmac, in a ring buffer of quads.
function buildSkids(scene) {
  const n = 2400;
  const pos = new Float32Array(n * 4 * 3);
  const alpha = new Float32Array(n * 4);
  const idx = [];
  for (let q = 0; q < n; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: /* glsl */ `
      attribute float alpha;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vAlpha = alpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(0.03, 0.03, 0.035, vAlpha);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  let next = 0;
  return {
    add(a, b) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const w = 0.16;
      const px = (-dz / len) * w;
      const pz = (dx / len) * w;
      const q = next++ % n;
      const o = q * 12;
      const lift = 0.012;
      pos.set([a.x - px, a.y + lift, a.z - pz, a.x + px, a.y + lift, a.z + pz, b.x - px, b.y + lift, b.z - pz, b.x + px, b.y + lift, b.z + pz], o);
      alpha.fill(0.55, q * 4, q * 4 + 4);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
    },
    clear() {
      alpha.fill(0);
      geo.attributes.alpha.needsUpdate = true;
      next = 0;
    },
  };
}

// ------------------------------------------------------------------ marshals

function flagTexture(kind) {
  return canvasTexture(64, 44, (g, w, h) => {
    if (kind === 'chequered') {
      for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
        g.fillRect((x * w) / 6, (y * h) / 4, w / 6 + 1, h / 4 + 1);
      }
    } else {
      g.fillStyle = kind === 'yellow' ? '#ffd400' : '#1fbf3a';
      g.fillRect(0, 0, w, h);
    }
  });
}

function buildMarshal(flagMats) {
  const vest = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc99872, roughness: 0.8 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 });
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.17, 0.85, 0.2), dark, s * 0.12, 0.43, 0);
  add(new THREE.BoxGeometry(0.5, 0.62, 0.28), vest, 0, 1.17, 0);
  add(new THREE.SphereGeometry(0.15, 10, 8), skin, 0, 1.64, 0);
  add(new THREE.SphereGeometry(0.16, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), white, 0, 1.68, 0);
  add(new THREE.BoxGeometry(0.11, 0.58, 0.11), vest, -0.31, 1.15, 0).rotation.z = -0.12;
  // Flag arm, pivoting at the shoulder.
  const arm = new THREE.Group();
  arm.position.set(0.3, 1.42, 0);
  g.add(arm);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.58, 0.11).translate(0, 0.27, 0), vest);
  upper.castShadow = true;
  arm.add(upper);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.1, 5).translate(0, 0.55 + 0.5, 0), white);
  arm.add(pole);
  const cloth = new THREE.PlaneGeometry(0.9, 0.6, 8, 1).translate(0.45, 0, 0);
  const flag = new THREE.Mesh(cloth, flagMats.yellow);
  flag.position.set(0.02, 1.32, 0);
  flag.castShadow = true;
  arm.add(flag);
  const rest = cloth.attributes.position.array.slice();
  return { group: g, arm, pole, flag, cloth, rest };
}

function buildMarshals(scene, track, terrainY) {
  const flagMats = Object.fromEntries(
    ['yellow', 'green', 'chequered'].map((k) => [k, new THREE.MeshStandardMaterial({ map: flagTexture(k), side: THREE.DoubleSide, roughness: 0.8 })])
  );
  const clearOf = (x, z, r) => {
    for (let j = 0; j < SAMPLES; j += 2) if ((track.pts[j].x - x) ** 2 + (track.pts[j].y - z) ** 2 < r * r) return false;
    return true;
  };
  const list = [];
  const put = (i, lat, kind) => {
    const p = track.pts[i];
    const s = track.side[i];
    const x = p.x + s.x * lat;
    const z = p.y + s.y * lat;
    const m = buildMarshal(flagMats);
    m.group.position.set(x, Math.max(terrainY(x, z), surfaceY(track, i, 0) - 2), z);
    m.group.rotation.y = Math.atan2(-s.x * Math.sign(lat), -s.y * Math.sign(lat));
    m.group.name = 'marshal';
    m.kind = kind;
    m.i = i;
    m.wave = 0;
    scene.add(m.group);
    list.push(m);
    return m;
  };
  // A post on the inside of each big corner, behind the armco.
  let last = -999;
  for (let i = 0; i < SAMPLES && list.length < 10; i++) {
    if (Math.abs(track.curv[i]) < 0.025 || i - last < 60) continue;
    const inside = track.curv[i] > 0 ? 1 : -1;
    const lat = inside * (TRACK_W / 2 + 7.5);
    const p = track.pts[i];
    const s = track.side[i];
    if (!clearOf(p.x + s.x * lat, p.y + s.y * lat, TRACK_W / 2 + 6.5)) continue;
    put(i, lat, 'corner');
    last = i;
  }
  // The finish-line marshal stands by the wall just past the line.
  const finish = put(10, TRACK_W / 2 + 4.6, 'finish');
  finish.flag.material = flagMats.green;

  return {
    update(dt, time, karts, ctx) {
      for (const m of list) {
        let want = 0;
        if (m.kind === 'finish') {
          if (ctx.finishing) {
            m.flag.material = flagMats.chequered;
            want = 1;
          } else if (ctx.live && ctx.raceTime < 4) {
            m.flag.material = flagMats.green;
            want = 1;
          }
        } else {
          // Yellow flag for a kart in trouble anywhere near this corner.
          const near = karts.some((k) => k.spinT > 0 && (k.x - m.group.position.x) ** 2 + (k.z - m.group.position.z) ** 2 < 70 * 70);
          if (near) m.hold = 2.5;
          m.hold = Math.max(0, (m.hold || 0) - dt);
          want = m.hold > 0 ? 1 : 0;
        }
        m.wave += (want - m.wave) * Math.min(dt * 4, 1);
        // Raised and waving when there's something to flag; otherwise the
        // arm hangs down and the flag is put away.
        const swing = Math.sin(time * 7 + m.i) * 0.8;
        m.arm.rotation.z = THREE.MathUtils.lerp(3.0, swing * 0.9 - 0.25, m.wave);
        m.flag.visible = m.pole.visible = m.wave > 0.3;
        // Cloth ripples, more as it's waved.
        const a = m.cloth.attributes.position;
        for (let v = 0; v < a.count; v++) {
          const x = m.rest[v * 3];
          a.setZ(v, Math.sin(x * 7 - time * (6 + 6 * m.wave) + m.i) * 0.07 * (x / 0.9) * (0.4 + m.wave));
        }
        a.needsUpdate = true;
      }
    },
  };
}

// ------------------------------------------------------------------ helicopter

// The TV helicopter: hangs back and to one side of the leader, filming.
function buildHelicopter(scene) {
  const body = new THREE.MeshStandardMaterial({ color: 0x1d4f91, roughness: 0.4, metalness: 0.3 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, parent = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  add(new THREE.SphereGeometry(1.3, 16, 12).scale(1, 0.9, 1.6), body, 0, 0, 0);
  add(new THREE.SphereGeometry(1.0, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.8, 1).rotateX(Math.PI / 2.4), glass, 0, 0.15, 1.1);
  add(new THREE.CylinderGeometry(0.22, 0.4, 4.2, 8).rotateX(Math.PI / 2), white, 0, 0.3, -3.6);
  add(new THREE.BoxGeometry(0.1, 1.2, 0.8), body, 0, 0.8, -5.5);
  add(new THREE.BoxGeometry(1.6, 0.08, 0.5), body, 0, 0.35, -5.2);
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.06, 0.06, 3.4, 6).rotateX(Math.PI / 2), dark, s * 0.9, -1.35, 0.1);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 5), dark, s * 0.8, -1.05, 0.8);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 5), dark, s * 0.8, -1.05, -0.6);
  }
  add(new THREE.CylinderGeometry(0.15, 0.15, 0.5, 8), dark, 0, 1.25, 0);
  // Main rotor: two long thin blades, plus a disc that suggests the blur.
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.5, 0);
  g.add(rotor);
  for (const r of [0, Math.PI / 2]) add(new THREE.BoxGeometry(9, 0.05, 0.28).rotateY(r), dark, 0, 0, 0, rotor);
  const blur = new THREE.Mesh(new THREE.CircleGeometry(4.5, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.12, depthWrite: false }));
  blur.position.y = 1.5;
  g.add(blur);
  const tail = new THREE.Group();
  tail.position.set(0.12, 0.9, -5.6);
  g.add(tail);
  add(new THREE.BoxGeometry(0.04, 1.4, 0.14), dark, 0, 0, 0, tail);
  g.position.set(0, 60, 0);
  scene.add(g);

  const pos = new THREE.Vector3(0, 60, 0);
  const vel = new THREE.Vector3();
  const goal = new THREE.Vector3();
  let started = false;
  return {
    update(dt, time, karts, track) {
      rotor.rotation.y += dt * 38;
      tail.rotation.x += dt * 60;
      const lead = karts.reduce((a, k) => (k.place < a.place ? k : a), karts[0]);
      if (!lead) return;
      // Behind and off to the side of the leader, gently bobbing.
      const fx = Math.sin(lead.h);
      const fz = Math.cos(lead.h);
      goal.set(lead.x - fx * 26 + fz * 22, lead.y + 30 + Math.sin(time * 0.6) * 2, lead.z - fz * 26 - fx * 22);
      if (!started) {
        pos.copy(goal);
        started = true;
      }
      // Springs towards its spot, so it lags and swings like a real one.
      vel.addScaledVector(goal.clone().sub(pos), dt * 0.9);
      vel.multiplyScalar(1 - Math.min(dt * 1.4, 1));
      pos.addScaledVector(vel, dt);
      g.position.copy(pos);
      // Nose towards the leader; lean into the direction it's flying.
      const yaw = Math.atan2(lead.x - pos.x, lead.z - pos.z);
      let d = yaw - g.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      g.rotation.y += d * Math.min(dt * 2, 1);
      const cy = Math.cos(g.rotation.y);
      const sy = Math.sin(g.rotation.y);
      const fwd = vel.x * sy + vel.z * cy;
      const sideV = vel.x * cy - vel.z * sy;
      g.rotation.x = THREE.MathUtils.clamp(fwd * 0.02, -0.3, 0.3);
      g.rotation.z = THREE.MathUtils.clamp(-sideV * 0.025, -0.35, 0.35);
    },
  };
}

// ------------------------------------------------------------------ confetti

// Paper confetti fluttering down over the finish line.
function buildConfetti(scene, track) {
  const n = 900;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.22, vertexColors: true }));
  pts.frustumCulled = false;
  scene.add(pts);
  const COLORS = [0xff3b5c, 0xffd23f, 0x2ec4ff, 0x7cff6b, 0xffffff, 0xb36bff, 0xff8a2b].map((h) => new THREE.Color(h));
  const bits = Array.from({ length: n }, () => ({ life: 0, x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, ph: 0 }));
  const col = geo.attributes.color;
  bits.forEach((b, i) => col.setXYZ(i, ...COLORS[i % COLORS.length].toArray()));
  let next = 0;
  // Over the start/finish gantry.
  const i = 3;
  const p = track.pts[i];
  const s = track.side[i];
  const t = track.tan[i];
  const top = surfaceY(track, i, 0) + 7;
  return {
    burst(amount = 1) {
      const count = Math.floor(n * 0.6 * amount);
      for (let c = 0; c < count; c++) {
        const b = bits[next++ % n];
        const lat = (Math.random() - 0.5) * (TRACK_W + 4);
        const along = (Math.random() - 0.5) * 3;
        b.x = p.x + s.x * lat + t.x * along;
        b.y = top + Math.random();
        b.z = p.y + s.y * lat + t.y * along;
        b.vx = (Math.random() - 0.5) * 6;
        b.vy = 2 + Math.random() * 5;
        b.vz = (Math.random() - 0.5) * 6;
        b.ph = Math.random() * 6.28;
        b.life = 7 + Math.random() * 3;
      }
    },
    update(dt, time) {
      const pos = geo.attributes.position;
      bits.forEach((b, i) => {
        if (b.life > 0) {
          b.life -= dt;
          // Paper falls slowly and flutters from side to side.
          if (b.y > top - 6.96) b.vy = Math.max(b.vy - 9.8 * dt, -1.6);
          b.vx *= 1 - 1.5 * dt;
          b.vz *= 1 - 1.5 * dt;
          const air = b.y > top - 6.96 ? 0.8 : 0;
          b.x += (b.vx + Math.sin(time * 4 + b.ph) * air) * dt;
          b.y += b.vy * dt;
          b.z += (b.vz + Math.cos(time * 3.3 + b.ph) * air) * dt;
          // Settles on the road and lies there till it's swept away.
          if (b.y < top - 6.97) {
            b.y = top - 6.97;
            b.vx = b.vz = b.vy = 0;
          }
        }
        pos.setXYZ(i, b.x, b.life > 0 ? b.y : -50, b.z);
      });
      pos.needsUpdate = true;
    },
    clear() {
      for (const b of bits) b.life = 0;
    },
  };
}

// ------------------------------------------------------------------ fireworks

// Rockets launched from beside the circuit ahead of the cameras, bursting
// into peonies, rings and golden crackle. Additive points brighter than 1, so
// the bloom makes them glow.
function buildFireworks(scene, track) {
  const n = 5000;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3).fill(-500);
  const col = new Float32Array(n * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const dot = canvasTexture(64, 64, (g, w) => {
    const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, w);
  });
  const mat = new THREE.PointsMaterial({ size: 1.6, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);

  const COLORS = [0xff3b5c, 0xffd23f, 0x2ec4ff, 0x7cff6b, 0xffffff, 0xc77dff, 0xff8a2b, 0x3df5ff].map((h) => new THREE.Color(h));
  const GOLD = new THREE.Color(0xffc060);
  const sparks = Array.from({ length: n }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, drag: 1, g: 4, c: COLORS[0], c2: null, twinkle: false, size: 1 }));
  let next = 0;
  const spark = () => sparks[next++ % n];
  const rockets = [];
  let rate = 0; // rockets per second
  let wait = 0;
  let salvo = 0; // rockets still to fire straight away
  const show = { onBurst: null };

  // Somewhere off to the side of the track, 70-130 m ahead of a camera.
  const site = (watch) => {
    const k = watch[Math.floor(Math.random() * watch.length)];
    if (!k) return null;
    const step = track.length / SAMPLES;
    const i = (k.idx + Math.floor((70 + Math.random() * 60) / step)) % SAMPLES;
    const side = Math.random() < 0.5 ? -1 : 1;
    const lat = side * (TRACK_W / 2 + 14 + Math.random() * 30);
    const p = track.pts[i];
    const x = p.x + track.side[i].x * lat;
    const z = p.y + track.side[i].y * lat;
    return { x, z, y: track.terrainY ? track.terrainY(x, z) : surfaceY(track, i, 0), from: k };
  };

  const launch = (watch) => {
    const s = site(watch);
    if (!s) return;
    rockets.push({
      x: s.x, y: s.y, z: s.z,
      vx: (Math.random() - 0.5) * 3, vy: 27 + Math.random() * 7, vz: (Math.random() - 0.5) * 3,
      fuse: 1.3 + Math.random() * 0.5, from: s.from,
      kind: ['peony', 'peony', 'ring', 'crackle', 'two'][Math.floor(Math.random() * 5)],
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      c2: COLORS[Math.floor(Math.random() * COLORS.length)],
    });
  };

  const burst = (r) => {
    const count = r.kind === 'crackle' ? 160 : 200;
    const speed = 11 + Math.random() * 5;
    // A random tilt for rings, so they don't all face the same way.
    const axis = new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
    const u = new THREE.Vector3(1, 0, 0).cross(axis).normalize();
    const w = axis.clone().cross(u);
    for (let i = 0; i < count; i++) {
      const p = spark();
      let dx, dy, dz;
      if (r.kind === 'ring') {
        const a = (i / count) * Math.PI * 2;
        dx = u.x * Math.cos(a) + w.x * Math.sin(a);
        dy = u.y * Math.cos(a) + w.y * Math.sin(a);
        dz = u.z * Math.cos(a) + w.z * Math.sin(a);
      } else {
        // Even spread over a sphere.
        dy = 1 - (2 * (i + 0.5)) / count;
        const rr = Math.sqrt(1 - dy * dy);
        const a = i * 2.39996;
        dx = Math.cos(a) * rr;
        dz = Math.sin(a) * rr;
      }
      const v = speed * (r.kind === 'ring' ? 1 : 0.85 + Math.random() * 0.3);
      Object.assign(p, {
        x: r.x, y: r.y, z: r.z, vx: dx * v + r.vx, vy: dy * v + r.vy * 0.3, vz: dz * v + r.vz,
        life: 0, max: (r.kind === 'crackle' ? 2.2 : 1.7) + Math.random() * 0.5, drag: 1.3, g: 4.5,
        c: r.kind === 'crackle' ? GOLD : r.c, c2: r.kind === 'two' && i % 2 ? r.c2 : null,
        twinkle: r.kind === 'crackle', size: 1,
      });
    }
    // A bright flash at the centre.
    const f = spark();
    Object.assign(f, { x: r.x, y: r.y, z: r.z, vx: 0, vy: 0, vz: 0, life: 0, max: 0.25, drag: 0, g: 0, c: COLORS[4], c2: null, twinkle: false, size: 6 });
    if (show.onBurst && r.from) show.onBurst(Math.hypot(r.x - r.from.x, r.y - r.from.y, r.z - r.from.z));
  };

  show.start = (amount = 1) => {
    rate = Math.max(rate, 1.2 + 1.6 * amount);
    salvo = Math.max(salvo, Math.round(2 + 3 * amount));
    pts.visible = true;
  };

  show.update = (dt, watch = []) => {
    if (!pts.visible) return;
    if (rate > 0 && watch.length) {
      // An opening salvo, then a steady stream.
      for (; salvo > 0; salvo--) launch(watch);
      for (wait -= dt; wait <= 0; wait += (0.5 + Math.random()) / rate) launch(watch);
    }
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.vy -= 9.8 * dt;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.z += r.vz * dt;
      // A short trail of embers behind the rocket.
      const t = spark();
      Object.assign(t, { x: r.x, y: r.y, z: r.z, vx: (Math.random() - 0.5), vy: -2, vz: (Math.random() - 0.5), life: 0, max: 0.5, drag: 2, g: 2, c: GOLD, c2: null, twinkle: false, size: 0.6 });
      if ((r.fuse -= dt) <= 0) {
        burst(r);
        rockets.splice(i, 1);
      }
    }
    for (let i = 0; i < n; i++) {
      const p = sparks[i];
      const o = i * 3;
      if (p.life >= p.max) {
        if (pos[o + 1] !== -500) pos.fill(-500, o, o + 3);
        continue;
      }
      p.life += dt;
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag - p.g * dt;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      pos[o] = p.x;
      pos[o + 1] = p.y;
      pos[o + 2] = p.z;
      // Bright at first, fading out; crackle flickers at the end.
      const age = p.life / p.max;
      let b = (1 - age) * (1 - age) * 2.6 * p.size;
      if (p.twinkle && age > 0.5) b *= Math.random() < 0.5 ? 0.1 : 1.6;
      const c = p.c2 ?? p.c;
      col[o] = c.r * b;
      col[o + 1] = c.g * b;
      col[o + 2] = c.b * b;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  };

  show.clear = () => {
    rate = 0;
    salvo = 0;
    wait = 0;
    rockets.length = 0;
    for (const p of sparks) p.life = p.max;
    pos.fill(-500);
    pts.visible = false;
  };

  return show;
}
