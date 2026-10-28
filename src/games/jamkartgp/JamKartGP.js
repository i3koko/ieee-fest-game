import * as THREE from 'three';
import { sfx } from '../../core/audio.js';
import { createEngine, kartSfx, setRain } from './sounds.js';
import { music } from '../../core/music.js';
import { TRACK_W, SAMPLES, FOG, buildTrack, buildBoard, locate, ahead, groundAt, surfaceY, gateHeight } from './track.js';
import { makeKart, MODELS, PALETTE, limitSuspension } from './kart.js';
import { buildWeather } from './weather.js';
import { buildAtmosphere } from './atmosphere.js';
import { createQuality } from './quality.js';

const RACERS = 8;
const GRAVITY = 30;
const LAPS = 2; // a real-circuit lap is long, so two make a booth-sized race
const BOOST_BONUS = 9; // compression adds this to a kart's top speed (m/s)
const BRAKE = 32;
// Sideways grip limit (m/s², scaled by each model's grip): generous, so
// most corners take full throttle and only the tightest hairpins need a lift.
const LAT_G = 38;
const STEER_ANGLE = 0.3; // front wheels' full lock (radians), inside the arches
// Suspension springs (k) and dampers (c) for heave, pitch and roll.
const SUSP = { k: 150, c: 9, kp: 110, cp: 9, kr: 120, cr: 9 };
const SELECT_TIMEOUT = 30;
const EDGE = TRACK_W / 2 + 3.5; // karts can run wide onto the verge, up to the barrier
const ROAD = TRACK_W / 2 - 1.3; // lanes the CPU drivers keep to
const KART_R = 1.45; // collision radius
const BOX_RESPAWN = 3;
const JAM_TIME = 2.6;
const JAM_RANGE = 45; // jammers only reach nearby receivers (all of them)
const SPIN_TIME = 1.1;
const SHIELD_TIME = 8;
const BOOST_TIME = 2.2;
const FIREWALL_LIFE = 14;
const FINISH_GRACE = 25; // seconds the field gets after the winner crosses
const RACE_CAP = 160;
const HUMAN_SLOTS = [4, 5]; // players start mid-pack, so there's someone to chase
const CPU_NAMES = ['PING', 'BYTE', 'ECHO', 'HERTZ', 'NODE', 'RELAY', 'LAG', 'BAUD'];
const ORDINAL = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH'];
const PLACE_POINTS = [6000, 4500, 3500, 2600, 1900, 1300, 800, 400];

// Power-ups are comms tricks; each explains itself when you pick it up.
const ITEMS = {
  jammer: {
    name: 'JAMMER', icon: '≋', color: '#ff4d6d',
    line: 'Floods every receiver near you with noise. Get in close: jammers only reach so far.',
  },
  firewall: {
    name: 'FIREWALL', icon: '▦', color: '#ff8a3d',
    line: 'Drops a wall behind you. Real firewalls block unwanted traffic before it gets into a network.',
  },
  compress: {
    name: 'COMPRESSION', icon: '»', color: '#9dff3a',
    line: 'Boost! Compression sends the same data in fewer bits, so it arrives sooner.',
  },
  shield: {
    name: 'ECC SHIELD', icon: '◈', color: '#7fd4ff',
    line: 'Blocks the next hit. Error-correcting codes add spare bits so damaged data can be repaired.',
  },
};

// Rendering quality. Stage 4 makes this automatic; 'high' for now.

// The mid-race weather change explains itself too.
const RAIN_INFO = {
  name: 'RAIN FADE',
  color: '#7fc8ff',
  line: 'Heavy rain soaks up radio waves, so satellite TV and 5G signals fade in a storm. It soaks up your grip too.',
};

// Track features explain themselves the first time a player meets one.
const HAZARD_INFO = {
  rain: { name: 'WET TRACK', color: '#5fc8ff', line: 'Rain fade: heavy rain soaks up satellite and 5G signals, and it soaks up your grip too.' },
  boost: { name: 'FIBER LINK', color: '#9dff3a', line: 'Light in glass fibre is the fastest way to move data. Ride the strip for a boost.' },
  emi: { name: 'EMI ZONE', color: '#ff5ad8', line: 'Electromagnetic interference: big coils radiate noise that scrambles nearby signals (and your steering).' },
  fan: { name: 'COOLING FAN', color: '#9fd8ff', line: 'Chips run hot, so fans blow the heat away. This one blows karts away too.' },
  gates: { name: 'CLOCK GATES', color: '#ff3b4a', line: 'Digital circuits move in step with a clock. Time your run for the open lane.' },
};

// Keyboard layouts. In one-player mode every key drives player 1.
const KEYS = [
  { left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'], fire: ['Space', 'KeyQ', 'KeyE', 'ShiftLeft'] },
  { left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'], fire: ['Enter', 'ShiftRight', 'Slash', 'NumpadEnter'] },
];
const ALL_KEYS = Object.fromEntries(Object.keys(KEYS[0]).map((k) => [k, [...KEYS[0][k], ...KEYS[1][k]]]));
const FIRE_HINT = ['SPACE', 'ENTER'];

const clamp = THREE.MathUtils.clamp;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function pick(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [k, w] of Object.entries(weights)) if ((r -= w) <= 0) return k;
  return 'compress';
}

function textSprite(text, color, w = 256, h = 256, font = '900 190px "Arial Black", Arial') {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 24;
  g.fillText(text, w / 2, h / 2 + 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class JamKartGP {
  static id = 'jamkartgp';

  // demo: eight CPU karts race forever, silently, behind the title screen.
  constructor(view, hudRoot, { demo = false } = {}) {
    this.view = view;
    this.hudRoot = hudRoot;
    this.demo = demo;
    this.players = 1;
    this.time = 0;
    this.raceTime = 0;
    this.firstFinish = null;
    this.endTimer = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG.color);
    this.scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);
    // Sky, clouds, sun (with shadows), fog and rain.
    this.weather = buildWeather(this.scene, view.renderer);
    this.wet = 0;

    this.track = buildTrack();
    this.board = buildBoard(this.scene, this.track);
    this.#buildBoxes();
    this.#buildSparks();
    this.#buildSpray();
    // Tyre smoke, skid marks, marshals, the TV helicopter and confetti.
    this.atmo = buildAtmosphere(this.scene, this.track, this.board.terrainY);
    // Graphics tier: picked automatically from the frame rate (see quality.js).
    this.quality = createQuality((q) => this.#applyQuality(q));
    this.#applyQuality(this.quality.settings);
    this.walls = [];
    this.rings = [];
    this.karts = Array.from({ length: RACERS }, (_, i) => this.#makeKart(i));
    this.#setHumans();

    if (demo) {
      this.demoCam = new THREE.PerspectiveCamera(62, 1, 0.3, 1200);
      view.use(this.scene, [this.demoCam], { strength: 0.3, radius: 0.4, threshold: 0.95 });
      this.#placeDemoCam(1);
    } else {
      this.#buildHud();
      this.engines = [null, null]; // made once each player's kart is chosen
      this.#useCameras();
    }
  }

  #applyQuality(q) {
    this.view.setPixelRatio(q.pixelRatio);
    this.weather.setQuality(q);
    this.board.setMeadows(q.meadows);
  }

  // The how-to screen's HAZARDS and GRAPHICS settings.
  setOptions({ hazards = 'ALL ON', graphics = 'AUTO' } = {}) {
    this.quality.setMode(graphics);
    const presets = {
      'ALL ON': { rain: true, boost: true, gates: true },
      'NO GATES': { rain: true, boost: true },
      'BOOST ONLY': { boost: true },
      OFF: {},
    };
    this.board.setHazards(presets[hazards] ?? presets['ALL ON']);
  }

  // Called by the arcade when the how-to screen's mode picker is confirmed.
  setMode(index) {
    this.players = index + 1;
    this.#setHumans();
    this.#useCameras();
  }

  // One full-screen view for a single player, side by side for two.
  #useCameras() {
    const cams = this.karts.filter((k) => k.human).map((k) => k.cam);
    this.view.use(this.scene, cams, { strength: 0.3, radius: 0.4, threshold: 0.95 });
    this.ui?.root.classList.toggle('solo', cams.length === 1);
    for (const k of this.karts) this.#placeCamera(k, 1);
  }

  #setHumans() {
    const cpuColors = [...PALETTE.keys()].filter((c) => !this.karts.some((k) => k.i < this.players && k.colorIdx === c));
    let cpu = 0;
    this.karts.forEach((k, i) => {
      k.human = !this.demo && i < this.players;
      k.label = k.human ? `P${i + 1}` : CPU_NAMES[i];
      if (!k.human) {
        k.colorIdx = cpuColors[cpu++ % cpuColors.length];
        k.ready = true;
      }
    });
    this.#placeGrid();
    if (this.ui) this.#refreshTags();
  }

  // Staggered two-wide grid behind the line. Players take the middle slots.
  #placeGrid() {
    const { pts, tan, side } = this.track;
    this.atmo.reset();
    const slots = [...Array(RACERS).keys()].filter((s) => this.demo || !HUMAN_SLOTS.slice(0, this.players).includes(s));
    this.karts.forEach((k) => {
      const slot = k.human ? HUMAN_SLOTS[k.i] : slots.shift();
      const row = Math.floor(slot / 2);
      const col = slot % 2;
      const back = 3 + row * 6 + col * 2;
      const idx = (SAMPLES + 4 - back) % SAMPLES;
      const lat = col === 0 ? 2.8 : -2.8;
      const p = pts[idx];
      Object.assign(k, {
        x: p.x + side[idx].x * lat, z: p.y + side[idx].y * lat,
        h: Math.atan2(tan[idx].x, tan[idx].y), vx: 0, vz: 0, v: 0, vl: 0, y: surfaceY(this.track, idx, lat), vy: 0, air: false, airT: 0,
        idx, lastIdx: idx, lat, lap: idx > SAMPLES / 2 ? -1 : 0, place: slot,
      });
      this.#rebuild(k);
    });
  }

  // ---------------------------------------------------------------- setup

  #makeKart(i) {
    const k = {
      i, parts: null, human: false, label: CPU_NAMES[i], ready: false, menuPrev: null,
      model: this.demo || i > 1 ? Math.floor(Math.random() * MODELS.length) : i === 0 ? 0 : 2,
      colorIdx: i % PALETTE.length,
      x: 0, z: 0, h: 0, vx: 0, vz: 0, v: 0, vl: 0, steerVis: 0, roll: 0, pitch: 0,
      idx: 0, lastIdx: 0, lat: 0, lap: 0, prog: 0, place: i,
      finished: false, finishTime: 0, finalPlace: null, lapStart: 0, bestLap: Infinity,
      item: null, boostT: 0, jamT: 0, shieldT: 0, spinT: 0, spinA: 0, scrapeT: 0, wrongT: 0,
      item2: null, emiT: 0, gateT: 0, susp: { y: 0, vy: 0, pitch: 0, pv: 0, roll: 0, rv: 0 }, seen: new Set(), groundPitch: 0, groundRoll: 0,
      y: 0, vy: 0, air: false, airT: 0,
      hits: 0, used: 0, prevFire: true, cpuDelay: 0, cpuLane: (Math.random() - 0.5) * 6, squash: 1,
      skill: 0.88 + Math.random() * 0.1, // CPU pace, as a share of the kart's top speed
      cam: new THREE.PerspectiveCamera(70, 1, 0.3, 1200), camPos: new THREE.Vector3(), camLook: new THREE.Vector3(),
    };
    return k;
  }

  // Swaps in the kart's chosen model and colour.
  #rebuild(k) {
    if (k.parts) {
      this.scene.remove(k.parts.group);
      k.parts.group.traverse((o) => o.isMesh && [].concat(o.material).forEach((m) => m.dispose()));
    }
    k.spec = MODELS[k.model];
    k.color = PALETTE[k.colorIdx];
    k.parts = makeKart(k.spec.id, k.color);
    k.parts.group.rotation.order = 'YXZ'; // yaw, then the road's slope and bank
    this.scene.add(k.parts.group);
    this.#animateKart(k, 0);
  }

  #buildBoxes() {
    const tex = textSprite('?', '#ffffff');
    const geo = new THREE.BoxGeometry(1.8, 1.8, 1.8);
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0x9dff3a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xd8ffb0 });
    const edges = new THREE.EdgesGeometry(geo);
    this.boxes = [];
    for (const f of [0.14, 0.38, 0.6, 0.82]) {
      const i = Math.floor(f * SAMPLES);
      for (const lat of [-4.2, -1.4, 1.4, 4.2]) {
        const p = this.track.pts[i];
        const s = this.track.side[i];
        const mesh = new THREE.Mesh(geo, mat);
        mesh.add(new THREE.LineSegments(edges, edgeMat));
        const x = p.x + s.x * lat;
        const z = p.y + s.y * lat;
        const y = surfaceY(this.track, i, lat) + 1.4;
        mesh.position.set(x, y, z);
        this.scene.add(mesh);
        this.boxes.push({ mesh, x, z, y, t: 0 });
      }
    }
  }

  // Pooled spark particles for wall hits and bumps.
  #buildSparks() {
    const n = 400;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.sparkPts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.35, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.sparkPts.frustumCulled = false;
    this.scene.add(this.sparkPts);
    this.sparks = Array.from({ length: n }, () => ({ life: 0, x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, floor: 0, c: new THREE.Color() }));
    this.sparkNext = 0;
  }

  #spark(x, y, z, color, count, speed = 6) {
    for (let n = 0; n < count; n++) {
      const s = this.sparks[this.sparkNext++ % this.sparks.length];
      s.life = 0.4 + Math.random() * 0.4;
      s.floor = y - 0.4;
      s.x = x;
      s.y = y;
      s.z = z;
      s.vx = (Math.random() - 0.5) * speed;
      s.vy = Math.random() * speed * 0.8;
      s.vz = (Math.random() - 0.5) * speed;
      s.c.setHex(color);
    }
  }

  #updateSparks(dt) {
    const pos = this.sparkPts.geometry.attributes.position;
    const col = this.sparkPts.geometry.attributes.color;
    this.sparks.forEach((s, n) => {
      if (s.life > 0) {
        s.life -= dt;
        s.vy -= 18 * dt;
        s.x += s.vx * dt;
        s.y = Math.max(s.floor, s.y + s.vy * dt);
        s.z += s.vz * dt;
      }
      const fade = Math.max(0, Math.min(1, s.life * 2.5));
      pos.setXYZ(n, s.x, s.life > 0 ? s.y : -10, s.z);
      col.setXYZ(n, s.c.r * fade, s.c.g * fade, s.c.b * fade);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  #buildHud() {
    const half = (i) => `
      <div class="jk-half p${i}" data-half="${i}">
        <div class="jk-head">
          <div class="jk-tag" data-tag></div>
          <div class="jk-place" data-place>1ST</div>
          <div class="jk-lap" data-lap>LAP 1/${LAPS}</div>
        </div>
        <div class="jk-speed" data-speed>0<small>KM/H</small></div>
        <div class="jk-item" data-item><div class="slot" data-slot></div><div class="slot2" data-slot2></div><div class="key" data-key></div></div>
        <div class="jk-card" data-card><b></b><span></span></div>
        <div class="jk-big" data-big></div>
        <div class="static" data-static></div>
        <div class="jk-select" data-select>
          <div class="jk-sel-who" data-who></div>
          <div class="jk-sel-model"><span>◀</span><b data-mname></b><span>▶</span></div>
          <div class="jk-sel-blurb" data-blurb></div>
          <div class="jk-sel-stats" data-stats></div>
          <div class="jk-sel-perk" data-perk></div>
          <div class="jk-sel-colors" data-colors></div>
          <div class="jk-sel-ready" data-ready></div>
        </div>
      </div>`;
    this.hudRoot.innerHTML = `
      <div class="ghud jamkart">
        ${half(0)}${half(1)}
        <div class="jk-divider"></div>
        <div class="jk-timer" data-timer>0:00.0</div>
        <ol class="jk-board" data-board></ol>
        <svg class="jk-map" data-map></svg>
      </div>`;
    const root = this.hudRoot.firstElementChild;
    this.ui = {
      root,
      timer: root.querySelector('[data-timer]'),
      board: root.querySelector('[data-board]'),
      halves: [0, 1].map((i) => {
        const h = root.querySelector(`[data-half="${i}"]`);
        const q = (k) => h.querySelector(`[data-${k}]`);
        return {
          root: h, tag: q('tag'), place: q('place'), lap: q('lap'), speed: q('speed'), item: q('item'), slot: q('slot'), slot2: q('slot2'), key: q('key'), card: q('card'), big: q('big'), static: q('static'), cardT: 0, bigT: 0,
          who: q('who'), mname: q('mname'), blurb: q('blurb'), stats: q('stats'), perk: q('perk'), colors: q('colors'), ready: q('ready'),
        };
      }),
    };
    this.ui.board.innerHTML = this.karts.map(() => '<li><i></i><span></span></li>').join('');
    this.#buildMap(root.querySelector('[data-map]'));
    this.#refreshTags();
  }

  #buildMap(svg) {
    const pts = this.track.pts;
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.y);
    const pad = 14;
    const minX = Math.min(...xs) - pad;
    const minZ = Math.min(...zs) - pad;
    const w = Math.max(...xs) + pad - minX;
    const h = Math.max(...zs) + pad - minZ;
    svg.setAttribute('viewBox', `${minX} ${minZ} ${w} ${h}`);
    const d = pts.filter((_, i) => i % 8 === 0).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + 'Z';
    svg.innerHTML = `<path d="${d}" class="road"/><path d="${d}" class="line"/>` +
      this.karts.map((_, i) => `<circle data-dot="${i}"/>`).join('');
    this.ui.dots = this.karts.map((_, i) => svg.querySelector(`[data-dot="${i}"]`));
  }

  #refreshTags() {
    const pads = this.#pads().length;
    this.karts.forEach((k, i) => {
      const dot = this.ui.dots[i];
      dot.setAttribute('fill', hex(k.color));
      dot.setAttribute('r', k.human ? 9 : 6);
      dot.classList.toggle('human', k.human);
      if (i > 1) return;
      const h = this.ui.halves[i];
      h.tag.textContent = `PLAYER ${i + 1}`;
      h.tag.style.color = hex(k.color);
      const key = this.players === 1 ? 'SPACE' : FIRE_HINT[i];
      h.key.textContent = k.human ? `${key}${pads > i || (this.players === 1 && pads) ? ' / Ⓐ' : ''}` : '';
    });
  }

  // ---------------------------------------------------------------- input

  #pads() {
    return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  }

  #controls(k) {
    const keys = this.input.keys;
    const solo = this.players === 1;
    const map = solo ? ALL_KEYS : KEYS[k.i];
    const has = (list) => list.some((c) => keys.has(c));
    const allPads = this.#pads();
    const pads = solo ? allPads : allPads[k.i] ? [allPads[k.i]] : [];
    let steer = (has(map.right) ? 1 : 0) - (has(map.left) ? 1 : 0);
    let brake = has(map.down);
    let fire = has(map.fire);
    for (const p of pads) {
      const x = p.axes[0] ?? 0;
      if (Math.abs(x) > 0.18) steer = x;
      if (p.buttons[14]?.pressed) steer = -1;
      if (p.buttons[15]?.pressed) steer = 1;
      brake ||= [1, 4, 6, 13].some((b) => p.buttons[b]?.pressed) || (p.axes[1] ?? 0) > 0.6;
      fire ||= [0, 2, 3, 5].some((b) => p.buttons[b]?.pressed);
    }
    const pressed = fire && !k.prevFire;
    k.prevFire = fire;
    return { steer: clamp(steer, -1, 1), brake, fire: pressed };
  }

  // Follows the racing line, grabs boxes, dodges firewalls and other karts,
  // and uses items sensibly. Pace is set per CPU and rubber-banded to the
  // players so the pack stays around them.
  #cpu(k, dt, slow = 1) {
    const { pts, side, tan } = this.track;
    if (!k.item) {
      const box = this.boxes.find((b) => b.t <= 0 && this.#along(k, b.x, b.z) > 10 && this.#along(k, b.x, b.z) < 45);
      if (box) k.cpuLane = clamp(locate(this.track, box.x, box.z, k.idx).lat, -ROAD, ROAD);
    }
    for (const w of this.walls) {
      const d = this.#along(k, w.x, w.z);
      if (d > 0 && d < 35) k.cpuLane = w.lat > 0 ? -3.5 : 3.5;
    }
    // Track features: dodge flux, aim for boost strips, pick the open gate.
    for (const zn of this.board.hazards.zones) {
      const d = (zn.i0 - k.idx + SAMPLES) % SAMPLES;
      if (d > 45) continue;
      const mid = (zn.lat[0] + zn.lat[1]) / 2;
      if (zn.type === 'rain') k.cpuLane = mid > 0 ? -3.5 : 3.5;
      if (zn.type === 'boost' && !k.item) k.cpuLane = clamp(mid, -ROAD, ROAD);
    }
    for (const g of this.board.hazards.gates) {
      const d = ((g.i - k.idx + SAMPLES) % SAMPLES) * this.track.dist[1];
      if (d > 70 || d < 4) continue;
      const arrive = this.time + d / Math.max(k.v, 10);
      const open = [...this.board.hazards.gates].sort((a, b) => gateHeight(a, arrive) - gateHeight(b, arrive))[0];
      k.cpuLane = open.lat;
      break;
    }
    // Pull out to pass a slower kart just ahead.
    for (const o of this.karts) {
      if (o === k) continue;
      const d = this.#along(k, o.x, o.z);
      if (d > 0 && d < 9 && Math.abs(o.lat - k.lat) < 2.6 && o.v < k.v) k.cpuLane = clamp(o.lat + (o.lat > 0 ? -3.2 : 3.2), -ROAD, ROAD);
    }
    const look = ahead(k.idx, 10 + Math.floor(Math.max(k.v, 0) * 0.3));
    const tx = pts[look].x + side[look].x * k.cpuLane;
    const tz = pts[look].y + side[look].y * k.cpuLane;
    const err = wrapAngle(Math.atan2(tx - k.x, tz - k.z) - k.h);
    const bend = Math.abs(wrapAngle(Math.atan2(tan[ahead(k.idx, 40)].x, tan[ahead(k.idx, 40)].y) - Math.atan2(tan[k.idx].x, tan[k.idx].y)));

    const top = k.spec.top;
    let pace = top * k.skill;
    const humans = this.karts.filter((o) => o.human);
    if (humans.length) {
      const gap = Math.max(...humans.map((o) => o.prog)) - k.prog; // + means a player is ahead
      pace += clamp(gap * 0.025, -5, 2.5);
    }
    k.maxV = (this.demo ? top - 2 - k.i * 0.2 : pace) * slow;

    let fire = false;
    if (k.item && (k.cpuDelay -= dt) <= 0) {
      const near = this.karts.filter((o) => o !== k && Math.hypot(o.x - k.x, o.z - k.z) < JAM_RANGE * k.spec.jamRange * 0.8);
      const chaser = this.karts.some((o) => o !== k && o.prog < k.prog && k.prog - o.prog < 40);
      fire =
        k.item === 'shield' ||
        (k.item === 'compress' && bend < 0.5) ||
        (k.item === 'jammer' && near.length > 0) ||
        (k.item === 'firewall' && chaser) ||
        k.cpuDelay < -8;
    }
    return { steer: clamp(-err * 2.6, -1, 1), brake: this.#needsBrake(k), fire };
  }

  // How hard kart k can corner right now (m/s²).
  #latGrip(k, zone) {
    const offRoad = Math.abs(k.lat) > TRACK_W / 2 + 0.3;
    return LAT_G * (k.spec.grip / 15) * (zone?.type === 'rain' ? 0.6 : 1) * (offRoad ? 0.75 : 1) * (1 - 0.18 * this.wet);
  }

  // Weather follows the race: sunny with drifting clouds for most of lap 1,
  // the sky darkens late in the lap, and it rains on lap 2. The title screen
  // drifts between sunshine and showers.
  #updateWeather(dt, live) {
    const smooth = (a, b, v) => {
      const t = clamp((v - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
    const leader = Math.max(...this.karts.map((k) => k.prog)) / this.track.length;
    const x = this.forceWeather ?? (this.demo ? 0.6 + 0.65 * Math.sin(this.time / 30) : live || this.endTimer !== null ? leader : 0);
    // Clouds build over most of the first lap; the rain sets in gradually
    // through the start of the second.
    this.weather.set(0.12 + 0.88 * smooth(0.3, 1.0, x), smooth(0.85, 1.4, x), dt);
    this.wet = this.weather.wet;
    this.board.setWet(this.wet);

    const humans = this.karts.filter((k) => k.human);
    const focuses = this.demo ? [this.demoCam.position] : humans.map((k) => k.cam.position);
    const watched = this.demo ? [this.karts.find((k) => k.place === 0) ?? this.karts[0]] : humans;
    const centre = new THREE.Vector3();
    for (const k of watched) centre.add(new THREE.Vector3(k.x, k.y, k.z));
    centre.divideScalar(watched.length);
    this.weather.update(dt, this.time, focuses, centre);

    if (!this.demo && live && !this.rainWarned && x > 0.75) {
      this.rainWarned = true;
      for (const k of humans) {
        this.#big(k, 'RAIN IS COMING!', 'warn', 2);
        this.#card(k, RAIN_INFO);
      }
    }
    // Thunder now and then in a downpour.
    if (!this.demo && this.wet > 0.6 && Math.random() < dt / 10) {
      this.weather.flash();
      setTimeout(() => kartSfx.thunder(), 600 + Math.random() * 900);
    }
  }

  // Spray thrown up behind the wheels on a wet track.
  #buildSpray() {
    const n = 500;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // Soft round puffs, not square points.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprayPts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 1.4, map: new THREE.CanvasTexture(c), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.sprayPts.frustumCulled = false;
    this.scene.add(this.sprayPts);
    this.spray = Array.from({ length: n }, () => ({ life: 0, x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0 }));
    this.sprayNext = 0;
  }

  #updateSpray(dt) {
    if (this.wet > 0.25) {
      for (const k of this.karts) {
        if (Math.abs(k.v) < 10 || Math.random() > this.wet * 0.9) continue;
        const fx = Math.sin(k.h);
        const fz = Math.cos(k.h);
        for (const s of [-1, 1]) {
          const p = this.spray[this.sprayNext++ % this.spray.length];
          p.life = 0.5 + Math.random() * 0.3;
          p.x = k.x - fx * 1.6 + fz * s * 1.0;
          p.y = k.y + 0.25;
          p.z = k.z - fz * 1.6 - fx * s * 1.0;
          p.vx = k.vx * 0.3 + (Math.random() - 0.5) * 2;
          p.vy = 1 + Math.random() * 1.5;
          p.vz = k.vz * 0.3 + (Math.random() - 0.5) * 2;
        }
      }
    }
    const pos = this.sprayPts.geometry.attributes.position;
    const col = this.sprayPts.geometry.attributes.color;
    this.spray.forEach((p, n) => {
      if (p.life > 0) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vx *= 1 - 2 * dt;
        p.vz *= 1 - 2 * dt;
      }
      const a = Math.max(0, Math.min(1, p.life * 2)) * 0.35;
      pos.setXYZ(n, p.x, p.life > 0 ? p.y : -10, p.z);
      col.setXYZ(n, a, a * 1.02, a * 1.06);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // CPU braking: look down the road and brake if a corner ahead needs a
  // lower speed than we could scrub off before reaching it.
  #needsBrake(k) {
    const { curv, dist } = this.track;
    const grip = LAT_G * (k.spec.grip / 15) * 0.85;
    for (let j = 3; j < 70; j += 3) {
      const c = Math.abs(curv[ahead(k.idx, j)]);
      if (c < 1e-3) continue;
      const vMax = Math.sqrt(grip / c);
      if (k.v <= vMax) continue;
      const room = j * dist[1];
      if ((k.v * k.v - vMax * vMax) / (2 * BRAKE * 0.85) >= room - 2) return true;
    }
    return false;
  }

  // Signed distance of a point ahead of kart k along its heading.
  #along(k, x, z) {
    return (x - k.x) * Math.sin(k.h) + (z - k.z) * Math.cos(k.h);
  }

  // ---------------------------------------------------------------- select

  // Kart select, run by the arcade between the how-to and the countdown.
  // Each player picks a model (left/right) and colour (up/down), then readies
  // up. Returns true once everyone is ready.
  updateSelect(dt, input) {
    this.input = input;
    this.time += dt;
    if (!this.selecting) this.#startSelect();
    this.selectT += dt;

    for (const k of this.karts) {
      if (!k.human || k.ready) continue;
      const e = this.#menuEdges(k);
      const dm = (e.right ? 1 : 0) - (e.left ? 1 : 0);
      const dc = (e.down ? 1 : 0) - (e.up ? 1 : 0);
      if (dm) {
        k.model = (k.model + dm + MODELS.length) % MODELS.length;
        this.#rebuild(k);
        sfx.move();
      }
      if (dc) {
        const taken = this.karts.find((o) => o !== k && o.human)?.colorIdx;
        do k.colorIdx = (k.colorIdx + dc + PALETTE.length) % PALETTE.length;
        while (k.colorIdx === taken);
        k.color = PALETTE[k.colorIdx];
        k.parts.setColor(k.color);
        sfx.move();
      }
      if (e.fire && this.selectT > 0.4) {
        k.ready = true;
        sfx.select();
      }
      if (dm || dc || e.fire) this.#renderSelect(k);
    }

    // Showroom: each player's camera circles their kart.
    this.karts.forEach((k, i) => {
      if (!k.human) return;
      const a = this.time * 0.45 + i * Math.PI + 0.6;
      k.cam.position.set(k.x + Math.sin(k.h + a) * 6.8, k.y + 2.6, k.z + Math.cos(k.h + a) * 6.8);
      k.cam.lookAt(k.x, k.y + 0.9, k.z);
    });
    this.board.update(this.time);
    this.#updateAudio(false);
    this.view.render();

    const done = this.karts.every((k) => !k.human || k.ready) || this.selectT > SELECT_TIMEOUT;
    if (!done) return false;
    this.selecting = false;
    this.preT = 0; // time on the grid, for the start lights
    this.ui.root.classList.remove('selecting');
    // CPUs take whichever colours the players left free.
    this.#setHumans();
    for (const k of this.karts) this.#placeCamera(k, 1);
    return true;
  }

  #startSelect() {
    this.selecting = true;
    this.selectT = 0;
    for (const k of this.karts.filter((o) => o.human)) {
      // Player 2's kart starts life as a CPU (marked ready) until 2-player
      // mode is picked, so every player must start the select un-readied.
      k.ready = false;
      k.menuPrev = { left: true, right: true, up: true, down: true, fire: true };
      this.#renderSelect(k);
    }
    this.ui.root.classList.add('selecting');
  }

  // Button presses (not holds) for the select screen.
  #menuEdges(k) {
    const keys = this.input.keys;
    const solo = this.players === 1;
    const map = solo ? ALL_KEYS : KEYS[k.i];
    const has = (list) => list.some((c) => keys.has(c));
    const allPads = this.#pads();
    const pads = solo ? allPads : allPads[k.i] ? [allPads[k.i]] : [];
    const now = { left: has(map.left), right: has(map.right), up: has(map.up), down: has(map.down), fire: has(map.fire) };
    for (const p of pads) {
      const [x = 0, y = 0] = p.axes;
      now.left ||= x < -0.6 || p.buttons[14]?.pressed;
      now.right ||= x > 0.6 || p.buttons[15]?.pressed;
      now.up ||= y < -0.6 || p.buttons[12]?.pressed;
      now.down ||= y > 0.6 || p.buttons[13]?.pressed;
      now.fire ||= [0, 9].some((b) => p.buttons[b]?.pressed);
    }
    const edges = {};
    for (const key of Object.keys(now)) edges[key] = now[key] && !k.menuPrev[key];
    k.menuPrev = now;
    return edges;
  }

  #renderSelect(k) {
    const h = this.ui.halves[k.i];
    const m = k.spec;
    h.who.textContent = `PLAYER ${k.i + 1}`;
    h.who.style.color = hex(k.color);
    h.mname.textContent = m.name;
    h.blurb.textContent = m.blurb;
    h.stats.innerHTML = Object.entries(m.stats)
      .map(([name, n]) => `<div><span>${name}</span><i>${'<b></b>'.repeat(n)}${'<b class="off"></b>'.repeat(5 - n)}</i></div>`)
      .join('');
    h.perk.innerHTML = `<b>PERK</b> ${m.perk}`;
    h.colors.innerHTML = PALETTE.map((c, n) => `<i class="${n === k.colorIdx ? 'on' : ''}" style="background:${hex(c)}"></i>`).join('');
    const keys = this.players === 1 ? ['◀ ▶', '▲ ▼', 'SPACE'] : [['A D', 'W S', 'SPACE'], ['◀ ▶', '▲ ▼', 'ENTER']][k.i];
    h.ready.innerHTML = k.ready
      ? '<span class="go">READY!</span>'
      : `<b>${keys[0]}</b> KART · <b>${keys[1]}</b> COLOUR · <b>${keys[2]}</b> READY`;
    h.root.classList.toggle('is-ready', k.ready);
  }

  // ---------------------------------------------------------------- loop

  update(dt, input, live) {
    this.input = input;
    this.time += dt;
    if (live && !this.endTimer) this.raceTime += dt;

    for (const k of this.karts) {
      let ctl = { steer: 0, brake: false, fire: false };
      if (live) ctl = k.human && !k.finished ? this.#controls(k) : this.#cpu(k, dt, k.finished ? 0.6 : 1);
      if (k.human && !k.finished) k.maxV = k.spec.top;
      this.#drive(k, ctl, dt, live);
      if (live) this.#gates(k);
      if (ctl.fire && k.item && live) this.#useItem(k);
    }
    this.#bump();
    // Shoves move karts sideways after their height was set; settle them
    // back onto the ground so nobody ends up inside a slope.
    for (const k of this.karts) {
      const loc = locate(this.track, k.x, k.z, k.idx);
      k.idx = loc.i;
      k.lat = loc.lat;
      k.y = groundAt(this.track, k.idx, k.x, k.z, k.lat);
    }
    this.#updateBoxes(dt);
    this.#updateWalls(dt);
    this.#updateRings(dt);
    this.#updateSparks(dt);
    this.#rank();
    for (const k of this.karts) {
      this.#animateKart(k, dt);
      if (k.human) this.#placeCamera(k, dt);
    }
    // A kart right on top of a chase camera would fill the screen; hide it.
    const cams = this.karts.filter((k) => k.human).map((k) => k.cam.position);
    for (const k of this.karts) {
      if (k.human) continue;
      k.parts.group.visible = !cams.some((c) => (c.x - k.x) ** 2 + (c.y - k.y - 1) ** 2 + (c.z - k.z) ** 2 < 4.2 ** 2);
    }
    this.board.update(this.time);
    // Start lights: one pair every 0.6 s on the grid, all out for GO.
    if (!this.demo && this.preT !== undefined) {
      if (!live) this.preT += dt;
      this.board.setStartLights(live ? 0 : Math.min(5, Math.floor(this.preT / 0.6)));
    }
    for (const l of this.board.lights) l.mat.color.copy(l.base).multiplyScalar(0.6 + 0.4 * Math.sin(this.time * 3 + l.phase));
    this.#updateWeather(dt, live);
    this.#updateSpray(dt);
    this.atmo.update(dt, this.time, this.karts, { wet: this.wet, live, raceTime: this.raceTime, finishing: this.firstFinish !== null });

    if (this.demo) this.#placeDemoCam(dt);
    else {
      this.#updateHud(dt);
      this.#updateAudio(live);
    }
    this.view.render();
    this.quality.sample();

    if (!live || this.demo) return null;
    const humans = this.karts.filter((k) => k.human);
    const done =
      humans.every((k) => k.finished) ||
      (this.firstFinish !== null && this.raceTime > this.firstFinish + FINISH_GRACE) ||
      this.raceTime > RACE_CAP;
    if (done && this.endTimer === null) this.endTimer = 2.5;
    if (this.endTimer !== null && (this.endTimer -= dt) <= 0) return this.#result();
    return null;
  }

  // Kart-racer handling: the kart goes where you point it. Steering is quick
  // and stays sharp at speed, tyres grip hard (just a hint of slide), only
  // the very tightest corners at full speed need a lift, and barriers bounce
  // you back onto the track. A spring-damper suspension moves the body.
  #drive(k, ctl, dt, live) {
    const { tan, side } = this.track;
    for (const t of ['boostT', 'jamT', 'shieldT', 'spinT', 'scrapeT', 'emiT', 'gateT']) k[t] = Math.max(0, k[t] - dt);
    const zone = live ? this.#zoneAt(k) : null;
    if (zone) this.#enterZone(k, zone, dt);

    const fx = Math.sin(k.h);
    const fz = Math.cos(k.h);
    let vf = k.vx * fx + k.vz * fz; // forward speed
    let vl = k.vx * fz - k.vz * fx; // sideways slide
    const vfIn = vf;

    const top = k.maxV ?? k.spec.top;
    // Running wide onto the grass costs speed.
    const offRoad = Math.abs(k.lat) > TRACK_W / 2 + 0.3;
    const maxV = (k.boostT > 0 ? top + BOOST_BONUS : top) * (k.jamT > 0 ? 0.8 : 1) * (offRoad ? k.spec.offroad ?? 0.62 : 1);

    // Engine and brakes. Holding brake only ever slows you down.
    if (!live) vf = 0;
    else if (k.spinT > 0) vf = Math.max(0, vf - 40 * dt);
    else if (ctl.brake) vf = Math.max(-8, vf - BRAKE * dt);
    else if (vf < maxV) {
      // Snappy pull off the line that tapers off near top speed.
      const accel = k.boostT > 0 ? 45 : k.spec.accel * (1.35 - 0.9 * clamp(vf / maxV, 0, 1));
      vf = Math.min(maxV, vf + accel * dt);
    } else vf = Math.max(maxV, vf - 20 * dt);

    // Hills: gravity slows you climbing and speeds you up coming down.
    const { height, dist } = this.track;
    const climb = (height[ahead(k.idx, 2)] - height[ahead(k.idx, -2)]) / (4 * dist[1]);
    const along = fx * tan[k.idx].x + fz * tan[k.idx].y;
    const slope = climb * along;
    if (live) vf -= 9.8 * slope * dt;

    // Steering: responds almost instantly and keeps its bite at speed.
    let steer = k.spinT > 0 ? 0 : ctl.steer;
    if (k.jamT > 0) steer = clamp(steer + Math.sin(this.time * 11 + k.i * 2) * 0.6, -1, 1);
    if (k.emiT > 0) steer = clamp(steer + Math.sin(this.time * 17 + k.i) * 0.35, -1, 1);
    k.steerVis += (steer - k.steerVis) * Math.min(dt * 14, 1);
    const turnable = clamp(Math.abs(vf) / 4, 0, 1);
    let yaw = k.steerVis * k.spec.turn * turnable * Math.sign(vf || 1);
    // Only the tightest corners at full speed run out of grip.
    const yawCap = this.#latGrip(k, zone) / Math.max(Math.abs(vf), 4);
    yaw = clamp(yaw, -yawCap, yawCap);

    // Tyres kill nearly all sideways slide (wet track and grass let go more).
    const grip = k.spec.grip * 1.6 * (zone?.type === 'rain' ? 0.3 : 1) * (offRoad ? 0.75 : 1) * (1 - 0.3 * this.wet);
    vl *= Math.exp(-grip * dt);

    k.vx = fx * vf + fz * vl;
    k.vz = fz * vf - fx * vl;
    k.h -= yaw * dt;
    k.v = vf;
    k.vl = vl;
    // Tyres scrabbling: the moment you stamp on the brakes at speed, a spin,
    // a big slide or the launch off the line.
    // (CPU drivers pulse the brakes, so only one lock-up every few seconds.)
    k.lockT = Math.max(0, (k.lockT ?? 0) - dt);
    k.lockCool = Math.max(0, (k.lockCool ?? 0) - dt);
    if (ctl.brake && !k.wasBraking && vfIn > 20 && k.lockCool === 0) {
      k.lockT = 0.35;
      k.lockCool = 4;
    }
    k.wasBraking = ctl.brake;
    const lockUp = ctl.brake && k.lockT > 0;
    k.skid = live && Math.abs(vfIn) > 2 && (lockUp || k.spinT > 0 || Math.abs(vl) > 2.5 || (this.raceTime < 1.2 && !ctl.brake));
    k.x += k.vx * dt;
    k.z += k.vz * dt;

    // Barriers: bounce off them (some speed lost on a hard hit) and get
    // turned back along the track.
    let loc = locate(this.track, k.x, k.z, k.idx);
    // A hard shove can carry a kart past the local search; find it again.
    if (Math.abs(loc.lat) > TRACK_W) loc = locate(this.track, k.x, k.z);
    k.idx = loc.i;
    k.lat = loc.lat;
    if (Math.abs(k.lat) > EDGE) {
      const s = Math.sign(k.lat);
      const nx = side[k.idx].x * s;
      const nz = side[k.idx].y * s;
      const over = Math.abs(k.lat) - EDGE;
      k.x -= nx * over;
      k.z -= nz * over;
      k.lat = s * EDGE;
      const into = k.vx * nx + k.vz * nz;
      if (into > 0) {
        k.vx -= nx * into * 1.45;
        k.vz -= nz * into * 1.45;
        if (into > 5) {
          k.vx *= 0.88;
          k.vz *= 0.88;
          k.susp.vy -= into * 0.12;
          k.susp.rv += s * into * 0.05;
          this.#spark(k.x + nx * 1.2, k.y + 0.6, k.z + nz * 1.2, 0xffc060, 8, 7);
          if (k.human && live && k.scrapeT <= 0) kartSfx.bump();
          k.scrapeT = 0.25;
        }
      }
      const trackH = Math.atan2(tan[k.idx].x, tan[k.idx].y);
      const off = wrapAngle(k.h - trackH);
      if (Math.abs(off) < Math.PI / 2) k.h -= off * Math.min(dt * 5, 1);
    }

    // Height: karts stay planted on the tarmac, kerbs and verges.
    const ground = groundAt(this.track, k.idx, k.x, k.z, k.lat);
    const vy = dt > 0 ? clamp((ground - k.y) / dt, -40, 40) : 0;
    k.vy = vy;
    k.y = ground;
    // The body feels the road's rise and fall smoothed (the road is built
    // from short straight pieces, so raw changes come in tiny steps).
    const vyS = (k.vyS ?? 0) + (vy - (k.vyS ?? 0)) * Math.min(dt * 10, 1);
    const groundAccel = dt > 0 ? (vyS - (k.vyS ?? 0)) / dt : 0;
    k.vyS = vyS;
    const bank = this.track.bank[k.idx] * along;
    k.groundPitch += (-Math.atan(slope) - k.groundPitch) * Math.min(dt * 8, 1);
    k.groundRoll += (-Math.atan(bank) - k.groundRoll) * Math.min(dt * 8, 1);

    this.#suspension(k, dt, live, {
      groundAccel,
      longAccel: dt > 0 ? (vf - vfIn) / dt : 0,
      latAccel: vf * yaw,
      kerb: Math.abs(k.lat) > TRACK_W / 2 - 1.2 && Math.abs(k.lat) < TRACK_W / 2 && Math.abs(this.track.curv[k.idx]) > 0.012,
      offRoad,
    });

    // Laps: crossing the line forwards counts, backwards un-counts.
    if (k.lastIdx > SAMPLES * 0.85 && k.idx < SAMPLES * 0.15) this.#crossLine(k);
    else if (k.lastIdx < SAMPLES * 0.15 && k.idx > SAMPLES * 0.85) k.lap--;
    k.lastIdx = k.idx;
    k.prog = k.lap * this.track.length + this.track.dist[k.idx];

    const trackH = Math.atan2(tan[k.idx].x, tan[k.idx].y);
    k.wrongT = Math.abs(wrapAngle(k.h - trackH)) > 2 && vf > 2 ? k.wrongT + dt : 0;
  }

  // Spring-damper suspension for the body: it heaves over crests and dips,
  // squats when accelerating, dives under braking, rolls in corners, and
  // rattles over kerbs and grass. Heavier karts sit softer and slower.
  #suspension(k, dt, live, { groundAccel, longAccel, latAccel, kerb, offRoad }) {
    if (dt <= 0) return;
    const s = k.susp;
    const m = k.spec.mass;
    const speed = Math.abs(k.v);
    // Heave: the body lags the wheels when the ground pushes up or drops.
    let force = -SUSP.k / m * s.y - SUSP.c / Math.sqrt(m) * s.vy - groundAccel * 0.35;
    if (live && kerb) force += (Math.random() - 0.5) * speed * 16;
    if (live && offRoad) force += (Math.random() - 0.5) * speed * 7;
    s.vy += force * dt;
    s.y = clamp(s.y + s.vy * dt, -0.15, 0.15);
    // Pitch: nose dips under braking, lifts under power.
    s.pv += (-SUSP.kp / m * s.pitch - SUSP.cp * s.pv - longAccel * 0.16) * dt;
    s.pitch = clamp(s.pitch + s.pv * dt, -0.12, 0.12);
    // Roll: the body leans out of the corner.
    s.rv += (-SUSP.kr / m * s.roll - SUSP.cr * s.rv - latAccel * 0.2) * dt;
    s.roll = clamp(s.roll + s.rv * dt, -0.16, 0.16);
    // Never let the body come down onto the tyres.
    limitSuspension(k.parts, s);
  }

  #land(k, ground) {
    const impact = -k.vy;
    k.y = ground;
    k.vy = 0;
    k.air = false;
    if (k.airT > 0.5) {
      // Big air pays out a little boost.
      k.boostT = Math.max(k.boostT, 0.6);
      this.#big(k, 'BIG AIR!', 'go', 0.9);
    }
    if (impact > 8) {
      this.#spark(k.x, k.y + 0.2, k.z, 0xffffff, 10, 7);
      if (k.human) kartSfx.land(impact > 14);
    }
    k.airT = 0;
  }

  // Which track feature (if any) the kart is on.
  #zoneAt(k) {
    for (const zn of this.board.hazards.zones) {
      if (zn.type === 'gates') continue;
      if (k.idx >= zn.i0 && k.idx <= zn.i1 && k.lat >= zn.lat[0] - 1 && k.lat <= zn.lat[1] + 1) return zn;
    }
    return null;
  }

  #enterZone(k, zn, dt) {
    if (k.human && !k.seen.has(zn.type)) {
      k.seen.add(zn.type);
      this.#card(k, HAZARD_INFO[zn.type]);
    }
    if (zn.type === 'boost') {
      if (k.boostT < 0.3 && k.human) kartSfx.boostPad();
      k.boostT = Math.max(k.boostT, 0.9);
    } else if (zn.type === 'emi') {
      k.emiT = 0.25;
    } else if (zn.type === 'fan') {
      const s = this.track.side[k.idx];
      const gust = 16 * (0.6 + 0.4 * Math.sin(this.time * 1.7));
      k.vx += s.x * zn.push * gust * dt;
      k.vz += s.y * zn.push * gust * dt;
    }
  }

  // Clock-gate pistons stop anyone who hits a raised one.
  #gates(k) {
    if (k.gateT > 0) return;
    for (const g of this.board.hazards.gates) {
      const up = gateHeight(g, this.time);
      if (up < 0.35) continue;
      const t = this.track.tan[g.i];
      const along = (k.x - g.x) * t.x + (k.z - g.z) * t.y;
      const across = (k.x - g.x) * t.y - (k.z - g.z) * t.x;
      // Only the front face stops you; a kart already half through carries on.
      if (along < -1.6 || along > 0.2 || Math.abs(across) > 1.9 + KART_R * 0.6 || k.y > g.base + 2.4 * up) continue;
      // Bounce back off it.
      const fx = Math.sin(k.h);
      const fz = Math.cos(k.h);
      const into = k.vx * fx + k.vz * fz;
      if (into <= 0) continue;
      k.vx -= fx * into * 1.3;
      k.vz -= fz * into * 1.3;
      k.x -= fx * 1.2;
      k.z -= fz * 1.2;
      if (k.human && !k.seen.has('gates')) {
        k.seen.add('gates');
        this.#card(k, HAZARD_INFO.gates);
      }
      k.gateT = 1;
      this.#hit(k, 'gate', k);
      return;
    }
  }

  #crossLine(k) {
    k.lap++;
    if (k.lap <= 0) return;
    const lapTime = this.raceTime - k.lapStart;
    k.lapStart = this.raceTime;
    k.bestLap = Math.min(k.bestLap, lapTime);
    if (this.demo) return;
    if (k.lap >= LAPS && !k.finished) {
      k.finished = true;
      k.finishTime = this.raceTime;
      if (this.firstFinish === null) this.firstFinish = this.raceTime;
      k.finalPlace = this.karts.filter((o) => o.finished).length - 1;
      if (k.human || k.finalPlace === 0) this.atmo.confetti(k.human ? 1 : 0.5);
      if (k.human) {
        this.#big(k, `FINISH! ${ORDINAL[k.finalPlace]}`, k.finalPlace === 0 ? 'win' : k.finalPlace < 3 ? 'go' : '', 99);
        kartSfx.finish(k.finalPlace);
      }
    } else if (k.human) {
      const final = k.lap === LAPS - 1;
      this.#big(k, final ? 'FINAL LAP!' : `LAP ${k.lap + 1}`, final ? 'warn' : '', 1.4);
      kartSfx.lap(final);
    }
  }

  // Karts shove each other apart; the heavier kart moves less and keeps more
  // of its speed.
  #bump() {
    const ks = this.karts;
    for (let a = 0; a < ks.length; a++) {
      for (let b = a + 1; b < ks.length; b++) {
        const A = ks[a];
        const B = ks[b];
        const dx = B.x - A.x;
        const dz = B.z - A.z;
        const d = Math.hypot(dx, dz);
        if (d === 0 || d > KART_R * 2 || Math.abs(A.y - B.y) > 1.8) continue;
        const nx = dx / d;
        const nz = dz / d;
        const overlap = KART_R * 2 - d;
        const share = B.spec.mass / (A.spec.mass + B.spec.mass);
        A.x -= nx * overlap * share;
        A.z -= nz * overlap * share;
        B.x += nx * overlap * (1 - share);
        B.z += nz * overlap * (1 - share);
        const rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
        if (rel < 0) {
          const j = (-1.4 * rel) / (1 / A.spec.mass + 1 / B.spec.mass);
          A.vx -= (j / A.spec.mass) * nx;
          A.vz -= (j / A.spec.mass) * nz;
          B.vx += (j / B.spec.mass) * nx;
          B.vz += (j / B.spec.mass) * nz;
          if (-rel > 6) {
            this.#spark((A.x + B.x) / 2, A.y + 0.8, (A.z + B.z) / 2, 0xffffff, 6, 6);
            if ((A.human || B.human) && !this.demo) kartSfx.bump();
          }
        }
      }
    }
  }

  #rank() {
    const order = [...this.karts].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.prog - a.prog;
    });
    order.forEach((k, n) => {
      if (k.human && !this.demo && k.place !== undefined && n < k.place && this.raceTime > 3) kartSfx.overtake();
      k.place = n;
    });
    this.order = order;
  }

  // ---------------------------------------------------------------- items

  #updateBoxes(dt) {
    for (const b of this.boxes) {
      b.t = Math.max(0, b.t - dt);
      b.mesh.visible = b.t <= 0;
      b.mesh.rotation.set(this.time * 0.7, this.time * 1.3, 0);
      b.mesh.position.y = b.y + Math.sin(this.time * 2.5 + b.x) * 0.25;
      if (b.t > 0) continue;
      for (const k of this.karts) {
        const full = k.item && ((k.spec.slots ?? 1) < 2 || k.item2);
        if (full || Math.hypot(k.x - b.x, k.z - b.z) > 2.6 || Math.abs(k.y + 1 - b.y) > 3) continue;
        b.t = BOX_RESPAWN;
        const got = this.#roll(k);
        if (k.item) k.item2 = got;
        else k.item = got;
        k.cpuDelay = 0.8 + Math.random() * 2;
        if (k.human) {
          kartSfx.pickup();
          this.#card(k, ITEMS[got]);
        }
        break;
      }
    }
  }

  // Leaders get defence, whoever is behind gets speed and attack.
  #roll(k) {
    if (k.place <= 1) return pick({ shield: 3, firewall: 3, jammer: 1, compress: 1 });
    if (k.place >= 5) return pick({ compress: 4, jammer: 3, shield: 1, firewall: 1 });
    return pick({ compress: 2, jammer: 2, shield: 2, firewall: 2 });
  }

  #useItem(k) {
    const item = k.item;
    k.item = k.item2;
    k.item2 = null;
    k.used++;
    const loud = !this.demo && k.human;
    if (item === 'compress') {
      k.boostT = BOOST_TIME * k.spec.boost;
      if (loud) kartSfx.compress();
      this.#big(k, 'COMPRESSED!', 'go', 0.8);
    } else if (item === 'shield') {
      k.shieldT = SHIELD_TIME;
      if (loud) kartSfx.shield();
    } else if (item === 'firewall') {
      this.#dropWall(k);
      if (loud) kartSfx.firewall();
    } else if (item === 'jammer') {
      const range = JAM_RANGE * k.spec.jamRange;
      this.#ring(k, range);
      if (loud) kartSfx.jammer();
      const victims = this.karts.filter((o) => o !== k && Math.hypot(o.x - k.x, o.z - k.z) <= range);
      for (const o of victims) this.#hit(o, 'jam', k);
      if (k.human) this.#big(k, victims.length ? `JAMMED ${victims.length}!` : 'OUT OF RANGE', victims.length ? 'go' : 'warn', 1.2);
    }
  }

  #hit(k, type, by) {
    if (k.shieldT > 0) {
      k.shieldT = 0;
      this.#big(k, 'ECC REPAIRED IT!', 'go', 1.2);
      if (k.human) kartSfx.shieldBlock();
      return;
    }
    if (by !== k) by.hits++;
    if (type === 'jam') {
      k.jamT = JAM_TIME * k.spec.recover;
      this.#big(k, 'JAMMED!', 'bad', k.jamT);
      if (k.human) kartSfx.jammed();
    } else {
      k.spinT = SPIN_TIME * k.spec.recover * (type === 'gate' ? 0.4 : 1);
      k.vx *= 0.35;
      k.vz *= 0.35;
      this.#spark(k.x, k.y + 1, k.z, 0xff5a3d, 14, 8);
      this.#big(k, type === 'gate' ? 'CLOCK GATE!' : 'BLOCKED BY FIREWALL', 'bad', 1.2);
      if (k.human) (type === 'gate' ? kartSfx.gate : kartSfx.crash)();
    }
  }

  #dropWall(k) {
    const { tan, side, pts } = this.track;
    const back = locate(this.track, k.x - Math.sin(k.h) * 4, k.z - Math.cos(k.h) * 4, k.idx);
    const lat = clamp(back.lat, -ROAD + 1, ROAD - 1);
    const i = back.i;
    const x = pts[i].x + side[i].x * lat;
    const z = pts[i].y + side[i].y * lat;
    if (!this.brickTex) {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 96;
      const g = c.getContext('2d');
      g.fillStyle = '#300810';
      g.fillRect(0, 0, 256, 96);
      g.strokeStyle = '#ff5a3d';
      g.lineWidth = 5;
      for (let r = 0; r < 3; r++) {
        for (let b = -1; b < 5; b++) g.strokeRect(b * 64 + (r % 2) * 32 + 3, r * 32 + 3, 58, 26);
      }
      this.brickTex = new THREE.CanvasTexture(c);
      this.brickTex.colorSpace = THREE.SRGBColorSpace;
    }
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(5.5, 2.2, 0.5),
      new THREE.MeshBasicMaterial({ map: this.brickTex, transparent: true, opacity: 0.95 })
    );
    const y = surfaceY(this.track, i, lat);
    mesh.position.set(x, y + 1.1, z);
    mesh.rotation.y = Math.atan2(tan[i].x, tan[i].y);
    this.scene.add(mesh);
    this.walls.push({ mesh, x, z, y, i, lat, owner: k, grace: 0.8, life: FIREWALL_LIFE });
  }

  #updateWalls(dt) {
    const { tan, side } = this.track;
    for (const w of this.walls) {
      w.life -= dt;
      w.grace -= dt;
      w.mesh.scale.y = Math.min(1, (FIREWALL_LIFE - w.life) * 5);
      for (const k of this.karts) {
        if (w.life <= 0 || (k === w.owner && w.grace > 0)) continue;
        const dx = k.x - w.x;
        const dz = k.z - w.z;
        const along = dx * tan[w.i].x + dz * tan[w.i].y;
        const across = dx * side[w.i].x + dz * side[w.i].y;
        if (Math.abs(along) < 1.4 && Math.abs(across) < 3.8 && Math.abs(k.y - w.y) < 2.4) {
          this.#hit(k, 'wall', w.owner);
          w.life = 0;
        }
      }
    }
    this.walls = this.walls.filter((w) => {
      if (w.life > 0) return true;
      this.scene.remove(w.mesh);
      w.mesh.geometry.dispose();
      w.mesh.material.dispose();
      return false;
    });
  }

  // The jammer's pulse: a red ring racing out to its range.
  #ring(k, range) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xff3a5a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(k.x, k.y + 0.3, k.z);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, range });
  }

  #updateRings(dt) {
    for (const r of this.rings) {
      r.t += dt;
      const s = (r.t / 0.6) * r.range;
      r.mesh.scale.set(s, s, s);
      r.mesh.material.opacity = 0.9 * (1 - r.t / 0.6);
    }
    this.rings = this.rings.filter((r) => {
      if (r.t < 0.6) return true;
      this.scene.remove(r.mesh);
      r.mesh.geometry.dispose();
      r.mesh.material.dispose();
      return false;
    });
  }

  // ---------------------------------------------------------------- view

  #animateKart(k, dt) {
    const p = k.parts;
    if (k.spinT > 0) k.spinA += dt * 14;
    else k.spinA = 0;
    p.group.position.set(k.x, k.y, k.z);
    p.group.rotation.x = k.groundPitch;
    p.group.rotation.z = k.groundRoll;
    p.group.rotation.y = k.h + k.spinA + clamp(-k.vl * 0.04, -0.2, 0.2);
    // The body rides on its suspension; the wheels stay on the ground.
    p.body.position.y = k.susp.y;
    p.body.rotation.x = k.susp.pitch;
    p.body.rotation.z = k.susp.roll;
    // Wheels roll at the kart's speed for their size; the fronts steer.
    for (const w of p.wheels) w.rotation.x += (k.v * dt) / (w.userData.radius || 0.5);
    for (const s of p.steer) s.rotation.y = -k.steerVis * STEER_ANGLE;
    k.squash += ((k.boostT > 0 ? 0.72 : 1) - k.squash) * Math.min(dt * 10, 1);
    p.group.scale.set(1 / Math.sqrt(k.squash), 1, k.squash);
    p.flame.visible = k.boostT > 0;
    p.flame.scale.y = 0.8 + Math.random() * 0.5;
    p.shield.visible = k.shieldT > 0;
    p.shield.rotation.y += dt;

    p.body.visible = k.jamT <= 0 || Math.floor(this.time * 20) % 2 === 0;
  }

  #placeCamera(k, dt) {
    // Follow a blend of where the kart faces and where it's actually going.
    const speed = Math.hypot(k.vx, k.vz);
    const travel = speed > 5 ? Math.atan2(k.vx, k.vz) : k.h;
    const h = k.h + wrapAngle(travel - k.h) * 0.5;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const target = new THREE.Vector3(k.x - fx * 9, k.y + 4.2, k.z - fz * 9);
    const look = new THREE.Vector3(k.x + fx * 7, k.y + 1.2, k.z + fz * 7);
    const t = Math.min(dt * 6, 1);
    k.camPos.lerp(target, t);
    k.camLook.lerp(look, t);
    k.cam.position.copy(k.camPos);
    k.cam.lookAt(k.camLook);
    const fov = 66 + clamp(k.v, 0, 60) * 0.15 + (k.boostT > 0 ? 8 : 0);
    k.cam.fov += (fov - k.cam.fov) * Math.min(dt * 4, 1);
    k.cam.updateProjectionMatrix();
  }

  // Title backdrop: a low, sweeping view of the leader.
  #placeDemoCam(dt) {
    const k = this.karts.find((o) => o.place === 0) ?? this.karts[0];
    const a = this.time * 0.25;
    const target = new THREE.Vector3(k.x + Math.sin(a) * 16, k.y + 6, k.z + Math.cos(a) * 16);
    const t = Math.min(dt * 2, 1);
    this.demoCam.position.lerp(target, dt > 0.5 ? 1 : t);
    this.demoCam.lookAt(k.x, k.y + 1, k.z);
  }

  #card(k, item) {
    const h = this.ui?.halves[k.i];
    if (!h) return;
    h.card.querySelector('b').textContent = item.name;
    h.card.querySelector('b').style.color = item.color;
    h.card.querySelector('span').textContent = item.line;
    h.card.style.borderColor = item.color;
    h.card.classList.add('show');
    h.cardT = 4;
  }

  #big(k, text, cls, secs) {
    const h = this.ui?.halves[k.i];
    if (!h || !k.human) return;
    h.big.textContent = text;
    h.big.className = `jk-big show ${cls}`;
    h.bigT = secs;
  }

  #updateHud(dt) {
    const ui = this.ui;
    ui.timer.textContent = fmtTime(this.raceTime);
    this.karts.forEach((k, i) => {
      const dot = ui.dots[i];
      dot.setAttribute('cx', k.x.toFixed(1));
      dot.setAttribute('cy', k.z.toFixed(1));
      if (!k.human) return;
      const h = ui.halves[i];
      h.place.textContent = ORDINAL[k.place];
      h.place.classList.toggle('first', k.place === 0);
      h.lap.textContent = `LAP ${clamp(k.lap + 1, 1, LAPS)}/${LAPS}`;
      h.speed.firstChild.nodeValue = Math.round(Math.hypot(k.vx, k.vz) * 3.6);
      const item = k.item && ITEMS[k.item];
      h.slot.textContent = item ? item.icon : '';
      h.slot.style.color = item ? item.color : '';
      h.item.classList.toggle('full', !!item);
      const item2 = k.item2 && ITEMS[k.item2];
      h.slot2.textContent = item2 ? item2.icon : '';
      h.slot2.style.color = item2 ? item2.color : '';
      h.slot2.style.display = (k.spec.slots ?? 1) > 1 ? '' : 'none';
      h.static.classList.toggle('on', k.jamT > 0 || k.emiT > 0);
      h.static.classList.toggle('light', k.jamT <= 0 && k.emiT > 0);
      if (h.cardT > 0 && (h.cardT -= dt) <= 0) h.card.classList.remove('show');
      if (h.bigT > 0 && (h.bigT -= dt) <= 0) h.big.classList.remove('show');
      if (!k.finished && k.wrongT > 1 && h.bigT <= 0) this.#big(k, 'WRONG WAY ↺', 'bad', 0.3);
    });
    // Live standings.
    const rows = ui.board.children;
    this.order.forEach((k, n) => {
      const row = rows[n];
      row.firstElementChild.style.background = hex(k.color);
      row.lastElementChild.textContent = k.human ? `PLAYER ${k.i + 1}` : k.label;
      row.classList.toggle('human', k.human);
    });
  }

  #updateAudio(live) {
    setRain(this.wet);
    const lead = Math.max(...this.karts.map((k) => k.lap));
    if (live && !this.endTimer) {
      music.set({ intensity: [0.55, 0.72, 0.92][clamp(lead, 0, LAPS - 1)], bpm: 110 + clamp(lead, 0, 2) * 5 });
    }
    [0, 1].forEach((i) => {
      const k = this.karts[i];
      if (!k.human) return;
      // Each player hears their own kart's engine (rebuilt if they swapped).
      if (this.engines[i]?.model !== k.spec.id) {
        this.engines[i]?.stop();
        this.engines[i] = createEngine(k.spec.id);
        if (this.engines[i]) this.engines[i].model = k.spec.id;
      }
      this.engines[i]?.update({
        speed: k.v, top: k.spec.top, slip: k.vl, drifting: false, boost: k.boostT > 0,
        air: false, jammed: k.jamT > 0, on: true, brake: !!k.wasBraking, spin: k.spinT > 0,
      });
    });
  }

  // ---------------------------------------------------------------- result

  #finalPlace(k) {
    return k.finished ? k.finalPlace : k.place;
  }

  #score(k) {
    const place = this.#finalPlace(k);
    const time = k.finished ? Math.max(0, Math.round((140 - k.finishTime) * 40)) : Math.round((k.prog / (LAPS * this.track.length)) * 1500);
    return Math.max(0, PLACE_POINTS[place] + time + k.hits * 250);
  }

  #result() {
    this.#rank();
    // The results screen stops calling update(), so silence the engines now.
    this.engines.forEach((e) => e?.stop());
    setRain(0);
    this.engines = [null, null];
    const humans = this.karts.filter((k) => k.human);
    const best = [...humans].sort((a, b) => this.#score(b) - this.#score(a))[0];
    const ord = (k) => ORDINAL[this.#finalPlace(k)];
    const line = (k) => `${k.spec.name} · ${ord(k)}${k.finished ? ` · ${fmtTime(k.finishTime)}` : ''} · ${k.hits} hit${k.hits === 1 ? '' : 's'}`;
    let title;
    let stats;
    if (this.players === 1) {
      const p = humans[0];
      title = this.#finalPlace(p) === 0 ? 'YOU WIN!' : `${ord(p)} PLACE`;
      stats = [
        ['Kart', p.spec.name],
        ['Finish', `${ord(p).toLowerCase()} of ${RACERS}`],
        ['Race time', p.finished ? fmtTime(p.finishTime) : '—'],
        ['Best lap', p.bestLap < Infinity ? fmtTime(p.bestLap) : '—'],
        ['Hits landed', p.hits],
      ];
    } else {
      const ahead = [...humans].sort((a, b) => this.#finalPlace(a) - this.#finalPlace(b))[0];
      title = `PLAYER ${ahead.i + 1} WINS!`;
      stats = [
        ['Player 1', line(this.karts[0])],
        ['Player 2', line(this.karts[1])],
        ['Best lap', fmtTime(Math.min(...humans.map((k) => k.bestLap)))],
        ['Board score for', `Player ${best.i + 1}`],
      ];
    }
    return {
      title,
      score: this.#score(best),
      stats,
      fact:
        'A jammer wins by drowning every receiver nearby in noise louder than the signal, which is why jamming is illegal in most countries. ' +
        'Networks fight back with the same tricks you raced with: firewalls filter traffic, compression shrinks data, and error-correcting codes repair it.',
    };
  }

  // Pause menu: silence the engines and rain (they're rebuilt by
  // #updateAudio as soon as the race runs again).
  setPaused(on) {
    if (!on) return;
    this.engines?.forEach((e) => e?.stop());
    this.engines = [null, null];
    setRain(0);
  }

  dispose() {
    if (!this.demo) setRain(0);
    this.engines?.forEach((e) => e?.stop());
    if (this.hudRoot) this.hudRoot.innerHTML = '';
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    });
  }
}
