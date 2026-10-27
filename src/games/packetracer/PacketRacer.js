import * as THREE from 'three';
import { sfx } from '../../core/audio.js';

const TRACK_HALF = 9;
const START_TTL = 30;
const HIT_PENALTY = 4;
const SEGMENT = 40;
const VIEW_AHEAD = 360;
const ROUTER_EVERY = 14; // segments between routers
const ROUTER_SPAN = 3; // segments the split lasts before the router gate
const PLAYER_R = 0.9;
const SLOWMO_DIST = 90; // start slow motion this far before a fork
const SLOWMO_TIME = 1.7; // real seconds
const SLOWMO_SCALE = 0.3;
const CYAN = 0x29e6ff;
const MAGENTA = 0xff2fd6;
const RED = 0xff2a3a;
const GREEN = 0x3dff8b;

const clamp = THREE.MathUtils.clamp;

const gridVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const gridFrag = /* glsl */ `
  uniform float uHalf;
  uniform vec3 uGrid;
  uniform vec3 uLane;
  varying vec3 vWorld;

  float line(float p, float spacing, float width) {
    float g = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
    return 1.0 - smoothstep(0.0, fwidth(p) * width, g);
  }

  void main() {
    float dist = length(vWorld - cameraPosition);
    float fade = exp(-dist * 0.007);
    float onTrack = step(abs(vWorld.x), uHalf);
    vec3 col = vec3(0.0);

    float grid = max(line(vWorld.x, 10.0, 1.4), line(vWorld.z, 10.0, 1.4));
    col += uGrid * grid * (1.0 - onTrack) * 0.7;

    // Lane dividers (dashed) and cross ticks for a sense of speed.
    float laneW = uHalf * 2.0 / 3.0;
    float lanes = line(vWorld.x + uHalf, laneW, 1.6) * step(0.5, fract(vWorld.z / 8.0));
    float ticks = line(vWorld.z, 6.0, 1.0) * 0.18;
    col += uLane * (lanes * 0.8 + ticks) * onTrack;
    col += vec3(0.01, 0.0, 0.03) * onTrack;

    gl_FragColor = vec4(col * fade, 1.0);
  }`;

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  g.font = 'bold 64px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 24;
  g.fillStyle = color;
  const lines = text.split('\n');
  lines.forEach((l, i) => g.fillText(l, 256, 80 + (i - (lines.length - 1) / 2) * 64));
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(16, 5, 1);
  return sprite;
}

export class PacketRacer {
  static id = 'packetracer';

  // demo: self-driving, endless and HUD-less, for the title screen.
  constructor(view, hudRoot, { demo = false } = {}) {
    this.view = view;
    this.hudRoot = hudRoot;
    this.demo = demo;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020008);
    this.scene.fog = new THREE.Fog(0x020008, 120, VIEW_AHEAD);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 900);

    this.ttl = START_TTL;
    this.elapsed = 0;
    this.distance = 0;
    this.hops = 0;
    this.hits = 0;
    this.shieldsUsed = 0;
    this.bonus = 0;
    this.boost = 1; // bandwidth meter 0..1
    this.boosting = false;
    this.shield = false;
    this.shake = 0;
    this.speed = 0;
    this.timeScale = 1;
    this.slowmo = 0;
    this.forkRouter = null;
    this.player = { x: 0, z: 0, vx: 0 };
    this.objects = [];
    this.routers = [];
    this.segmentIndex = 2; // leave the start clear
    this.spawnZ = -SEGMENT * 2;

    this.#buildWorld();
    this.#buildPlayer();
    if (!demo) this.#buildHud();
    view.use(this.scene, this.camera, { strength: 0.75, radius: 0.35, threshold: 0.5 });
    this.#placeCamera(1);
  }

  // ---------------------------------------------------------------- world

  #buildWorld() {
    const s = this.scene;
    s.add(new THREE.AmbientLight(0x6060a0, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(10, 30, 20);
    s.add(key);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(600, VIEW_AHEAD * 2 + 200),
      new THREE.ShaderMaterial({
        vertexShader: gridVert,
        fragmentShader: gridFrag,
        uniforms: {
          uHalf: { value: TRACK_HALF },
          uGrid: { value: new THREE.Color(MAGENTA) },
          uLane: { value: new THREE.Color(CYAN) },
        },
      })
    );
    this.floor.rotation.x = -Math.PI / 2;
    s.add(this.floor);

    this.rails = new THREE.Group();
    const railMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(0.7) });
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.3, VIEW_AHEAD * 2 + 100), railMat);
      rail.position.set(side * (TRACK_HALF + 0.2), 0.15, 0);
      this.rails.add(rail);
    }
    s.add(this.rails);

    // Server towers lining the route.
    const tex = this.#rackTexture();
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x0a0a18, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.towers = [];
    this.towerMesh = new THREE.InstancedMesh(box, rackMat, 70);
    for (let i = 0; i < 70; i++) {
      const side = i % 2 ? 1 : -1;
      this.towers.push({
        x: side * (TRACK_HALF + 8 + Math.random() * 70),
        z: -Math.random() * 800 + 40,
        w: 4 + Math.random() * 6,
        h: 8 + Math.random() * 45,
      });
    }
    s.add(this.towerMesh);

    // Neon "sun" on the horizon.
    this.sun = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(70 + i * 9, 0.6, 8, 120),
        new THREE.MeshBasicMaterial({ color: i % 2 ? CYAN : MAGENTA, fog: false })
      );
      this.sun.add(ring);
    }
    this.sun.position.y = 40;
    s.add(this.sun);

    // Data dust streaming past for speed.
    const n = 500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 120;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = -Math.random() * 300;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: CYAN, size: 0.35 }));
    s.add(this.dust);

    // Shared assets for obstacles.
    this.geo = {
      cube: new THREE.BoxGeometry(2.6, 2.6, 2.6),
      wall: new THREE.BoxGeometry(1, 3.2, 0.8),
      divider: new THREE.BoxGeometry(1.4, 2.5, 1),
      orb: new THREE.IcosahedronGeometry(0.9, 1),
      ring: new THREE.TorusGeometry(1.1, 0.22, 8, 24),
      gate: new THREE.TorusGeometry(TRACK_HALF + 1.5, 0.5, 8, 64, Math.PI),
    };
    this.mat = {
      cube: new THREE.MeshStandardMaterial({ color: 0x330008, emissive: RED, emissiveIntensity: 0.45 }),
      cubeEdge: new THREE.LineBasicMaterial({ color: 0xff8080 }),
      wall: new THREE.MeshStandardMaterial({ color: 0x401000, emissive: 0xff5a1a, emissiveIntensity: 0.5 }),
      divider: new THREE.MeshStandardMaterial({ color: 0x1a0830, emissive: MAGENTA, emissiveIntensity: 0.35 }),
      orb: new THREE.MeshBasicMaterial({ color: CYAN }),
      ring: new THREE.MeshBasicMaterial({ color: GREEN }),
      gate: new THREE.MeshBasicMaterial({ color: MAGENTA }),
    };
    this.cubeEdges = new THREE.EdgesGeometry(this.geo.cube);
  }

  #rackTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 256);
    for (let y = 4; y < 256; y += 10) {
      g.fillStyle = 'rgba(41,230,255,0.25)';
      g.fillRect(4, y, 56, 1);
      for (let x = 8; x < 60; x += 6) {
        if (Math.random() < 0.35) {
          g.fillStyle = Math.random() < 0.8 ? '#29e6ff' : '#ff2fd6';
          g.fillRect(x, y + 3, 2, 2);
        }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  #buildPlayer() {
    const g = new THREE.Group();
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.75), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.5, 1.5, 1.5)),
      new THREE.LineBasicMaterial({ color: CYAN })
    );
    this.shieldMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.6, 1),
      new THREE.MeshBasicMaterial({ color: GREEN, wireframe: true, transparent: true, opacity: 0.6 })
    );
    this.shieldMesh.visible = false;
    g.add(this.core, this.shell, this.shieldMesh);
    g.position.y = 1.3;
    this.playerObj = g;
    this.scene.add(g);

    // Light trail: a ribbon of recent positions, fading to black (additive).
    this.trailLen = 40;
    this.trailPts = [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailLen * 2 * 3), 3));
    const colors = new Float32Array(this.trailLen * 2 * 3);
    const c = new THREE.Color(CYAN);
    for (let i = 0; i < this.trailLen; i++) {
      const f = 0.55 * (1 - i / this.trailLen) ** 1.5;
      for (let k = 0; k < 2; k++) colors.set([c.r * f, c.g * f, c.b * f], (i * 2 + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const idx = [];
    for (let i = 0; i < this.trailLen - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.trail = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, transparent: true })
    );
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);
  }

  // ---------------------------------------------------------------- spawning

  #add(type, mesh, x, z, w, d = 1.5) {
    mesh.position.x = x;
    mesh.position.z = z;
    this.scene.add(mesh);
    const o = { type, mesh, x, z, w, d, hit: false };
    this.objects.push(o);
    return o;
  }

  #cube(x, z, drift = 0) {
    const m = new THREE.Mesh(this.geo.cube, this.mat.cube);
    m.add(new THREE.LineSegments(this.cubeEdges, this.mat.cubeEdge));
    m.position.y = 1.3;
    const o = this.#add('cube', m, x, z, 1.3, 1.3);
    o.drift = drift;
    o.baseX = x;
    o.phase = Math.random() * 6;
  }

  #wall(z, gapX, gapW) {
    // A row of firewall blocks with one gap.
    const group = new THREE.Group();
    const left = gapX - gapW / 2;
    const right = gapX + gapW / 2;
    for (let x = -TRACK_HALF + 0.5; x < TRACK_HALF; x += 1.05) {
      if (x > left - 0.5 && x < right + 0.5) continue;
      const b = new THREE.Mesh(this.geo.wall, this.mat.wall);
      b.position.set(x, 1.6, 0);
      group.add(b);
    }
    const o = this.#add('wall', group, 0, z, TRACK_HALF, 0.6);
    o.gapL = left;
    o.gapR = right;
  }

  #pickup(type, x, z) {
    const m = new THREE.Mesh(type === 'shield' ? this.geo.ring : this.geo.orb, type === 'shield' ? this.mat.ring : this.mat.orb);
    m.position.y = 1.4;
    this.#add(type, m, x, z, 1.2, 1.2);
  }

  // The split occupies the ROUTER_SPAN segments starting at segZ, with the
  // router gate at the far end.
  #router(segZ) {
    // Track splits around a divider; the faster path is congested.
    const fastSide = Math.random() < 0.5 ? -1 : 1;
    const len = SEGMENT * ROUTER_SPAN - 10;
    const startZ = segZ - 5;
    const z = startZ - len;
    for (let dz = 0; dz < len; dz += 1.2) {
      const m = new THREE.Mesh(this.geo.divider, this.mat.divider);
      m.position.y = 1.25;
      this.#add('divider', m, 0, z + dz, 0.7, 0.6);
    }
    const fastMs = 8 + Math.floor(Math.random() * 8);
    const slowMs = 35 + Math.floor(Math.random() * 25);
    const fastLbl = makeLabel(`${fastMs} ms\n+9s TTL`, '#29e6ff');
    const slowLbl = makeLabel(`${slowMs} ms\n+4s TTL`, '#ffaa33');
    fastLbl.position.set(fastSide * TRACK_HALF * 0.5, 7, startZ);
    slowLbl.position.set(-fastSide * TRACK_HALF * 0.5, 7, startZ);
    this.scene.add(fastLbl, slowLbl);

    const gate = new THREE.Mesh(this.geo.gate, this.mat.gate);
    gate.position.z = z;
    this.scene.add(gate);
    this.routers.push({ z, startZ, fastSide, fastMs, slowMs, gate, labels: [fastLbl, slowLbl], passed: false, slowed: false });

    // Congestion on the fast side.
    const sideCenter = fastSide * TRACK_HALF * 0.5;
    for (let dz = 25; dz < len - 10; dz += 14 + Math.random() * 8) {
      this.#cube(sideCenter + (Math.random() - 0.5) * 4, z + dz, Math.random() < 0.4 ? 1.5 : 0);
    }
    if (Math.random() < 0.6) this.#pickup('boost', -sideCenter, z + len / 2);
  }

  #spawnSegment(z) {
    const i = this.segmentIndex++;
    const difficulty = clamp(this.elapsed / 90, 0, 1);
    if (i % ROUTER_EVERY === 0) {
      this.#router(z);
      this.skipUntil = i + ROUTER_SPAN;
      return;
    }
    if (i < this.skipUntil) return;
    // Keep the run-up to a fork clear so the slow-mo view isn't blocked.
    if ((i + 1) % ROUTER_EVERY === 0) return;

    const r = Math.random();
    const laneX = () => (Math.floor(Math.random() * 3) - 1) * (TRACK_HALF * 2 / 3);
    if (r < 0.28 + difficulty * 0.1) {
      const gapW = 5 - difficulty * 1.6;
      const gapX = (Math.random() * 2 - 1) * (TRACK_HALF - gapW / 2 - 0.5);
      this.#wall(z, gapX, gapW);
    } else if (r < 0.8) {
      const n = 1 + Math.floor(Math.random() * (2 + difficulty * 2));
      const used = new Set();
      for (let k = 0; k < n; k++) {
        let x = laneX();
        if (used.has(x) && used.size < 3) x = laneX();
        if (used.size === 2 && !used.has(x)) continue; // always leave a lane open
        used.add(x);
        this.#cube(x, z - Math.random() * 16, Math.random() < 0.25 + difficulty * 0.3 ? 2 + Math.random() * 3 : 0);
      }
    }
    if (Math.random() < 0.3) this.#pickup(Math.random() < 0.45 ? 'shield' : 'boost', laneX(), z - SEGMENT / 2);
  }

  // ---------------------------------------------------------------- HUD

  #buildHud() {
    this.hudRoot.innerHTML = `
      <div class="ghud packetracer">
        <div class="g-tl"><div class="label">HOPS</div><div class="value big" data-hops>0</div></div>
        <div class="g-tc">
          <div class="label">TTL</div>
          <div class="value huge" data-ttl>30</div>
          <div class="bar ttl"><div data-ttlbar></div></div>
        </div>
        <div class="g-tr"><div class="label">BYTES DELIVERED</div><div class="value big" data-score>0</div></div>
        <div class="g-bl">
          <div class="label">BANDWIDTH BOOST <span class="keyhint">[SPACE / Ⓐ]</span></div>
          <div class="bar boost"><div data-boost></div></div>
          <div class="label shield-label" data-shield>ECC SHIELD: OFF</div>
        </div>
        <div class="slowmo-vignette" data-vignette></div>
        <div class="fork-banner" data-fork></div>
        <div class="hint" data-hint>STEER <b>◀ ▶</b> · DODGE <b>RED PACKETS</b> · FIND THE <b>GAP</b> IN FIREWALLS</div>
        <div class="toast" data-toast></div>
      </div>`;
    const q = (k) => this.hudRoot.querySelector(`[data-${k}]`);
    this.ui = {
      hops: q('hops'), ttl: q('ttl'), ttlbar: q('ttlbar'), score: q('score'), boost: q('boost'),
      shield: q('shield'), hint: q('hint'), toast: q('toast'), vignette: q('vignette'), fork: q('fork'),
    };
  }

  #toast(text, cls = '') {
    if (!this.ui) return;
    const el = this.ui.toast;
    el.textContent = text;
    el.className = `toast show ${cls}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (el.className = 'toast'), 2000);
  }

  get score() {
    return Math.floor(this.distance * 4 + this.bonus);
  }

  // ---------------------------------------------------------------- loop

  update(dt, input, live) {
    const p = this.player;
    if (this.demo) input = this.#autopilot();
    this.#updateSlowmo(dt);
    // Everything in the world runs on scaled time; real dt is only for
    // camera smoothing and (partly) steering.
    const sdt = dt * this.timeScale;
    if (live) {
      this.elapsed += sdt;
      if (!this.demo) this.ttl -= sdt;
    }

    // Speed ramps up over the run; boosting burns the bandwidth meter.
    const base = !live ? 0 : this.demo ? 55 : Math.min(42 + this.elapsed * 0.55, 95);
    const wantBoost = live && (input.held('action') || input.throttle > 0.5);
    if (wantBoost && this.boost > 0.02) {
      if (!this.boosting) sfx.boost();
      this.boosting = true;
      this.boost = Math.max(0, this.boost - sdt * 0.4);
    } else {
      this.boosting = false;
      this.boost = Math.min(1, this.boost + sdt * 0.04);
    }
    const target = base * (this.boosting ? 1.6 : 1);
    this.speed += (target - this.speed) * Math.min(sdt * 2.5, 1);
    this.prevZ = p.z;
    p.z -= this.speed * sdt;
    this.distance += this.speed * sdt;

    // Steering stays fairly responsive in slow motion so you can line up.
    const steer = live ? input.steer : 0;
    const steerDt = dt * Math.max(this.timeScale, 0.7);
    p.vx += (steer * 24 - p.vx) * Math.min(steerDt * 10, 1);
    p.x = clamp(p.x + p.vx * steerDt, -TRACK_HALF + PLAYER_R, TRACK_HALF - PLAYER_R);

    while (this.spawnZ > p.z - VIEW_AHEAD) {
      this.#spawnSegment(this.spawnZ);
      this.spawnZ -= SEGMENT;
    }

    this.#updateObjects(sdt);
    this.#updateRouters();
    this.#updateScenery();
    this.#updatePlayer(sdt, steer);
    this.#placeCamera(dt);
    this.#updateHud();
    this.view.render();

    if (this.ttl <= 0 && !this.demo) {
      this.ttl = 0;
      return this.#result();
    }
    return null;
  }

  // Slow motion as a router fork comes into view, so there's time to read
  // both paths and pick one.
  #updateSlowmo(dt) {
    const p = this.player;
    for (const r of this.routers) {
      if (!r.slowed && p.z > r.startZ && p.z - r.startZ < SLOWMO_DIST) {
        r.slowed = true;
        this.slowmo = SLOWMO_TIME;
        this.forkRouter = r;
        sfx.slowmo();
        this.#showFork(r);
      }
    }
    this.slowmo = Math.max(0, this.slowmo - dt);
    const target = this.slowmo > 0 ? SLOWMO_SCALE : 1;
    const rate = target < this.timeScale ? 8 : 2.5; // snap in, ease out
    this.timeScale += (target - this.timeScale) * Math.min(dt * rate, 1);

    if (!this.ui) return;
    this.ui.vignette.classList.toggle('on', this.slowmo > 0);
    const showFork = this.forkRouter && p.z > this.forkRouter.startZ - 10;
    this.ui.fork.classList.toggle('show', !!showFork);
    if (!showFork) this.forkRouter = null;
  }

  #showFork(r) {
    if (!this.ui) return;
    const fast = `<div class="side" style="--c:#29e6ff"><b>${r.fastMs} ms</b>+9s TTL · congested</div>`;
    const slow = `<div class="side" style="--c:#ffaa33"><b>${r.slowMs} ms</b>+4s TTL · clear</div>`;
    const [left, right] = r.fastSide < 0 ? [fast, slow] : [slow, fast];
    this.ui.fork.innerHTML = `${left}<div class="mid">ROUTER<br>PICK A PATH</div>${right}`;
  }

  // Demo driver: scores candidate lateral positions against what's ahead
  // and steers toward the cheapest one.
  #autopilot() {
    const p = this.player;
    let best = p.x;
    let bestCost = Infinity;
    for (let x = -TRACK_HALF + 1.2; x <= TRACK_HALF - 1.2; x += 0.5) {
      let cost = Math.abs(x - p.x) * 0.08;
      for (const o of this.objects) {
        if (o.hit || o.z > p.z || o.z < p.z - 70) continue;
        const w = 1.5 - (p.z - o.z) / 70; // nearer things matter more
        if (o.type === 'cube' && Math.abs(o.x - x) < o.w + PLAYER_R + 0.7) cost += 10 * w;
        else if (o.type === 'wall' && (x - PLAYER_R - 0.4 < o.gapL || x + PLAYER_R + 0.4 > o.gapR)) cost += 12 * w;
        else if (o.type === 'divider' && Math.abs(x) < 2.4) cost += 3 * w;
        else if ((o.type === 'boost' || o.type === 'shield') && Math.abs(o.x - x) < 1.5) cost -= 1.5 * w;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = x;
      }
    }
    const steer = clamp((best - p.x) * 0.6, -1, 1);
    return { steer, throttle: 0, brake: 0, held: () => false, pressed: () => false };
  }

  #updateObjects(dt) {
    const p = this.player;
    for (const o of this.objects) {
      if (o.type === 'cube' && o.drift) {
        o.x = clamp(o.baseX + Math.sin(this.elapsed * 1.5 + o.phase) * o.drift, -TRACK_HALF + 1.3, TRACK_HALF - 1.3);
        o.mesh.position.x = o.x;
        o.mesh.rotation.y += dt;
      }
      if (o.type === 'boost' || o.type === 'shield') {
        o.mesh.rotation.y += dt * 3;
        o.mesh.position.y = 1.4 + Math.sin(this.elapsed * 4 + o.z) * 0.3;
      }
      if (o.hit) continue;

      // Swept test: did the span travelled this frame touch the object?
      const reach = o.d + PLAYER_R;
      if (p.z > o.z + reach || this.prevZ < o.z - reach) continue;

      if (o.type === 'wall') {
        if (p.x - PLAYER_R < o.gapL || p.x + PLAYER_R > o.gapR) this.#hit(o, 'FIREWALL BLOCKED YOU');
        else o.hit = true; // passed cleanly
      } else if (o.type === 'divider') {
        // Side contact just pushes you back into your lane.
        if (Math.abs(p.x) < o.w + PLAYER_R) {
          const side = Math.sign(p.x) || 1;
          p.x = side * (o.w + PLAYER_R);
        }
      } else if (Math.abs(o.x - p.x) < o.w + PLAYER_R) {
        if (o.type === 'cube') this.#hit(o, 'PACKET COLLISION');
        else this.#collect(o);
      }
    }

    // Drop anything behind the camera.
    for (const o of this.objects) {
      if (o.z > p.z + 20) this.scene.remove(o.mesh);
    }
    this.objects = this.objects.filter((o) => o.z <= p.z + 20);
  }

  #hit(o, reason) {
    o.hit = true;
    if (this.shield) {
      this.shield = false;
      this.shieldsUsed++;
      this.#toast('ECC SHIELD CORRECTED THE ERROR', 'good');
      sfx.shield();
      o.mesh.visible = o.type === 'wall';
      return;
    }
    this.hits++;
    this.ttl -= HIT_PENALTY;
    this.speed *= 0.45;
    this.shake = 0.5;
    this.#toast(`${reason}  −${HIT_PENALTY}s TTL`, 'warn');
    sfx.hit();
    const root = this.hudRoot?.firstElementChild;
    if (root) {
      root.classList.remove('glitch');
      void root.offsetWidth;
      root.classList.add('glitch');
    }
    if (o.type === 'cube') o.mesh.visible = false;
  }

  #collect(o) {
    o.hit = true;
    o.mesh.visible = false;
    if (o.type === 'boost') {
      this.boost = Math.min(1, this.boost + 0.5);
      this.bonus += 100;
      this.#toast('+BANDWIDTH', 'good');
      sfx.select();
    } else {
      this.shield = true;
      this.bonus += 100;
      this.#toast('ECC SHIELD ONLINE', 'good');
      sfx.shield();
    }
  }

  #updateRouters() {
    const p = this.player;
    for (const r of this.routers) {
      r.gate.rotation.z = Math.sin(this.elapsed * 2) * 0.03;
      if (!r.passed && p.z < r.z) {
        r.passed = true;
        this.hops++;
        const fast = Math.sign(p.x || 1) === r.fastSide;
        const gain = fast ? 9 : 4;
        this.ttl += gain;
        this.bonus += fast ? 1000 : 500;
        this.#toast(`ROUTER HOP ${this.hops} · ${fast ? 'LOW LATENCY' : 'SAFE ROUTE'}  +${gain}s TTL`, 'good');
        sfx.checkpoint();
      }
    }
    for (const r of this.routers.filter((r) => r.z > p.z + 30)) {
      this.scene.remove(r.gate, ...r.labels);
      r.labels.forEach((l) => {
        l.material.map.dispose();
        l.material.dispose();
      });
    }
    this.routers = this.routers.filter((r) => r.z <= p.z + 30);
  }

  #updateScenery() {
    const p = this.player;
    this.floor.position.z = p.z - VIEW_AHEAD / 2;
    this.rails.position.z = p.z - VIEW_AHEAD / 2;
    this.sun.position.z = p.z - 520;
    this.sun.rotation.z = this.elapsed * 0.05;

    const m = new THREE.Matrix4();
    this.towers.forEach((t, i) => {
      if (t.z > p.z + 30) t.z -= 820;
      m.makeScale(t.w, t.h, t.w).setPosition(t.x, 0, t.z);
      this.towerMesh.setMatrixAt(i, m);
    });
    this.towerMesh.instanceMatrix.needsUpdate = true;

    const pos = this.dust.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getZ(i) > p.z + 10) pos.setZ(i, pos.getZ(i) - 300);
    }
    pos.needsUpdate = true;
  }

  #updatePlayer(dt, steer) {
    const p = this.player;
    const o = this.playerObj;
    o.position.set(p.x, 1.3 + Math.sin(this.elapsed * 6) * 0.12, p.z);
    o.rotation.z = -steer * 0.35;
    this.core.rotation.set(this.elapsed * 3, this.elapsed * 4, 0);
    this.shell.rotation.set(-this.elapsed * 1.2, this.elapsed * 0.8, 0);
    this.shell.material.color.setHex(this.boosting ? 0xffffff : CYAN);
    this.shieldMesh.visible = this.shield;
    this.shieldMesh.rotation.y += dt * 2;

    this.trailPts.unshift(new THREE.Vector3(p.x, 1.3, p.z + 0.6));
    if (this.trailPts.length > this.trailLen) this.trailPts.pop();
    const pos = this.trail.geometry.attributes.position;
    const w = this.boosting ? 0.75 : 0.5;
    for (let i = 0; i < this.trailLen; i++) {
      const pt = this.trailPts[Math.min(i, this.trailPts.length - 1)];
      pos.setXYZ(i * 2, pt.x, pt.y + w, pt.z);
      pos.setXYZ(i * 2 + 1, pt.x, pt.y - w, pt.z);
    }
    pos.needsUpdate = true;
  }

  #placeCamera(dt) {
    const p = this.player;
    const cam = this.camera;
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * 1.2;
    // Rise and look further ahead while slowed, to show both paths.
    const k = clamp((1 - this.timeScale) / (1 - SLOWMO_SCALE), 0, 1);
    cam.position.set(
      p.x * 0.55 * (1 - k * 0.6) + (Math.random() - 0.5) * sh,
      4.6 + k * 4 + (Math.random() - 0.5) * sh,
      p.z + 10.5 + k * 2
    );
    cam.lookAt(p.x * 0.75 * (1 - k * 0.6), 1.6, p.z - 14 - k * 22);
    const fov = 70 + (this.boosting ? 14 : 0) + this.speed * 0.05;
    cam.fov += (fov - cam.fov) * Math.min(dt * 4, 1);
    cam.updateProjectionMatrix();
  }

  #updateHud() {
    const ui = this.ui;
    if (!ui) return;
    ui.hops.textContent = this.hops;
    ui.ttl.textContent = Math.max(0, Math.ceil(this.ttl));
    ui.ttl.classList.toggle('danger', this.ttl < 8);
    ui.ttlbar.style.width = `${clamp(this.ttl / 40, 0, 1) * 100}%`;
    ui.score.textContent = this.score.toLocaleString();
    ui.boost.style.width = `${this.boost * 100}%`;
    ui.shield.textContent = `ECC SHIELD: ${this.shield ? 'ON' : 'OFF'}`;
    ui.shield.classList.toggle('on', this.shield);
    ui.hint.style.opacity = this.elapsed < 6 ? 1 : 0;
  }

  #result() {
    return {
      score: this.score,
      stats: [
        ['Bytes delivered', this.score.toLocaleString()],
        ['Router hops', this.hops],
        ['Collisions', this.hits],
        ['Errors corrected (ECC)', this.shieldsUsed],
      ],
      fact:
        'Every IP packet carries a TTL (Time To Live) field. Each router that forwards it subtracts one, and at zero the packet is dropped, so lost packets can\'t loop forever. ' +
        'Routers choose paths using metrics like latency and congestion, and error-correcting codes fix corrupted bits without asking for a resend.',
    };
  }

  dispose() {
    clearTimeout(this.toastTimer);
    if (this.hudRoot) this.hudRoot.innerHTML = '';
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => {
        m.map?.dispose();
        m.emissiveMap?.dispose();
        m.dispose();
      });
    });
  }
}
