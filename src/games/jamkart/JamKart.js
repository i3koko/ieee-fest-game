import * as THREE from 'three';
import { beep, noise, createTone, sfx } from '../../core/audio.js';
import { music } from '../../core/music.js';
import { TRACK_W, SAMPLES, FOG, buildTrack, buildBoard, locate, ahead } from './track.js';
import { makeKart, MODELS, PALETTE } from './kart.js';

const LAPS = 3;
const BOOST_BONUS = 20; // compression adds this to a kart's top speed
const BRAKE = 48;
const SELECT_TIMEOUT = 30;
const EDGE = TRACK_W / 2 - 1.3; // how far off-centre a kart can go
const BOX_RESPAWN = 3;
const JAM_TIME = 2.6;
const JAM_RANGE = 70; // jammers only reach nearby receivers
const SPIN_TIME = 1.1;
const SHIELD_TIME = 8;
const BOOST_TIME = 2.2;
const FIREWALL_LIFE = 14;
const FINISH_GRACE = 12; // seconds the others get after the winner crosses
const RACE_CAP = 150;
const NAMES = ['P1', 'P2'];
const ORDINAL = ['1ST', '2ND'];

// Power-ups are comms tricks; each explains itself when you pick it up.
const ITEMS = {
  jammer: {
    name: 'JAMMER', icon: '≋', color: '#ff4d6d',
    line: 'Floods nearby receivers with noise so the real signal is lost. Get close: jammers only reach so far.',
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

export class JamKart {
  static id = 'jamkart';

  // demo: two CPU karts race forever on one screen, silently, for the title.
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
    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x0a2412, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(40, 80, 30);
    this.scene.add(sun);

    this.track = buildTrack();
    this.board = buildBoard(this.scene, this.track);
    this.#buildBoxes();
    this.walls = [];
    this.rings = [];
    this.karts = [0, 1].map((i) => this.#makeKart(i));
    if (demo) {
      // Title backdrop: two random, differently coloured karts.
      const colors = [...PALETTE.keys()].sort(() => Math.random() - 0.5);
      this.karts.forEach((k, i) => {
        k.model = Math.floor(Math.random() * MODELS.length);
        k.colorIdx = colors[i];
        this.#rebuild(k);
      });
    }

    if (demo) {
      this.demoCam = new THREE.PerspectiveCamera(62, 1, 0.3, 500);
      view.use(this.scene, [this.demoCam], { strength: 0.6, radius: 0.45, threshold: 0.55 });
    } else {
      this.#buildHud();
      view.use(this.scene, this.karts.map((k) => k.cam), { strength: 0.6, radius: 0.45, threshold: 0.55 });
      this.engines = this.karts.map(() => createTone('triangle'));
    }
    this.#setHumans();
    for (const k of this.karts) this.#placeCamera(k, 1);
    if (demo) this.#placeDemoCam(1);
  }

  // Called by the arcade when the how-to screen's mode picker is confirmed.
  setMode(index) {
    this.players = index + 1;
    this.#setHumans();
  }

  #setHumans() {
    this.karts.forEach((k, i) => {
      k.human = !this.demo && i < this.players;
      k.label = k.human ? NAMES[i] : 'CPU';
    });
    if (this.ui) this.#refreshTags();
  }

  // ---------------------------------------------------------------- setup

  #makeKart(i) {
    const { pts, tan, side } = this.track;
    const start = 6;
    const lat = i === 0 ? 3.5 : -3.5;
    const p = pts[start];
    const k = {
      i, parts: null, human: false, label: 'CPU', model: i === 0 ? 0 : 2, colorIdx: i, ready: false, menuPrev: null,
      x: p.x + side[start].x * lat, z: p.y + side[start].y * lat,
      h: Math.atan2(tan[start].x, tan[start].y), v: 0, steerVis: 0,
      idx: start, lastIdx: start, lat, lap: 0, prog: 0, place: i,
      finished: false, finishTime: 0, lapStart: 0, bestLap: Infinity,
      item: null, boostT: 0, jamT: 0, shieldT: 0, spinT: 0, spinA: 0, scrapeT: 0, wrongT: 0,
      hits: 0, used: 0, prevFire: true, cpuDelay: 0, cpuLane: lat * 0.6, squash: 1,
      cam: new THREE.PerspectiveCamera(70, 1, 0.3, 500), camPos: new THREE.Vector3(), camLook: new THREE.Vector3(),
    };
    this.#rebuild(k);
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
    for (const f of [0.17, 0.48, 0.77]) {
      const i = Math.floor(f * SAMPLES);
      for (const lat of [-4.5, 0, 4.5]) {
        const p = this.track.pts[i];
        const s = this.track.side[i];
        const mesh = new THREE.Mesh(geo, mat);
        mesh.add(new THREE.LineSegments(edges, edgeMat));
        const x = p.x + s.x * lat;
        const z = p.y + s.y * lat;
        mesh.position.set(x, 1.4, z);
        this.scene.add(mesh);
        this.boxes.push({ mesh, x, z, t: 0 });
      }
    }
  }

  #buildHud() {
    const half = (i) => `
      <div class="jk-half p${i}" data-half="${i}">
        <div class="jk-head">
          <div class="jk-tag" data-tag></div>
          <div class="jk-place" data-place>1ST</div>
          <div class="jk-lap" data-lap>LAP 1/${LAPS}</div>
        </div>
        <div class="jk-item" data-item><div class="slot" data-slot></div><div class="key" data-key></div></div>
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
        <svg class="jk-map" data-map></svg>
      </div>`;
    const root = this.hudRoot.firstElementChild;
    this.ui = {
      root,
      timer: root.querySelector('[data-timer]'),
      halves: [0, 1].map((i) => {
        const h = root.querySelector(`[data-half="${i}"]`);
        const q = (k) => h.querySelector(`[data-${k}]`);
        return {
          root: h, tag: q('tag'), place: q('place'), lap: q('lap'), item: q('item'), slot: q('slot'), key: q('key'), card: q('card'), big: q('big'), static: q('static'), cardT: 0, bigT: 0,
          who: q('who'), mname: q('mname'), blurb: q('blurb'), stats: q('stats'), perk: q('perk'), colors: q('colors'), ready: q('ready'),
        };
      }),
    };
    this.#buildMap(root.querySelector('[data-map]'));
    this.#refreshTags();
  }

  #buildMap(svg) {
    const pts = this.track.pts;
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.y);
    const pad = 12;
    const minX = Math.min(...xs) - pad;
    const minZ = Math.min(...zs) - pad;
    const w = Math.max(...xs) + pad - minX;
    const h = Math.max(...zs) + pad - minZ;
    svg.setAttribute('viewBox', `${minX} ${minZ} ${w} ${h}`);
    const d = pts.filter((_, i) => i % 8 === 0).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + 'Z';
    svg.innerHTML = `<path d="${d}" class="road"/><path d="${d}" class="line"/>` +
      [0, 1].map((i) => `<circle r="7" data-dot="${i}"/>`).join('');
    this.ui.dots = [0, 1].map((i) => svg.querySelector(`[data-dot="${i}"]`));
  }

  #refreshTags() {
    const pads = this.#pads().length;
    this.karts.forEach((k, i) => {
      const h = this.ui.halves[i];
      h.tag.textContent = k.human ? `PLAYER ${i + 1}` : 'CPU';
      h.tag.style.color = hex(k.color);
      this.ui.dots[i].setAttribute('fill', hex(k.color));
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
      brake ||= p.buttons[13]?.pressed || (p.buttons[6]?.value ?? 0) > 0.4 || (p.axes[1] ?? 0) > 0.6;
      fire ||= [0, 1, 2, 3, 5].some((b) => p.buttons[b]?.pressed);
    }
    const pressed = fire && !k.prevFire;
    k.prevFire = fire;
    return { steer: clamp(steer, -1, 1), brake, fire: pressed };
  }

  // Follows the racing line, grabs boxes, dodges firewalls, uses items sensibly.
  #cpu(k, dt, slow = 1) {
    const { pts, side, tan } = this.track;
    const rival = this.karts[1 - k.i];
    if (!k.item) {
      const box = this.boxes.find((b) => b.t <= 0 && this.#along(k, b.x, b.z) > 10 && this.#along(k, b.x, b.z) < 45);
      if (box) k.cpuLane = clamp(locate(this.track, box.x, box.z, k.idx).lat, -EDGE + 1, EDGE - 1);
    }
    for (const w of this.walls) {
      const d = this.#along(k, w.x, w.z);
      if (d > 0 && d < 35) k.cpuLane = w.lat > 0 ? -4.5 : 4.5;
    }
    const look = ahead(k.idx, 10 + Math.floor(Math.max(k.v, 0) * 0.3));
    const tx = pts[look].x + side[look].x * k.cpuLane;
    const tz = pts[look].y + side[look].y * k.cpuLane;
    const err = wrapAngle(Math.atan2(tx - k.x, tz - k.z) - k.h);
    const bend = Math.abs(wrapAngle(Math.atan2(tan[ahead(k.idx, 40)].x, tan[ahead(k.idx, 40)].y) - Math.atan2(tan[k.idx].x, tan[k.idx].y)));

    // Rubber band: a CPU far ahead eases off, one far behind pushes.
    const gap = rival.prog - k.prog;
    const top = k.spec.top;
    k.maxV = (this.demo ? top - 2 : clamp(top - 0.5 + gap * 0.06, top - 6, top + 5)) * slow;

    let fire = false;
    if (k.item && (k.cpuDelay -= dt) <= 0) {
      const dist = Math.hypot(rival.x - k.x, rival.z - k.z);
      const behind = rival.prog < k.prog;
      fire =
        k.item === 'shield' ||
        (k.item === 'compress' && bend < 0.5) ||
        (k.item === 'jammer' && dist < JAM_RANGE * k.spec.jamRange * 0.8) ||
        (k.item === 'firewall' && behind && dist < 50) ||
        k.cpuDelay < -8;
    }
    return { steer: clamp(-err * 2.6, -1, 1), brake: bend > 1.3 && k.v > 38, fire };
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

    // Showroom: each camera circles its own kart.
    this.karts.forEach((k, i) => {
      const a = this.time * 0.45 + i * Math.PI + 0.6;
      k.cam.position.set(k.x + Math.sin(k.h + a) * 6.8, 2.6, k.z + Math.cos(k.h + a) * 6.8);
      k.cam.lookAt(k.x, 0.9, k.z);
      k.parts.flame.visible = false;
    });
    this.board.trackMat.uniforms.uTime.value = this.time;
    this.view.render();

    const done = this.karts.every((k) => !k.human || k.ready) || this.selectT > SELECT_TIMEOUT;
    if (!done) return false;
    this.selecting = false;
    this.ui.root.classList.remove('selecting');
    this.#refreshTags();
    for (const k of this.karts) this.#placeCamera(k, 1);
    return true;
  }

  #startSelect() {
    this.selecting = true;
    this.selectT = 0;
    const cpu = this.karts.find((k) => !k.human);
    if (cpu) {
      const player = this.karts[0];
      cpu.model = Math.floor(Math.random() * MODELS.length);
      cpu.colorIdx = (player.colorIdx + 1 + Math.floor(Math.random() * (PALETTE.length - 1))) % PALETTE.length;
      cpu.ready = true;
      this.#rebuild(cpu);
    }
    for (const k of this.karts) {
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
    h.who.textContent = k.human ? `PLAYER ${k.i + 1}` : 'CPU';
    h.who.style.color = hex(k.color);
    h.mname.textContent = m.name;
    h.blurb.textContent = m.blurb;
    h.stats.innerHTML = Object.entries(m.stats)
      .map(([name, n]) => `<div><span>${name}</span><i>${'<b></b>'.repeat(n)}${'<b class="off"></b>'.repeat(5 - n)}</i></div>`)
      .join('');
    h.perk.innerHTML = `<b>PERK</b> ${m.perk}`;
    h.colors.innerHTML = PALETTE.map((c, n) => `<i class="${n === k.colorIdx ? 'on' : ''}" style="background:${hex(c)}"></i>`).join('');
    const keys = this.players === 1 ? ['◀ ▶', '▲ ▼', 'SPACE'] : [['A D', 'W S', 'SPACE'], ['◀ ▶', '▲ ▼', 'ENTER']][k.i];
    h.ready.innerHTML = !k.human
      ? 'CPU READY'
      : k.ready
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
      if (ctl.fire && k.item && live) this.#useItem(k);
    }
    this.#bump();
    this.#updateBoxes(dt);
    this.#updateWalls(dt);
    this.#updateRings(dt);
    this.#rank();
    for (const k of this.karts) {
      this.#animateKart(k, dt);
      this.#placeCamera(k, dt);
    }
    this.board.trackMat.uniforms.uTime.value = this.time;
    for (const l of this.board.lights) l.mat.color.copy(l.base).multiplyScalar(0.6 + 0.4 * Math.sin(this.time * 3 + l.phase));

    if (this.demo) this.#placeDemoCam(dt);
    else {
      this.#updateHud(dt);
      this.#updateAudio(live);
    }
    this.view.render();

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

  #drive(k, ctl, dt, live) {
    const { tan, side } = this.track;
    k.boostT = Math.max(0, k.boostT - dt);
    k.jamT = Math.max(0, k.jamT - dt);
    k.shieldT = Math.max(0, k.shieldT - dt);
    k.spinT = Math.max(0, k.spinT - dt);
    k.scrapeT = Math.max(0, k.scrapeT - dt);

    const top = k.maxV ?? k.spec.top;
    const maxV = (k.boostT > 0 ? top + BOOST_BONUS : top) * (k.jamT > 0 ? 0.8 : 1);
    if (!live) k.v = 0;
    else if (k.spinT > 0) k.v = Math.max(0, k.v - 40 * dt);
    else if (ctl.brake) k.v = Math.max(-10, k.v - BRAKE * dt);
    else if (k.v < maxV) k.v = Math.min(maxV, k.v + (k.boostT > 0 ? 70 : k.spec.accel) * dt);
    else k.v = Math.max(maxV, k.v - 30 * dt);

    let steer = k.spinT > 0 ? 0 : ctl.steer;
    if (k.jamT > 0) steer = clamp(steer + Math.sin(this.time * 11 + k.i * 2) * 0.6, -1, 1);
    k.steerVis += (steer - k.steerVis) * Math.min(dt * 8, 1);
    const grip = clamp(Math.abs(k.v) / 10, 0, 1);
    k.h -= steer * k.spec.turn * grip * Math.sign(k.v || 1) * dt;
    k.x += Math.sin(k.h) * k.v * dt;
    k.z += Math.cos(k.h) * k.v * dt;

    // Rails: slide along them, scrubbing speed and turning back to the track.
    const loc = locate(this.track, k.x, k.z, k.idx);
    k.idx = loc.i;
    k.lat = loc.lat;
    if (Math.abs(k.lat) > EDGE) {
      const s = Math.sign(k.lat);
      const over = Math.abs(k.lat) - EDGE;
      k.x -= side[k.idx].x * s * over;
      k.z -= side[k.idx].y * s * over;
      k.lat = s * EDGE;
      const trackH = Math.atan2(tan[k.idx].x, tan[k.idx].y);
      const off = wrapAngle(k.h - trackH);
      if (Math.abs(off) < Math.PI / 2) k.h -= off * Math.min(dt * 4, 1);
      if (k.v > 20) k.v -= 35 * dt;
      if (k.scrapeT <= 0 && k.human && live) beep(90, 0.08, { type: 'sawtooth', vol: 0.03 });
      k.scrapeT = 0.15;
    }

    // Laps: crossing the line forwards counts, backwards un-counts.
    if (k.lastIdx > SAMPLES * 0.85 && k.idx < SAMPLES * 0.15) this.#crossLine(k);
    else if (k.lastIdx < SAMPLES * 0.15 && k.idx > SAMPLES * 0.85) k.lap--;
    k.lastIdx = k.idx;
    k.prog = k.lap * this.track.length + this.track.dist[k.idx];

    const trackH = Math.atan2(tan[k.idx].x, tan[k.idx].y);
    k.wrongT = Math.abs(wrapAngle(k.h - trackH)) > 2 && k.v > 2 ? k.wrongT + dt : 0;
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
      const place = this.karts.filter((o) => o.finished).length;
      k.finalPlace = place - 1;
      if (k.human) {
        this.#big(k, place === 1 ? 'FINISH! 1ST' : `FINISH! ${ORDINAL[place - 1]}`, place === 1 ? 'win' : '', 99);
        [523, 659, 784, 1047].forEach((f, n) => beep(f, 0.2, { when: n * 0.1, type: 'triangle', vol: 0.08 }));
      }
    } else if (k.human) {
      const final = k.lap === LAPS - 1;
      this.#big(k, final ? 'FINAL LAP!' : `LAP ${k.lap + 1}`, final ? 'warn' : '', 1.4);
      sfx.checkpoint();
    }
  }

  // Karts shove each other apart instead of overlapping.
  #bump() {
    const [a, b] = this.karts;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > 0 && d < 2.8) {
      // The heavier kart gets moved less.
      const overlap = 2.8 - d;
      const share = b.spec.mass / (a.spec.mass + b.spec.mass);
      a.x -= (dx / d) * overlap * share;
      a.z -= (dz / d) * overlap * share;
      b.x += (dx / d) * overlap * (1 - share);
      b.z += (dz / d) * overlap * (1 - share);
    }
  }

  #rank() {
    const order = [...this.karts].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.prog - a.prog;
    });
    order.forEach((k, n) => (k.place = n));
  }

  // ---------------------------------------------------------------- items

  #updateBoxes(dt) {
    for (const b of this.boxes) {
      b.t = Math.max(0, b.t - dt);
      b.mesh.visible = b.t <= 0;
      b.mesh.rotation.set(this.time * 0.7, this.time * 1.3, 0);
      b.mesh.position.y = 1.4 + Math.sin(this.time * 2.5 + b.x) * 0.25;
      if (b.t > 0) continue;
      for (const k of this.karts) {
        if (k.item || Math.hypot(k.x - b.x, k.z - b.z) > 2.6) continue;
        b.t = BOX_RESPAWN;
        k.item = this.#roll(k);
        k.cpuDelay = 0.8 + Math.random() * 2;
        if (k.human) {
          sfx.pickup();
          this.#card(k, ITEMS[k.item]);
        }
        break;
      }
    }
  }

  // Leaders get defence, whoever is behind gets speed and attack.
  #roll(k) {
    const rival = this.karts[1 - k.i];
    const lead = k.prog - rival.prog;
    if (lead > 30) return pick({ shield: 3, firewall: 3, jammer: 1, compress: 1 });
    if (lead < -30) return pick({ compress: 4, jammer: 3, shield: 1, firewall: 1 });
    return pick({ compress: 2, jammer: 2, shield: 2, firewall: 2 });
  }

  #useItem(k) {
    const item = k.item;
    k.item = null;
    k.used++;
    const rival = this.karts[1 - k.i];
    const loud = !this.demo;
    if (item === 'compress') {
      k.boostT = BOOST_TIME * k.spec.boost;
      if (loud) sfx.boost();
      this.#big(k, 'COMPRESSED!', 'go', 0.8);
    } else if (item === 'shield') {
      k.shieldT = SHIELD_TIME;
      if (loud) sfx.shield();
    } else if (item === 'firewall') {
      this.#dropWall(k);
      if (loud) beep(110, 0.25, { type: 'square', vol: 0.07, slide: -40 });
    } else if (item === 'jammer') {
      this.#ring(k);
      if (loud) {
        noise(0.4, 0.08);
        beep(1400, 0.4, { type: 'sawtooth', vol: 0.03, slide: -1200 });
      }
      if (Math.hypot(rival.x - k.x, rival.z - k.z) <= JAM_RANGE * k.spec.jamRange) this.#hit(rival, 'jam', k);
      else this.#big(k, 'OUT OF RANGE', 'warn', 1.2);
    }
  }

  #hit(k, type, by) {
    if (k.shieldT > 0) {
      k.shieldT = 0;
      this.#big(k, 'ECC REPAIRED IT!', 'go', 1.2);
      if (!this.demo) sfx.shield();
      return;
    }
    if (by !== k) by.hits++;
    if (type === 'jam') {
      k.jamT = JAM_TIME * k.spec.recover;
      this.#big(k, 'JAMMED!', 'bad', k.jamT);
    } else {
      k.spinT = SPIN_TIME * k.spec.recover;
      k.v *= 0.35;
      this.#big(k, 'BLOCKED BY FIREWALL', 'bad', 1.2);
      if (!this.demo) sfx.hit();
    }
  }

  #dropWall(k) {
    const { tan, side, pts } = this.track;
    const back = locate(this.track, k.x - Math.sin(k.h) * 4, k.z - Math.cos(k.h) * 4, k.idx);
    const lat = clamp(back.lat, -EDGE + 2, EDGE - 2);
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
      new THREE.BoxGeometry(7, 2.2, 0.5),
      new THREE.MeshBasicMaterial({ map: this.brickTex, transparent: true, opacity: 0.95 })
    );
    mesh.position.set(x, 1.1, z);
    mesh.rotation.y = Math.atan2(tan[i].x, tan[i].y);
    this.scene.add(mesh);
    this.walls.push({ mesh, x, z, i, lat, owner: k, grace: 0.8, life: FIREWALL_LIFE });
  }

  #updateWalls(dt) {
    const { tan, side } = this.track;
    for (const w of this.walls) {
      w.life -= dt;
      w.grace -= dt;
      w.mesh.scale.y = Math.min(1, (FIREWALL_LIFE - w.life) * 5);
      for (const k of this.karts) {
        if (k === w.owner && w.grace > 0) continue;
        const dx = k.x - w.x;
        const dz = k.z - w.z;
        const along = dx * tan[w.i].x + dz * tan[w.i].y;
        const across = dx * side[w.i].x + dz * side[w.i].y;
        if (Math.abs(along) < 1.4 && Math.abs(across) < 4.6) {
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
  #ring(k) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xff3a5a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(k.x, 0.3, k.z);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, range: JAM_RANGE * k.spec.jamRange });
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
    p.group.position.set(k.x, 0, k.z);
    p.group.rotation.y = k.h + k.spinA;
    p.body.rotation.z = -k.steerVis * clamp(k.v / k.spec.top, 0, 1) * 0.08;
    for (const w of p.wheels) w.rotation.x += (k.v * dt) / 0.46;
    k.squash += ((k.boostT > 0 ? 0.72 : 1) - k.squash) * Math.min(dt * 10, 1);
    p.group.scale.set(1 / Math.sqrt(k.squash), 1, k.squash);
    p.flame.visible = k.boostT > 0;
    p.flame.scale.y = 0.8 + Math.random() * 0.5;
    p.shield.visible = k.shieldT > 0;
    p.shield.rotation.y += dt;
    p.under.material.color.setHex(k.scrapeT > 0 ? 0xffb000 : k.color);
    p.body.visible = k.jamT <= 0 || Math.floor(this.time * 20) % 2 === 0;
  }

  #placeCamera(k, dt) {
    const fx = Math.sin(k.h);
    const fz = Math.cos(k.h);
    const target = new THREE.Vector3(k.x - fx * 9, 4.2, k.z - fz * 9);
    const look = new THREE.Vector3(k.x + fx * 7, 1.2, k.z + fz * 7);
    const t = Math.min(dt * 6, 1);
    k.camPos.lerp(target, t);
    k.camLook.lerp(look, t);
    k.cam.position.copy(k.camPos);
    k.cam.lookAt(k.camLook);
    const fov = 70 + (k.boostT > 0 ? 12 : 0);
    k.cam.fov += (fov - k.cam.fov) * Math.min(dt * 4, 1);
    k.cam.updateProjectionMatrix();
  }

  // Title backdrop: a low, sweeping view of the leader.
  #placeDemoCam(dt) {
    const k = this.karts.find((o) => o.place === 0);
    const a = this.time * 0.25;
    const target = new THREE.Vector3(k.x + Math.sin(a) * 14, 5, k.z + Math.cos(a) * 14);
    const t = Math.min(dt * 2, 1);
    this.demoCam.position.lerp(target, dt > 0.5 ? 1 : t);
    this.demoCam.lookAt(k.x, 1, k.z);
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
      const h = ui.halves[i];
      h.place.textContent = ORDINAL[k.place];
      h.place.classList.toggle('first', k.place === 0);
      h.lap.textContent = `LAP ${clamp(k.lap + 1, 1, LAPS)}/${LAPS}`;
      const item = k.item && ITEMS[k.item];
      h.slot.textContent = item ? item.icon : '';
      h.slot.style.color = item ? item.color : '';
      h.item.classList.toggle('full', !!item);
      h.static.classList.toggle('on', k.jamT > 0);
      if (h.cardT > 0 && (h.cardT -= dt) <= 0) h.card.classList.remove('show');
      if (h.bigT > 0 && (h.bigT -= dt) <= 0) h.big.classList.remove('show');
      if (k.human && !k.finished && k.wrongT > 1 && h.bigT <= 0) this.#big(k, 'WRONG WAY ↺', 'bad', 0.3);
      const dot = ui.dots[i];
      dot.setAttribute('cx', k.x.toFixed(1));
      dot.setAttribute('cy', k.z.toFixed(1));
    });
  }

  #updateAudio(live) {
    const lead = Math.max(...this.karts.map((k) => k.lap));
    if (live && !this.endTimer) {
      music.set({ intensity: [0.55, 0.7, 0.92][clamp(lead, 0, LAPS - 1)], bpm: 118 + clamp(lead, 0, 2) * 7 });
    }
    this.karts.forEach((k, i) => {
      const vol = k.human && live ? 0.012 + Math.abs(k.v) * 0.0002 : 0;
      this.engines[i].set(45 + Math.abs(k.v) * 1.6 + (k.boostT > 0 ? 25 : 0) + i * 6, vol);
    });
  }

  // ---------------------------------------------------------------- result

  #score(k) {
    const place = k.finished ? k.finalPlace : 1;
    const base = k.finished ? [5000, 2000][place] + Math.max(0, Math.round((130 - k.finishTime) * 60)) : Math.round((k.prog / (LAPS * this.track.length)) * 3000);
    return Math.max(0, base + k.hits * 400);
  }

  #result() {
    const humans = this.karts.filter((k) => k.human);
    const winner = [...this.karts].sort((a, b) => a.place - b.place)[0];
    const best = [...humans].sort((a, b) => this.#score(b) - this.#score(a))[0];
    const line = (k) => {
      const place = k.finished ? ORDINAL[k.finalPlace] : 'DNF';
      const time = k.finished ? fmtTime(k.finishTime) : '—';
      return `${k.spec.name} · ${place} · ${time} · ${k.hits} hit${k.hits === 1 ? '' : 's'}`;
    };
    let title;
    let stats;
    if (this.players === 1) {
      const p = humans[0];
      title = winner === p ? 'YOU WIN!' : 'CPU WINS';
      stats = [
        ['Kart', p.spec.name],
        ['Finish', p.finished ? `${['1st', '2nd'][p.finalPlace]} of 2` : 'Did not finish'],
        ['Race time', p.finished ? fmtTime(p.finishTime) : '—'],
        ['Best lap', p.bestLap < Infinity ? fmtTime(p.bestLap) : '—'],
        ['Hits landed', p.hits],
        ['Power-ups used', p.used],
      ];
    } else {
      title = `PLAYER ${winner.i + 1} WINS!`;
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
        'A jammer wins by drowning a receiver in noise louder than the signal, which is why jamming is illegal in most countries. ' +
        'Networks fight back with the same tricks you raced with: firewalls filter traffic, compression shrinks data, and error-correcting codes repair it.',
    };
  }

  dispose() {
    this.engines?.forEach((e) => e.stop());
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
