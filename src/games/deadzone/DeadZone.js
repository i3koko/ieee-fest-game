import * as THREE from 'three';
import { sfx } from '../../core/audio.js';
import { generateCity, segmentHitsBox, BLOCKS, PITCH, HALF, TALL, EXTENT } from './city.js';

const ROUND_TIME = 90;
const CELL_COUNT = 6;
const CELL_RANGE = 44; // line-of-sight coverage radius
const WALL_LOSS = 0.3; // signal multiplier per tall building in the way
const SINR_MIN = 2; // ~3 dB: below this a user is jammed by co-channel cells
const DEPLOY_SPEED = 3;
const PICKUP_DIST = 7;
const TRUCK_RADIUS = 2.4;
const CHANNELS = [0x2ef2ff, 0xff3df2, 0xffd23d];
const NO_SIGNAL = new THREE.Color(0xff3050).multiplyScalar(0.9);
const JAMMED = new THREE.Color(0x9aa2c0).multiplyScalar(0.45);
const GOAL_COLOR = 0xffd23d;
const SOS_FIRST = 15;
const SOS_EVERY = 20;
const SOS_WINDOW = 22;
const SOS_BONUS = 1500;
const PACKET_POOL = 220;
const PREVIEW_EVERY = 0.2;

const clamp = THREE.MathUtils.clamp;
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const fmtTime = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class DeadZone {
  static id = 'deadzone';

  // demo: towers pre-placed, truck on autopilot, no HUD, for the title screen.
  constructor(view, hudRoot, { demo = false } = {}) {
    this.view = view;
    this.hudRoot = hudRoot;
    this.demo = demo;
    this.city = generateCity();
    this.tallBuildings = this.city.buildings.filter((b) => b.h >= TALL);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1020);
    this.scene.fog = new THREE.FogExp2(0x0a1020, 0.0032);
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 900);

    this.time = ROUND_TIME;
    this.elapsed = 0;
    this.score = 0;
    this.cells = [];
    this.channel = 0;
    this.peak = 0;
    this.deployed = 0;
    this.sosAnswered = 0;
    this.sos = null;
    this.nextSos = SOS_FIRST;
    this.packetBudget = 0;
    this.blipCooldown = 0;
    this.jamToastCooldown = 0;
    this.bumpCooldown = 0;
    this.jammed = 0;
    this.goal = null;
    this.goalTimer = 0;
    this.preview = null;
    this.previewTimer = 0;

    this.#buildWorld();
    this.#buildPeople();
    this.#buildTruck();
    this.#buildPackets();
    this.#buildGuides();
    if (!demo) this.#buildHud();
    if (demo) this.#setupDemo();

    view.use(this.scene, this.camera, { strength: 0.75, radius: 0.4, threshold: 0.45 });
    this.#placeCamera(1);
  }

  // ---------------------------------------------------------------- world

  #buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x7090d0, 0x202030, 1.6));
    const moon = new THREE.DirectionalLight(0xa8c0ff, 1.2);
    moon.position.set(120, 200, 60);
    s.add(moon);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(EXTENT + 600, EXTENT + 600),
      new THREE.MeshStandardMaterial({ color: 0x151a26, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    s.add(ground);

    const { blocks, buildings } = this.city;
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const m = new THREE.Matrix4();

    const sidewalks = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0x262d3d, roughness: 1 }),
      blocks.length
    );
    blocks.forEach((b, i) => {
      m.makeScale(b.maxX - b.minX, 0.4, b.maxZ - b.minZ).setPosition((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
      sidewalks.setMatrixAt(i, m);
    });
    s.add(sidewalks);

    // Dashed centre lines on every street, plus emergency lamps at junctions.
    const dashes = [];
    const lamps = [];
    for (let i = 0; i <= BLOCKS; i++) {
      const c = -HALF + i * PITCH;
      for (let d = -HALF; d < HALF; d += 7) dashes.push([c, d, false], [d, c, true]);
      for (let j = 0; j <= BLOCKS; j++) lamps.push([c + 4.5, -HALF + j * PITCH + 4.5]);
    }
    const dashMesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0x4a5570 }), dashes.length);
    dashes.forEach(([x, z, alongX], i) => {
      m.makeScale(alongX ? 3 : 0.35, 0.04, alongX ? 0.35 : 3).setPosition(x, 0.01, z);
      dashMesh.setMatrixAt(i, m);
    });
    s.add(dashMesh);

    const poleMesh = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x55607a }), lamps.length);
    const headMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.45, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xbcd4ff).multiplyScalar(0.9) }),
      lamps.length
    );
    lamps.forEach(([x, z], i) => {
      poleMesh.setMatrixAt(i, m.makeScale(0.18, 6, 0.18).setPosition(x, 0, z));
      headMesh.setMatrixAt(i, m.makeTranslation(x, 6.1, z));
    });
    s.add(poleMesh, headMesh);

    const bMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
      buildings.length
    );
    const tallCol = new THREE.Color(0x34405c);
    const lowCol = new THREE.Color(0x232a3c);
    const tallEdge = new THREE.Color(0x5aa0ff);
    const lowEdge = new THREE.Color(0x34507a);
    const edgePos = [];
    const edgeCol = [];
    const beacons = [];

    buildings.forEach((b, i) => {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      m.makeScale(w, b.h, d).setPosition((b.minX + b.maxX) / 2, 0.4, (b.minZ + b.maxZ) / 2);
      bMesh.setMatrixAt(i, m);
      const tall = b.h >= TALL;
      bMesh.setColorAt(i, tall ? tallCol : lowCol);

      const y0 = 0.4;
      const y1 = 0.4 + b.h;
      const corners = [];
      for (const y of [y0, y1]) for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) corners.push([x, y, z]);
      const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [4, 5], [6, 7], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      const col = tall ? tallEdge : lowEdge;
      for (const [a, c] of pairs) {
        edgePos.push(...corners[a], ...corners[c]);
        edgeCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
      if (tall) beacons.push([(b.minX + b.maxX) / 2, y1 + 0.5, (b.minZ + b.maxZ) / 2]);
    });
    s.add(bMesh);

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(edgeCol, 3));
    s.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ vertexColors: true })));

    // Aviation lights mark the tall, signal-blocking towers.
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2030 });
    const beaconMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 8, 6), this.beaconMat, beacons.length);
    beacons.forEach(([x, y, z], i) => beaconMesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    s.add(beaconMesh);
  }

  #buildPeople() {
    const { people, clusters } = this.city;
    this.personState = new Int8Array(people.length); // 0 none, 1 connected, 2 jammed
    this.personCell = new Int16Array(people.length).fill(-1);

    this.peopleMesh = new THREE.InstancedMesh(
      new THREE.CapsuleGeometry(0.55, 1.3, 2, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      people.length
    );
    this.peopleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.peopleMesh);

    this.markerMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1.3),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      clusters.length
    );
    this.scene.add(this.markerMesh);

    this.sosBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 160, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff2040,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.sosBeam.position.y = 80;
    this.sosBeam.visible = false;
    this.scene.add(this.sosBeam);
  }

  #buildTruck() {
    const truck = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: 0xf2ede4, roughness: 0.5 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });

    const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2, 4), paint);
    body.position.set(0, 1.6, -0.8);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.65, 0.4, 4.05), orange);
    stripe.position.set(0, 1.4, -0.8);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.6, 1.8), paint);
    cab.position.set(0, 1.4, 2.2);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.7, 0.1), new THREE.MeshBasicMaterial({ color: 0x223355 }));
    glass.position.set(0, 1.8, 3.11);
    truck.add(body, stripe, cab, glass);

    this.lightBarMat = new THREE.MeshBasicMaterial({ color: CHANNELS[0] });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 0.5), this.lightBarMat);
    bar.position.set(0, 2.35, 2.2);
    truck.add(bar);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3.6), paint);
    mast.rotation.x = Math.PI / 2;
    mast.position.set(0, 2.8, -0.8);
    truck.add(mast);

    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.45, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [[-1.3, 2], [1.3, 2], [-1.3, -2], [1.3, -2]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.position.set(x, 0.55, z);
      truck.add(w);
    }

    const head = new THREE.SpotLight(0xfff2d0, 180, 90, 0.6, 0.6, 1.2);
    head.position.set(0, 1.5, 3);
    head.target.position.set(0, 0, 20);
    truck.add(head, head.target);

    this.truckGlow = new THREE.PointLight(CHANNELS[0], 25, 16, 1.5);
    this.truckGlow.position.y = 1;
    truck.add(this.truckGlow);

    this.scene.add(truck);
    this.truck = { obj: truck, x: 0, z: 6, heading: 0, v: 0 };
  }

  #buildPackets() {
    this.packetMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      PACKET_POOL
    );
    this.packetMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.packets = Array.from({ length: PACKET_POOL }, () => ({ active: false, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3() }));
    this.scene.add(this.packetMesh);
  }

  // Guide arrow toward the next crowd, plus the "deploy here" ghost ring.
  #buildGuides() {
    const arrow = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: GOAL_COLOR });
    const head = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.4, 4), mat);
    head.rotation.x = Math.PI / 2;
    head.position.z = 1.6;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 2), mat);
    arrow.add(head, tail);
    arrow.visible = false;
    this.arrow = arrow;
    this.scene.add(arrow);

    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.RingGeometry(CELL_RANGE - 0.8, CELL_RANGE, 96), this.ghostMat);
    this.ghost.rotation.x = -Math.PI / 2;
    this.ghost.position.y = 0.6;
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  // Signal gain from a tower at (x, z) to every person: inverse-square path
  // loss inside the range, cut by every tall building on the path.
  #gainFor(x, z) {
    const { people } = this.city;
    const gain = new Float32Array(people.length);
    people.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > CELL_RANGE * 1.2) return;
      let walls = 0;
      for (const b of this.tallBuildings) if (segmentHitsBox(x, z, p.x, p.z, b)) walls++;
      gain[i] = (CELL_RANGE / Math.max(d, 4)) ** 2 * WALL_LOSS ** walls;
    });
    return gain;
  }

  #makeCell(x, z, channel) {
    const group = new THREE.Group();
    group.position.set(x, 0.4, z);
    const color = CHANNELS[channel];
    const steel = new THREE.MeshStandardMaterial({ color: 0xdfe5ee, roughness: 0.4 });
    const lit = new THREE.MeshBasicMaterial({ color });

    const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 1.8), steel);
    base.position.y = 0.4;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.35, 12, 6), steel);
    mast.geometry.translate(0, 6, 0);
    const top = new THREE.Group();
    top.add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), lit));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.8, 0.2), lit);
      panel.position.set(Math.sin(a) * 0.7, -1.2, Math.cos(a) * 0.7);
      panel.rotation.y = a;
      top.add(panel);
    }
    group.add(base, mast, top);

    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(CELL_RANGE - 0.8, CELL_RANGE, 120), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.15;
    const discMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(CELL_RANGE, 64), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.12;
    const pulse = new THREE.Mesh(new THREE.RingGeometry(CELL_RANGE - 1.5, CELL_RANGE, 96), ringMat.clone());
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.2;
    group.add(ring, disc, pulse);
    this.scene.add(group);

    return { x, z, channel, group, mast, top, ring, disc, pulse, gain: this.#gainFor(x, z), grow: 0, delay: 0, removing: false };
  }

  #setupDemo() {
    // Towers on the biggest crowds, spread apart, cycling through channels.
    const { clusters } = this.city;
    const picks = [];
    for (const c of [...clusters].sort((a, b) => b.count - a.count)) {
      if (picks.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 85)) picks.push(c);
      if (picks.length === 4) break;
    }
    picks.forEach((c, i) => {
      const cell = this.#makeCell(c.x, c.z, i % 3);
      cell.delay = 0.6 + i * 1.4;
      this.cells.push(cell);
    });
    const a = 2 * PITCH;
    this.route = [[-a, -a], [a, -a], [a, a], [-a, a]];
    this.routeIdx = 0;
  }

  // ---------------------------------------------------------------- HUD

  #buildHud() {
    this.hudRoot.innerHTML = `
      <div class="ghud deadzone">
        <div class="g-tl"><div class="label">TIME</div><div class="value big" data-time>01:30</div></div>
        <div class="g-tc">
          <div class="label">PEOPLE CONNECTED</div>
          <div class="value"><span data-conn>0</span> / ${this.city.people.length}</div>
          <div class="bar"><div data-bar></div></div>
        </div>
        <div class="g-tr"><div class="label">MESSAGES DELIVERED</div><div class="value big" data-score>0</div></div>
        <div class="g-bl">
          <div class="label">TOWERS ON TRUCK</div><div class="cells" data-cells></div>
          <div class="label">CHANNEL <span class="keyhint">SHIFT / Ⓧ</span></div><div class="channels" data-channels></div>
        </div>
        <canvas class="minimap" width="240" height="240" data-map></canvas>
        <div class="hint" data-hint></div>
        <div class="toast" data-toast></div>
        <div class="goal-marker" data-goal></div>
        <div class="sos-marker" data-sos>SOS</div>
      </div>`;
    const q = (k) => this.hudRoot.querySelector(`[data-${k}]`);
    this.ui = {
      time: q('time'), conn: q('conn'), bar: q('bar'), score: q('score'), cells: q('cells'), channels: q('channels'),
      map: q('map'), hint: q('hint'), toast: q('toast'), sos: q('sos'), goal: q('goal'),
    };
    this.ui.channels.innerHTML = CHANNELS.map((c, i) => `<span style="--c:${hex(c)}">${i + 1}</span>`).join('');
    this.#drawMapBase();
  }

  #drawMapBase() {
    const size = 240;
    const base = document.createElement('canvas');
    base.width = base.height = size;
    const g = base.getContext('2d');
    const k = size / EXTENT;
    g.fillStyle = 'rgba(8,12,24,0.9)';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#222a3c';
    for (const b of this.city.blocks) g.fillRect((b.minX + HALF) * k, (b.minZ + HALF) * k, (b.maxX - b.minX) * k, (b.maxZ - b.minZ) * k);
    for (const b of this.city.buildings) {
      g.fillStyle = b.h >= TALL ? '#4a6fae' : '#2e3a55';
      g.fillRect((b.minX + HALF) * k, (b.minZ + HALF) * k, (b.maxX - b.minX) * k, (b.maxZ - b.minZ) * k);
    }
    this.mapBase = base;
    this.mapK = k;
  }

  #toast(text, cls = '') {
    if (!this.ui) return;
    const el = this.ui.toast;
    el.innerHTML = text;
    el.className = `toast show ${cls}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (el.className = 'toast'), 2800);
  }

  // ---------------------------------------------------------------- loop

  update(dt, input, live) {
    if (this.demo) input = this.#autopilot();
    const timed = live && !this.demo;
    if (timed) this.time -= dt;
    if (live) this.elapsed += dt;

    this.#driveTruck(dt, live ? input.steer : 0, live ? input.throttle : 0, live ? input.brake : 0);

    if (timed && input.pressed('alt')) {
      this.channel = (this.channel + 1) % CHANNELS.length;
      this.lightBarMat.color.setHex(CHANNELS[this.channel]);
      this.truckGlow.color.setHex(CHANNELS[this.channel]);
      this.previewTimer = 0;
      sfx.select();
    }
    const nearCell = this.#nearestCell();
    const slow = Math.abs(this.truck.v) < DEPLOY_SPEED;
    if (timed && input.pressed('action')) {
      if (!slow) {
        sfx.error();
        this.#toast('STOP THE TRUCK FIRST <b>(▼ / LT)</b>', 'warn');
      } else if (nearCell) {
        this.#pickUp(nearCell);
      } else if (this.#towersLeft() > 0) {
        this.#deploy();
      } else {
        sfx.error();
        this.#toast('NO TOWERS LEFT: PICK ONE UP AND MOVE IT', 'warn');
      }
    }

    this.#updateCells(dt);
    const connected = this.#updateLinks(dt);
    if (timed) this.score += connected * dt;
    this.peak = Math.max(this.peak, connected);
    if (!this.demo) {
      this.#updateSos(dt, timed);
      this.#updateGoal(dt);
      this.#updatePreview(dt, slow && !nearCell && this.#towersLeft() > 0);
    }
    this.#updatePeople();
    this.#updatePackets(dt, connected);
    this.#placeCamera(dt);
    if (this.ui) this.#updateHud(connected, nearCell, slow);

    this.beaconMat.color.setHex(0xff2030).multiplyScalar(Math.sin(this.elapsed * 4) > 0.3 ? 1 : 0.2);
    this.view.render();

    if (timed && this.time <= 0) return this.#result();
    return null;
  }

  #towersLeft() {
    return CELL_COUNT - this.cells.filter((c) => !c.removing).length;
  }

  // Demo driver: loops the inner ring road.
  #autopilot() {
    const tr = this.truck;
    const [wx, wz] = this.route[this.routeIdx];
    if (Math.hypot(wx - tr.x, wz - tr.z) < 10) this.routeIdx = (this.routeIdx + 1) % this.route.length;
    const err = wrapAngle(Math.atan2(wx - tr.x, wz - tr.z) - tr.heading);
    return {
      steer: clamp(-err * 2.5, -1, 1),
      throttle: Math.abs(err) < 0.4 ? 0.55 : 0.2,
      brake: Math.abs(err) > 1 && tr.v > 10 ? 0.6 : 0,
      pressed: () => false,
    };
  }

  #driveTruck(dt, steer, throttle, brake) {
    const tr = this.truck;
    const accel = throttle * 30 - brake * (tr.v > 0.5 ? 55 : 18);
    tr.v += accel * dt;
    tr.v -= tr.v * 0.6 * dt;
    if (!throttle && !brake) tr.v -= Math.sign(tr.v) * Math.min(Math.abs(tr.v), 8 * dt);
    tr.v = clamp(tr.v, -12, 36);

    const grip = clamp(Math.abs(tr.v) / 6, 0, 1) * Math.sign(tr.v);
    tr.heading -= steer * 2.1 * grip * dt;
    tr.x += Math.sin(tr.heading) * tr.v * dt;
    tr.z += Math.cos(tr.heading) * tr.v * dt;

    // Push out of buildings.
    this.bumpCooldown -= dt;
    for (const b of this.city.buildings) {
      const cx = clamp(tr.x, b.minX, b.maxX);
      const cz = clamp(tr.z, b.minZ, b.maxZ);
      const dx = tr.x - cx;
      const dz = tr.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < TRUCK_RADIUS * TRUCK_RADIUS) {
        const d = Math.sqrt(d2) || 0.001;
        tr.x = cx + (dx / d) * TRUCK_RADIUS;
        tr.z = cz + (dz / d) * TRUCK_RADIUS;
        if (Math.abs(tr.v) > 10 && this.bumpCooldown <= 0) {
          sfx.hit();
          this.bumpCooldown = 0.5;
        }
        tr.v *= 0.4;
      }
    }
    const lim = HALF - TRUCK_RADIUS;
    tr.x = clamp(tr.x, -lim, lim);
    tr.z = clamp(tr.z, -lim, lim);

    tr.obj.position.set(tr.x, 0, tr.z);
    tr.obj.rotation.y = tr.heading;
    tr.obj.rotation.z = -steer * clamp(tr.v / 36, 0, 1) * 0.06;
  }

  #nearestCell() {
    let best = null;
    let bestD = PICKUP_DIST;
    for (const c of this.cells) {
      if (c.removing) continue;
      const d = Math.hypot(c.x - this.truck.x, c.z - this.truck.z);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  // Towers go down beside the truck so the mast doesn't block the camera.
  #deploySpot() {
    const tr = this.truck;
    return [tr.x - Math.cos(tr.heading) * 3.5, tr.z + Math.sin(tr.heading) * 3.5];
  }

  #deploy() {
    const [x, z] = this.#deploySpot();
    const before = this.#evaluate(this.cells, false).connected;
    const cell = this.#makeCell(x, z, this.channel);
    const after = this.#evaluate([...this.cells, { ...cell, grow: 1 }], false).connected;
    this.cells.push(cell);
    this.deployed++;
    this.preview = null;
    sfx.deploy();
    const gained = after - before;
    if (this.deployed === 1) this.#toast(`TOWER UP! <b>+${gained}</b> PEOPLE ONLINE · NOW FIND THE NEXT CROWD`, 'good');
    else if (gained > 0) this.#toast(`TOWER UP · <b>+${gained}</b> PEOPLE`, 'good');
    else this.#toast('TOWER UP, BUT NOBODY NEW IS IN RANGE', 'warn');
  }

  #pickUp(cell) {
    cell.removing = true;
    sfx.pickup();
  }

  #updateCells(dt) {
    for (const c of this.cells) {
      if (c.delay > 0) {
        c.delay -= dt;
        c.group.visible = false;
        continue;
      }
      c.group.visible = true;
      c.grow = clamp(c.grow + (c.removing ? -dt * 3 : dt * 0.9), 0, 1);
      const g = THREE.MathUtils.smoothstep(c.grow, 0, 1);
      c.mast.scale.y = Math.max(0.02, g);
      c.top.position.y = 12 * g + 0.5;
      c.ring.scale.setScalar(g + 0.001);
      c.disc.scale.setScalar(g + 0.001);
      const p = (this.elapsed * 0.6 + c.x * 0.01) % 1;
      c.pulse.scale.setScalar(g * p + 0.001);
      c.pulse.material.opacity = (1 - p) * 0.6 * g;
    }
    for (const c of this.cells.filter((c) => c.removing && c.grow <= 0)) {
      this.scene.remove(c.group);
      c.group.traverse((o) => o.geometry?.dispose());
    }
    this.cells = this.cells.filter((c) => !(c.removing && c.grow <= 0));
  }

  // Who is connected: best-server signal, then SINR against the other
  // towers sharing that channel. With write=false it's a dry run.
  #evaluate(cells, write) {
    const n = this.city.people.length;
    const sums = [0, 0, 0];
    let connected = 0;
    let jammed = 0;
    let newly = 0;
    for (let i = 0; i < n; i++) {
      sums[0] = sums[1] = sums[2] = 0;
      let best = 0;
      let bestCell = -1;
      for (let ci = 0; ci < cells.length; ci++) {
        const c = cells[ci];
        const g = c.gain[i];
        if (!g) continue;
        const s = g * c.grow * c.grow;
        sums[c.channel] += s;
        if (s > best) {
          best = s;
          bestCell = ci;
        }
      }
      let state = 0;
      if (best >= 1) {
        const interference = sums[cells[bestCell].channel] - best;
        state = interference <= 0 || best / interference >= SINR_MIN ? 1 : 2;
      }
      if (state === 1) connected++;
      else if (state === 2) jammed++;
      if (write) {
        if (state === 1 && this.personState[i] !== 1) newly++;
        this.personState[i] = state;
        this.personCell[i] = state === 1 ? bestCell : -1;
      }
    }
    return { connected, jammed, newly };
  }

  #updateLinks(dt) {
    const { connected, jammed, newly } = this.#evaluate(this.cells, true);
    this.blipCooldown -= dt;
    if (newly && this.blipCooldown <= 0) {
      sfx.connect();
      this.blipCooldown = 0.05;
    }
    this.jamToastCooldown -= dt;
    if (jammed >= 4 && this.jamToastCooldown <= 0) {
      this.#toast(`INTERFERENCE! <b>${jammed}</b> USERS JAMMED: OVERLAPPING TOWERS SHARE A CHANNEL. USE DIFFERENT COLOURS`, 'warn');
      this.jamToastCooldown = 7;
    }
    this.jammed = jammed;
    return connected;
  }

  // While stopped, show what a tower here would do before you commit.
  #updatePreview(dt, canDeploy) {
    this.ghost.visible = canDeploy;
    if (!canDeploy) {
      this.preview = null;
      return;
    }
    const [x, z] = this.#deploySpot();
    this.ghost.position.x = x;
    this.ghost.position.z = z;
    this.ghostMat.opacity = 0.35 + 0.25 * Math.sin(this.elapsed * 6);

    this.previewTimer -= dt;
    if (this.previewTimer > 0 && this.preview) return;
    this.previewTimer = PREVIEW_EVERY;
    const moved = !this.preview || Math.hypot(this.preview.x - x, this.preview.z - z) > 1;
    const gain = moved ? this.#gainFor(x, z) : this.preview.gain;
    const now = this.#evaluate(this.cells, false);
    const options = [0, 1, 2].map((ch) => {
      const r = this.#evaluate([...this.cells, { gain, channel: ch, grow: 1 }], false);
      return { ch, delta: r.connected - now.connected, jam: r.jammed - now.jammed };
    });
    const mine = options[this.channel];
    const best = options.reduce((a, b) => (b.delta > a.delta ? b : a));
    this.preview = { x, z, gain, delta: mine.delta, jam: mine.jam, better: best.delta > mine.delta + 2 ? best : null };
  }

  #updateGoal(dt) {
    this.goalTimer -= dt;
    if (this.goalTimer > 0) return;
    this.goalTimer = 0.5;
    // Most disconnected people, discounted by how far away they are.
    const tr = this.truck;
    let best = null;
    let bestScore = 0;
    this.city.clusters.forEach((c, i) => {
      const off = c.people.filter((p) => this.personState[p] !== 1).length;
      if (off < 3) return;
      const d = Math.hypot(c.x - tr.x, c.z - tr.z);
      const s = off / (1 + d / 50);
      if (s > bestScore) {
        bestScore = s;
        best = { i, off, d };
      }
    });
    this.goal = best;
  }

  #updateSos(dt, live) {
    const { clusters } = this.city;
    if (live && !this.sos && this.elapsed >= this.nextSos) {
      const candidates = clusters.map((c, i) => i).filter((i) => clusters[i].people.every((p) => this.personState[p] !== 1));
      if (candidates.length) {
        const idx = candidates[Math.floor(Math.random() * candidates.length)];
        this.sos = { cluster: idx, time: SOS_WINDOW };
        this.sosBeam.position.x = clusters[idx].x;
        this.sosBeam.position.z = clusters[idx].z;
        this.sosBeam.visible = true;
        this.#toast('SOS! EMERGENCY CALLERS NEED SIGNAL: FOLLOW THE <b>RED BEAM</b>', 'sos');
        sfx.error();
      }
      this.nextSos = this.elapsed + SOS_EVERY;
    }
    if (!this.sos) return;

    if (live) this.sos.time -= dt;
    const c = clusters[this.sos.cluster];
    const ok = c.people.filter((p) => this.personState[p] === 1).length >= Math.ceil(c.people.length / 2);
    this.sosBeam.material.opacity = 0.25 + 0.2 * Math.sin(this.elapsed * 10);
    if (ok) {
      this.score += SOS_BONUS;
      this.sosAnswered++;
      this.#toast(`SOS ANSWERED <b>+${SOS_BONUS}</b>`, 'good');
      sfx.checkpoint();
      this.#clearSos();
    } else if (this.sos.time <= 0) {
      this.#toast('SOS MISSED', 'warn');
      this.#clearSos();
    }
  }

  #clearSos() {
    this.sos = null;
    this.sosBeam.visible = false;
  }

  #updatePeople() {
    const { people, clusters } = this.city;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const t = this.elapsed;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const st = this.personState[i];
      // Connected people bounce, they've got messages to send.
      const hop = st === 1 ? Math.abs(Math.sin(t * 6 + p.phase)) * 0.6 : 0;
      m.makeTranslation(p.x, 1.6 + hop, p.z);
      this.peopleMesh.setMatrixAt(i, m);
      if (st === 1) col.setHex(CHANNELS[this.cells[this.personCell[i]].channel]);
      // Jammed users flicker: they have signal but can't decode it.
      else if (st === 2) col.copy(JAMMED).multiplyScalar(Math.sin(t * 20 + p.phase) > 0 ? 1 : 0.3);
      else col.copy(NO_SIGNAL);
      this.peopleMesh.setColorAt(i, col);
    }
    this.peopleMesh.instanceMatrix.needsUpdate = true;
    this.peopleMesh.instanceColor.needsUpdate = true;

    const scale = new THREE.Vector3();
    clusters.forEach((c, i) => {
      const on = c.people.filter((p) => this.personState[p] === 1).length / c.people.length;
      const isSos = this.sos?.cluster === i;
      const isGoal = this.goal?.i === i;
      const s = isSos ? 2.2 : on >= 0.5 ? 0.5 : isGoal ? 1.6 : 1;
      m.makeRotationY(t * 2).scale(scale.setScalar(s)).setPosition(c.x, 6.5 + Math.sin(t * 2 + i) * 0.6, c.z);
      this.markerMesh.setMatrixAt(i, m);
      col.setHex(isSos ? 0xff2040 : on >= 0.5 ? 0x7dffb0 : isGoal ? GOAL_COLOR : 0xff3050);
      this.markerMesh.setColorAt(i, col);
    });
    this.markerMesh.instanceMatrix.needsUpdate = true;
    this.markerMesh.instanceColor.needsUpdate = true;
  }

  #updatePackets(dt, connected) {
    const { people } = this.city;
    this.packetBudget += Math.min(connected, 160) * 0.35 * dt;
    let guard = 0;
    while (this.packetBudget >= 1 && guard++ < 20) {
      this.packetBudget -= 1;
      const slot = this.packets.find((p) => !p.active);
      if (!slot) break;
      // A random connected person sends a message up to their tower.
      for (let tries = 0; tries < 8; tries++) {
        const i = Math.floor(Math.random() * people.length);
        if (this.personState[i] !== 1) continue;
        const c = this.cells[this.personCell[i]];
        slot.active = true;
        slot.t = 0;
        slot.color = CHANNELS[c.channel];
        slot.from.set(people[i].x, 2, people[i].z);
        slot.to.set(c.x, 12.9, c.z);
        break;
      }
    }

    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const pos = new THREE.Vector3();
    this.packets.forEach((p, i) => {
      if (p.active) {
        p.t += dt * 1.6;
        if (p.t >= 1) p.active = false;
      }
      if (!p.active) {
        m.makeScale(0, 0, 0);
      } else {
        pos.lerpVectors(p.from, p.to, p.t);
        pos.y += Math.sin(p.t * Math.PI) * 4;
        m.makeTranslation(pos.x, pos.y, pos.z);
        col.setHex(p.color);
        this.packetMesh.setColorAt(i, col);
      }
      this.packetMesh.setMatrixAt(i, m);
    });
    this.packetMesh.instanceMatrix.needsUpdate = true;
    if (this.packetMesh.instanceColor) this.packetMesh.instanceColor.needsUpdate = true;
  }

  #placeCamera(dt) {
    const tr = this.truck;
    const k = 1 - Math.exp(-dt * 4);
    if (this.demo) {
      // Slow cinematic orbit around the truck.
      const a = this.elapsed * 0.08;
      const target = new THREE.Vector3(tr.x + Math.cos(a) * 80, 58, tr.z + Math.sin(a) * 80);
      this.camera.position.lerp(target, dt > 0.5 ? 1 : k * 0.5);
      this.camera.lookAt(tr.x, 0, tr.z);
      return;
    }
    const fx = Math.sin(tr.heading);
    const fz = Math.cos(tr.heading);
    const back = 24 + Math.abs(tr.v) * 0.25;
    const target = new THREE.Vector3(tr.x - fx * back, 21 + Math.abs(tr.v) * 0.15, tr.z - fz * back);
    this.camera.position.lerp(target, k);
    this.camera.lookAt(tr.x + fx * 10, 1, tr.z + fz * 10);

    // Guide arrow floats over the truck and points at the next crowd.
    const goal = this.goal && this.city.clusters[this.goal.i];
    const showArrow = !!goal && this.goal.d > 22 && !this.ghost.visible;
    this.arrow.visible = showArrow;
    if (showArrow) {
      this.arrow.position.set(tr.x, 7.5 + Math.sin(this.elapsed * 4) * 0.4, tr.z);
      this.arrow.rotation.y = Math.atan2(goal.x - tr.x, goal.z - tr.z);
    }
  }

  #updateHud(connected, nearCell, slow) {
    const ui = this.ui;
    ui.time.textContent = fmtTime(this.time);
    ui.time.classList.toggle('danger', this.time < 10);
    ui.conn.textContent = connected;
    ui.bar.style.width = `${(connected / this.city.people.length) * 100}%`;
    ui.score.textContent = Math.floor(this.score).toLocaleString();

    const left = this.#towersLeft();
    if (ui.cells.dataset.k !== `${left}`) {
      ui.cells.dataset.k = `${left}`;
      ui.cells.innerHTML = Array.from({ length: CELL_COUNT }, (_, i) => `<i class="${i < left ? 'on' : ''}"></i>`).join('');
    }
    [...ui.channels.children].forEach((el, i) => el.classList.toggle('on', i === this.channel));

    // One contextual instruction at a time, most urgent first.
    let hint = '';
    let cls = '';
    const pv = this.preview;
    if (nearCell && slow) {
      hint = '<b>SPACE / Ⓐ</b> PICK UP THIS TOWER';
    } else if (slow && pv) {
      if (pv.better && pv.better.delta >= 3) {
        hint = `THIS SPOT JAMS ON CH ${this.channel + 1}: PRESS <b>SHIFT / Ⓧ</b> FOR CH ${pv.better.ch + 1} (<b>+${pv.better.delta}</b>)`;
        cls = 'warn';
      } else if (pv.delta < 0) {
        hint = 'TOO CLOSE TO ANOTHER TOWER: <b>DRIVE ON</b> TO A NEW CROWD';
        cls = 'warn';
      } else if (pv.delta >= 3) {
        hint = `<b>SPACE / Ⓐ</b> DEPLOY HERE: REACHES <b>+${pv.delta}</b> PEOPLE`;
        cls = 'good';
      } else {
        hint = `ONLY <b>+${Math.max(0, pv.delta)}</b> HERE: GET CLOSER TO A RED CROWD`;
        cls = 'warn';
      }
    } else if (slow && left === 0) {
      hint = 'NO TOWERS LEFT: DRIVE TO ONE AND PICK IT UP';
    } else if (this.goal && this.goal.d < 30 && this.cells.length === 0) {
      hint = '<b>STOP HERE</b> (▼ / LT) TO SET UP A TOWER';
    } else if (this.cells.length === 0) {
      hint = 'FOLLOW THE <b>YELLOW ARROW</b> TO PEOPLE WITH NO SIGNAL';
    }
    if (ui.hint.innerHTML !== hint) ui.hint.innerHTML = hint;
    ui.hint.className = `hint ${cls}`;

    this.#drawMap();
    const goal = this.goal && this.city.clusters[this.goal.i];
    this.#placeMarker(ui.goal, goal, goal && this.goal.d > 22 && `${this.goal.off} NO SIGNAL · ${Math.round(this.goal.d)} m`);
    const sosC = this.sos && this.city.clusters[this.sos.cluster];
    this.#placeMarker(ui.sos, sosC, sosC && `SOS ${Math.ceil(this.sos.time)}s`);
  }

  #drawMap() {
    const g = this.ui.map.getContext('2d');
    const k = this.mapK;
    const X = (x) => (x + HALF) * k;
    g.drawImage(this.mapBase, 0, 0);
    for (const c of this.cells) {
      g.globalAlpha = 0.22 * c.grow;
      g.fillStyle = hex(CHANNELS[c.channel]);
      g.beginPath();
      g.arc(X(c.x), X(c.z), CELL_RANGE * k * c.grow, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      g.fillRect(X(c.x) - 2, X(c.z) - 2, 4, 4);
    }
    const { people } = this.city;
    for (let i = 0; i < people.length; i++) {
      const st = this.personState[i];
      g.fillStyle = st === 1 ? '#7dffb0' : st === 2 ? '#9aa2c0' : '#ff3050';
      g.fillRect(X(people[i].x) - 1.5, X(people[i].z) - 1.5, 3, 3);
    }
    const blink = Math.sin(this.elapsed * 10) > 0;
    const ring = (c, color) => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(X(c.x), X(c.z), 8, 0, Math.PI * 2);
      g.stroke();
    };
    if (this.goal) ring(this.city.clusters[this.goal.i], hex(GOAL_COLOR));
    if (this.sos && blink) ring(this.city.clusters[this.sos.cluster], '#ff2040');
    const tr = this.truck;
    g.save();
    g.translate(X(tr.x), X(tr.z));
    g.rotate(-tr.heading);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, 7);
    g.lineTo(-5, -5);
    g.lineTo(5, -5);
    g.closePath();
    g.fill();
    g.restore();
  }

  // Pins a label over a world position, clamped to the screen edge when
  // it's off-screen so it works as a pointer.
  #placeMarker(el, pos, text) {
    if (!pos || !text) {
      el.style.display = 'none';
      return;
    }
    const p = new THREE.Vector3(pos.x, 9, pos.z).project(this.camera);
    const behind = p.z > 1;
    let { x, y } = p;
    if (behind) {
      x = -x;
      y = -y;
    }
    // Bottom edge sits higher so markers never cover the hint bar.
    const top = 0.8;
    const bottom = 0.5;
    const over = Math.max(Math.abs(x) / 0.85, y > 0 ? y / top : -y / bottom);
    if (behind || over > 1) {
      x /= over;
      y /= over;
      if (behind) y = -bottom;
    }
    el.style.display = 'block';
    el.style.left = `${(x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-y * 0.5 + 0.5) * innerHeight}px`;
    el.textContent = text;
  }

  #result() {
    return {
      score: Math.floor(this.score),
      stats: [
        ['Messages delivered', Math.floor(this.score).toLocaleString()],
        ['Peak people online', `${this.peak} / ${this.city.people.length}`],
        ['SOS calls answered', this.sosAnswered],
        ['Towers deployed', this.deployed],
      ],
      fact:
        'After real disasters, carriers roll in "Cells on Wheels" (COWs): trucks with a mast and a satellite or microwave backhaul. ' +
        "Neighbouring cells use different frequencies so they don't interfere. That's frequency reuse, the idea behind every cellular network.",
    };
  }

  dispose() {
    clearTimeout(this.toastTimer);
    if (this.hudRoot) this.hudRoot.innerHTML = '';
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
  }
}
