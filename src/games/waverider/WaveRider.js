import * as THREE from 'three';
import { beep, noise, sfx } from '../../core/audio.js';
import { createWaveVoice, waveSfx } from './sounds.js';
import { music } from '../../core/music.js';
import { W, H, AMP_UNIT, F_MIN, F_MAX, A_MIN, A_MAX, sampleWave, Ribbon, slotGeometries } from './wave.js';

const SPAWN_Z = -170;
const FIRST_WALL_Z = -95;
const START_SPEED = 24;
const MAX_SPEED = 110;
const SPEED_RAMP = 0.45; // per second, so every run eventually ends
const START_SPACING = 85;
const MIN_SPACING = 45;
const GAP = 0.6; // half-height of the slot
const START_SIGNAL = 100;
const CLOSE_COST = 15;
const BLOCK_COST = 34;
const PERFECT_HEAL = 2;
const FRAME_EVERY = 14;
const FRAME_COUNT = 14;
const DEMO_PACE = 20; // seconds into a run that the title demo stays at
const NOISE_FROM = 35; // seconds in before walls start arriving inside noise clouds
const NOISE_CHANCE = 0.3;
const LEVEL_EVERY = 20; // seconds per difficulty level callout
const REPEAT_DELAY = 0.28;
const REPEAT_EVERY = 0.11;
const WAVE_POINTS = 120;
const CYAN = 0x3df5ff;
const MAGENTA = 0xff3fd2;
const AMBER = 0xffb000;
const RED = 0xff2a3a;
// One note per frequency step (A minor pentatonic) so you hear the change.
const NOTE = [0, 220, 261.63, 293.66, 329.63, 392];

const clamp = THREE.MathUtils.clamp;
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

const gridVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const gridFrag = /* glsl */ `
  uniform float uScroll;
  uniform vec3 uColor;
  varying vec3 vWorld;
  float line(float p, float spacing) {
    float g = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
    return 1.0 - smoothstep(0.0, fwidth(p) * 1.5, g);
  }
  void main() {
    float fade = exp(-length(vWorld - cameraPosition) * 0.012);
    float grid = max(line(vWorld.x, 3.0), line(vWorld.z + uScroll, 6.0));
    gl_FragColor = vec4(uColor * grid * fade * 0.45, 1.0);
  }`;

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.font = '800 72px system-ui, "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 20;
  g.fillStyle = color;
  g.fillText(text, 256, 64);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
  );
  sprite.scale.set(5.6, 1.4, 1);
  return sprite;
}

export class WaveRider {
  static id = 'waverider';

  // demo: plays itself perfectly with no HUD or sound, for the title screen.
  constructor(view, hudRoot, { demo = false } = {}) {
    this.view = view;
    this.hudRoot = hudRoot;
    this.demo = demo;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04010c);
    this.scene.fog = new THREE.Fog(0x04010c, 70, 180);
    this.camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 600);

    this.f = 2;
    this.a = 2;
    this.fv = this.f; // smoothed, for drawing
    this.av = this.a;
    this.elapsed = 0;
    this.time = 0; // never pauses; drives idle animation
    this.speed = 0;
    this.signal = START_SIGNAL;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.perfects = 0;
    this.closes = 0;
    this.blocks = 0;
    this.topSpeed = 0;
    this.walls = [];
    this.lastTarget = { f: this.f, a: this.a };
    this.rep = { x: { dir: 0, t: 0 }, y: { dir: 0, t: 0 } };
    this.shake = 0;
    this.hitJitter = 0;
    this.toneBoost = 0;
    this.demoTimer = 0;
    this.bursts = [];
    this.popupT = 0;
    this.staticT = 0;

    this.#buildWorld();
    this.#buildPlayer();
    if (!demo) this.#buildHud();
    this.tone = demo ? null : createWaveVoice();
    this.beatT = 0;
    this.#spawnWall(FIRST_WALL_Z);

    view.use(this.scene, this.camera, { strength: 0.55, radius: 0.4, threshold: 0.5 });
  }

  // ---------------------------------------------------------------- world

  #buildWorld() {
    const s = this.scene;

    this.floorMat = new THREE.ShaderMaterial({
      vertexShader: gridVert,
      fragmentShader: gridFrag,
      uniforms: { uScroll: { value: 0 }, uColor: { value: new THREE.Color(MAGENTA) } },
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 260), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -H / 2 - 0.8, -110);
    s.add(floor);

    // Tunnel frames streaming past.
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.frames = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(i % 2 ? CYAN : MAGENTA).multiplyScalar(0.3) });
      const fw = W + 1.6;
      const fh = H + 1.6;
      for (const [sx, sy, px, py] of [
        [fw, 0.14, 0, fh / 2],
        [fw, 0.14, 0, -fh / 2],
        [0.14, fh, fw / 2, 0],
        [0.14, fh, -fw / 2, 0],
      ]) {
        const bar = new THREE.Mesh(box, mat);
        bar.scale.set(sx, sy, 0.14);
        bar.position.set(px, py, 0);
        g.add(bar);
      }
      g.position.z = -i * FRAME_EVERY;
      s.add(g);
      this.frames.push(g);
    }

    // Spectrum-analyser bars either side, bouncing with your amplitude.
    this.bars = [];
    const rows = 16;
    const count = rows * 3 * 2;
    this.barMesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), count);
    const col = new THREE.Color();
    for (let side = -1, k = 0; side <= 1; side += 2) {
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < rows; r++, k++) {
          this.bars.push({ x: side * (W / 2 + 4 + c * 2.4), z: -r * 12 - c * 4, phase: Math.random() * 6 });
          col.setHex(c === 0 ? CYAN : c === 1 ? 0x8a6bff : MAGENTA);
          this.barMesh.setColorAt(k, col.multiplyScalar(0.32));
        }
      }
    }
    s.add(this.barMesh);

    const sun = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      sun.add(
        new THREE.Mesh(
          new THREE.TorusGeometry(42 + i * 7, 0.5, 8, 120),
          new THREE.MeshBasicMaterial({ color: i % 2 ? CYAN : MAGENTA, fog: false })
        )
      );
    }
    sun.position.set(0, 6, -230);
    this.sun = sun;
    s.add(sun);

    const n = 400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([(Math.random() - 0.5) * 70, (Math.random() - 0.5) * 30, -Math.random() * 190 + 10], i * 3);
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x9fdcff, size: 0.25 }));
    s.add(this.dust);

    this.burstGeo = new THREE.TorusGeometry(1, 0.08, 6, 64);
  }

  #buildPlayer() {
    this.core = new Ribbon(WAVE_POINTS, 0.32, new THREE.MeshBasicMaterial({ vertexColors: true }), { colors: true });
    this.glow = new Ribbon(
      WAVE_POINTS,
      1.1,
      new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.glow.mesh.position.z = -0.01;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.scene.add(this.glow.mesh, this.core.mesh, this.head);
  }

  // Picks the next gap: always a change, and bigger jumps as the run goes on.
  #nextTarget() {
    const prev = this.lastTarget;
    const maxSteps = this.elapsed < 12 ? 1 : this.elapsed < 30 ? 2 : this.elapsed < 50 ? 3 : 4;
    for (let tries = 0; tries < 60; tries++) {
      const f = randInt(F_MIN, F_MAX);
      const a = randInt(A_MIN, A_MAX);
      const d = Math.abs(f - prev.f) + Math.abs(a - prev.a);
      if (d >= 1 && d <= maxSteps) return { f, a };
    }
    return { f: prev.f < F_MAX ? prev.f + 1 : prev.f - 1, a: prev.a };
  }

  #spawnWall(z) {
    const { f, a } = this.#nextTarget();
    this.lastTarget = { f, a };
    const group = new THREE.Group();
    const panelMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(MAGENTA).multiplyScalar(0.38),
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const { top, bottom, pts } = slotGeometries(f, a, GAP);
    group.add(new THREE.Mesh(top, panelMat), new THREE.Mesh(bottom, panelMat));

    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xff8be8, transparent: true });
    for (const dy of [GAP, -GAP]) {
      const edge = new Ribbon(pts.length, 0.14, edgeMat);
      edge.set(pts, dy);
      edge.mesh.position.z = 0.02;
      group.add(edge.mesh);
    }
    // Later in a run some walls arrive inside a noise cloud: the label is
    // scrambled, so you have to read the gap's shape instead.
    const noisy = !this.demo && this.elapsed > NOISE_FROM && Math.random() < NOISE_CHANCE;
    const label = makeLabel(noisy ? '? Hz · ? V' : `${f} Hz · ${a} V`, noisy ? '#ffffff' : '#ff8be8');
    label.position.set(0, H / 2 + 0.9, 0);
    group.add(label);
    let cloud = null;
    if (noisy) {
      const n = 260;
      const pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        pos[k * 3] = (Math.random() - 0.5) * W * 1.1;
        pos[k * 3 + 1] = (Math.random() - 0.5) * H * 0.9;
        pos[k * 3 + 2] = (Math.random() - 0.5) * 6;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      cloud = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, transparent: true, opacity: 0.6, depthWrite: false }));
      group.add(cloud);
    }

    group.position.z = z;
    this.scene.add(group);
    this.walls.push({ group, f, a, z, judged: false, result: null, fade: 0, panelMat, edgeMat, label, noisy, cloud });
  }

  // ---------------------------------------------------------------- HUD

  #buildHud() {
    this.hudRoot.innerHTML = `
      <div class="ghud waverider">
        <div class="g-tl"><div class="label">SCORE</div><div class="value big" data-score>0</div></div>
        <div class="g-tc">
          <div class="label">SIGNAL STRENGTH</div>
          <div class="bar signal"><div data-signal></div></div>
        </div>
        <div class="g-tr">
          <div class="label">COMBO</div><div class="value big" data-combo>×0</div>
          <div class="label">SPEED <span data-speed>1.0×</span></div>
        </div>
        <div class="scope-box">
          <canvas class="scope" width="440" height="150" data-scope></canvas>
          <div class="scope-read">
            <span class="you">YOU <b data-you></b></span>
            <span class="next">NEXT GAP <b data-next></b></span>
          </div>
          <div class="scope-keys"><b>◀ ▶</b> FREQUENCY &nbsp;·&nbsp; <b>▲ ▼</b> AMPLITUDE</div>
        </div>
        <div class="hint top" data-hint>SHAPE YOUR WAVE TO FIT THE GAP: <b>◀ ▶</b> MORE OR FEWER WAVES · <b>▲ ▼</b> TALLER OR FLATTER</div>
        <div class="popup" data-popup><div class="t"></div><div class="s"></div></div>
        <div class="static" data-static></div>
      </div>`;
    const q = (k) => this.hudRoot.querySelector(`[data-${k}]`);
    this.ui = {
      root: this.hudRoot.firstElementChild,
      score: q('score'), signal: q('signal'), combo: q('combo'), speed: q('speed'), scope: q('scope'),
      you: q('you'), next: q('next'), hint: q('hint'), popup: q('popup'), static: q('static'),
    };
  }

  #popup(title, sub, cls) {
    if (!this.ui) return;
    const el = this.ui.popup;
    el.querySelector('.t').textContent = title;
    el.querySelector('.s').textContent = sub;
    el.className = 'popup';
    void el.offsetWidth; // restart the pop animation
    el.className = `popup show ${cls}`;
    this.popupT = 0.75;
  }

  // Swap the top hint line for a short message.
  #hint(html, secs) {
    if (!this.ui) return;
    this.ui.hint.innerHTML = html;
    this.hintT = secs;
  }

  // Popup and static timers run on game time so they pause with the game.
  #tickOverlays(dt) {
    if (!this.ui) return;
    if (this.popupT > 0 && (this.popupT -= dt) <= 0) this.ui.popup.classList.remove('show');
    if (this.staticT > 0 && (this.staticT -= dt) <= 0) this.ui.static.classList.remove('on');
    if (this.hintT > 0) this.hintT -= dt;
  }

  // ---------------------------------------------------------------- loop

  update(dt, input, live) {
    this.time += dt;
    const { dx, dy } = this.demo ? this.#autopilot(dt) : live ? this.#readSteps(dt, input) : { dx: 0, dy: 0 };
    this.#applySteps(dx, dy);

    if (live) {
      // The title-screen demo cruises at an early-game pace forever instead of
      // ramping up the way a real run does.
      this.elapsed = this.demo ? Math.min(this.elapsed + dt, DEMO_PACE) : this.elapsed + dt;
      this.speed = Math.min(START_SPEED + this.elapsed * SPEED_RAMP, MAX_SPEED);
      this.topSpeed = Math.max(this.topSpeed, this.speed);
      // The soundtrack builds up and speeds up with the run.
      // The soundtrack builds with the run and with your combo.
      if (!this.demo) {
        music.set({ intensity: 0.45 + this.elapsed / 100 + Math.min(this.combo, 10) * 0.025, bpm: 108 + Math.min(this.elapsed, 90) * 0.22 });
        const level = Math.floor(this.elapsed / LEVEL_EVERY) + 1;
        if (level > (this.level ?? 1)) {
          this.level = level;
          this.#hint(`LEVEL ${level} · SPEED UP`, 1.6);
          sfx.checkpoint();
        }
        const next = this.walls.find((w) => !w.judged);
        if (next?.noisy && !this.noiseSeen) {
          this.noiseSeen = true;
          this.#hint('NOISE! THE LABEL IS SCRAMBLED, SO MATCH THE <b>SHAPE</b> OF THE GAP', 3.5);
        }
        // Nearly off the air: a heartbeat that quickens as signal drops.
        if (this.signal < 35 && (this.beatT -= dt) <= 0) {
          waveSfx.heartbeat();
          this.beatT = 0.45 + this.signal / 60;
        }
      }
    } else {
      this.speed = 0;
    }
    const dz = this.speed * dt;
    this.score += dz * 0.5;

    this.#moveWorld(dz);
    this.#updateWalls(dt, dz);
    this.#updateBursts(dt);
    this.#updatePlayer(dt);
    this.#updateTone(dt, live);
    this.#placeCamera(dt);
    if (this.ui) this.#updateHud();
    this.#tickOverlays(dt);
    this.view.render();

    if (this.demo) this.signal = START_SIGNAL;
    if (live && !this.demo && this.signal <= 0) {
      this.signal = 0;
      this.tone?.stop();
      this.tone = null;
      return this.#result();
    }
    return null;
  }

  // Held directions step once, then auto-repeat.
  #readSteps(dt, input) {
    const xDir = input.held('right') || input.steer > 0.6 ? 1 : input.held('left') || input.steer < -0.6 ? -1 : 0;
    const yDir = input.held('up') || input.stickY > 0.6 ? 1 : input.held('down') || input.stickY < -0.6 ? -1 : 0;
    return { dx: this.#repeat(this.rep.x, xDir, dt), dy: this.#repeat(this.rep.y, yDir, dt) };
  }

  #repeat(r, dir, dt) {
    if (dir !== r.dir) {
      r.dir = dir;
      r.t = REPEAT_DELAY;
      return dir;
    }
    if (!dir) return 0;
    r.t -= dt;
    if (r.t > 0) return 0;
    r.t = REPEAT_EVERY;
    return dir;
  }

  #applySteps(dx, dy) {
    if (dx) {
      const f = clamp(this.f + dx, F_MIN, F_MAX);
      if (f !== this.f) {
        this.f = f;
        this.toneBoost = 1;
        if (!this.demo) beep(NOTE[f] * 2, 0.05, { type: 'triangle', vol: 0.04 });
      }
    }
    if (dy) {
      const a = clamp(this.a + dy, A_MIN, A_MAX);
      if (a !== this.a) {
        this.a = a;
        this.toneBoost = 1;
        if (!this.demo) beep(600 + a * 120, 0.04, { type: 'sine', vol: 0.03 });
      }
    }
  }

  // Demo: steps toward the next gap one notch at a time, like a person would.
  #autopilot(dt) {
    this.demoTimer -= dt;
    const w = this.walls.find((w) => !w.judged);
    if (!w || this.demoTimer > 0) return { dx: 0, dy: 0 };
    this.demoTimer = 0.16;
    if (w.f !== this.f) return { dx: Math.sign(w.f - this.f), dy: 0 };
    if (w.a !== this.a) return { dx: 0, dy: Math.sign(w.a - this.a) };
    return { dx: 0, dy: 0 };
  }

  #moveWorld(dz) {
    const loop = FRAME_COUNT * FRAME_EVERY;
    for (const fr of this.frames) {
      fr.position.z += dz;
      if (fr.position.z > 12) fr.position.z -= loop;
      fr.visible = fr.position.z < -1; // a frame wrapped around the camera just looks like a border
    }
    this.floorMat.uniforms.uScroll.value -= dz;

    const m = new THREE.Matrix4();
    this.bars.forEach((b, i) => {
      b.z += dz;
      if (b.z > 12) b.z -= 16 * 12;
      const h = 0.6 + Math.abs(Math.sin(this.time * 4 + b.phase + b.z * 0.2)) * (1.2 + this.av * 1.3);
      m.makeScale(1.4, h, 1.4).setPosition(b.x, -H / 2 - 0.8 + h / 2, b.z);
      this.barMesh.setMatrixAt(i, m);
    });
    this.barMesh.instanceMatrix.needsUpdate = true;

    const pos = this.dust.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let z = pos.getZ(i) + dz * 1.4;
      if (z > 12) z -= 190;
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
    this.sun.rotation.z = this.time * 0.05;
  }

  #updateWalls(dt, dz) {
    for (const w of this.walls) {
      w.z += dz;
      w.group.position.z = w.z;
      if (!w.judged && w.z >= 0) this.#judge(w);
      if (w.cloud) {
        // Static: the motes jump to new spots every frame.
        const p = w.cloud.geometry.attributes.position;
        for (let k = 0; k < p.count; k += 3) p.setXYZ(k, (Math.random() - 0.5) * W * 1.1, (Math.random() - 0.5) * H * 0.9, (Math.random() - 0.5) * 6);
        p.needsUpdate = true;
        w.cloud.material.opacity = w.result ? 0 : 0.4 + Math.random() * 0.4;
      }
      // Passed walls get out of the way fast so they never wash the screen.
      if (w.result) {
        w.fade += dt;
        const k = Math.min(w.fade / (w.result === 'perfect' ? 0.12 : 0.25), 1);
        w.panelMat.opacity = 0.8 * (1 - k);
        w.edgeMat.opacity = 1 - k;
        w.label.material.opacity = 1 - k;
      }
    }

    // Keep walls coming at the current spacing.
    const spacing = Math.max(MIN_SPACING, START_SPACING - this.elapsed * 0.4);
    const last = this.walls[this.walls.length - 1];
    if (!last || last.z - spacing >= SPAWN_Z) this.#spawnWall(last ? last.z - spacing : SPAWN_Z);

    for (const w of this.walls.filter((w) => w.z > 14)) {
      this.scene.remove(w.group);
      w.group.traverse((o) => {
        o.geometry?.dispose();
        o.material?.map?.dispose();
      });
      w.panelMat.dispose();
      w.edgeMat.dispose();
      w.label.material.dispose();
    }
    this.walls = this.walls.filter((w) => w.z <= 14);
  }

  #judge(w) {
    w.judged = true;
    if (!this.demo) waveSfx.whoosh(this.speed / START_SPEED);
    const df = this.f - w.f;
    const da = this.a - w.a;
    const err = Math.abs(df) + Math.abs(da);
    if (err === 0) {
      w.result = 'perfect';
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.perfects++;
      const mult = Math.min(this.combo, 10);
      const pts = 100 * mult * (w.noisy ? 2 : 1);
      this.score += pts;
      this.signal = Math.min(START_SIGNAL, this.signal + PERFECT_HEAL);
      if (w.noisy) this.decodes = (this.decodes ?? 0) + 1;
      this.#popup(w.noisy ? 'CLEAN DECODE!' : 'PERFECT', `+${pts}${mult > 1 ? `  ×${mult} COMBO` : ''}`, 'good');
      this.#burst(CYAN);
      if (!this.demo) {
        // Two notes from the chord the soundtrack is on, climbing with the combo.
        const tones = music.chord;
        const note = (k) => 440 * 2 ** ((tones[k % 3] + 12 * (1 + Math.floor(k / 3)) - 69) / 12);
        const k = Math.min(this.combo - 1, 5);
        beep(note(k), 0.1, { type: 'triangle', vol: 0.07 });
        beep(note(k + 1), 0.16, { type: 'triangle', vol: 0.06, when: 0.07 });
        if (this.combo % 5 === 0) waveSfx.sparkle(tones);
      }
      return;
    }

    // Say exactly what was off, so a miss teaches something.
    const off = [];
    if (df) off.push(`FREQUENCY ${df > 0 ? 'TOO HIGH' : 'TOO LOW'}`);
    if (da) off.push(`AMPLITUDE ${da > 0 ? 'TOO HIGH' : 'TOO LOW'}`);
    this.combo = 0;
    if (err === 1) {
      w.result = 'close';
      this.closes++;
      this.signal -= CLOSE_COST;
      this.score += 25;
      w.panelMat.color.setHex(AMBER).multiplyScalar(0.5);
      w.edgeMat.color.setHex(AMBER);
      this.shake = 0.25;
      this.hitJitter = 0.4;
      this.#popup('CLOSE', off.join(' · '), 'warn');
      this.#burst(AMBER);
      if (!this.demo) beep(330, 0.18, { type: 'triangle', vol: 0.08, slide: -60 });
    } else {
      w.result = 'blocked';
      this.blocks++;
      this.signal -= BLOCK_COST;
      w.panelMat.color.setHex(RED).multiplyScalar(0.6);
      w.edgeMat.color.setHex(RED);
      this.shake = 0.6;
      this.hitJitter = 1;
      this.#popup('BLOCKED', `NEEDED ${w.f} Hz · ${w.a} V`, 'bad');
      if (this.ui) {
        this.ui.static.classList.add('on');
        this.staticT = 0.35;
      }
      if (!this.demo) {
        noise(0.35, 0.16);
        beep(110, 0.3, { type: 'sawtooth', vol: 0.08, slide: -50 });
      }
    }
  }

  #burst(color) {
    const mesh = new THREE.Mesh(
      this.burstGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    mesh.position.z = -0.5;
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: 0 });
  }

  #updateBursts(dt) {
    for (const b of this.bursts) {
      b.t += dt;
      const s = 2 + b.t * 30;
      b.mesh.scale.set(s, s * 0.75, 1);
      b.mesh.material.opacity = 0.6 * Math.max(0, 1 - b.t / 0.5);
    }
    for (const b of this.bursts.filter((b) => b.t > 0.5)) {
      this.scene.remove(b.mesh);
      b.mesh.material.dispose();
    }
    this.bursts = this.bursts.filter((b) => b.t <= 0.5);
  }

  #updatePlayer(dt) {
    const k = Math.min(dt * 14, 1);
    this.fv += (this.f - this.fv) * k;
    this.av += (this.a - this.av) * k;
    this.hitJitter = Math.max(0, this.hitJitter - dt * 1.8);

    const pts = sampleWave(this.fv, this.av, WAVE_POINTS);
    if (this.hitJitter > 0) for (const p of pts) p[1] += (Math.random() - 0.5) * this.hitJitter;
    this.core.set(pts);
    this.glow.set(pts);

    // Pulses run along the wave so it reads as a live signal.
    const c = new THREE.Color(CYAN);
    for (let i = 0; i < WAVE_POINTS; i++) {
      const u = i / (WAVE_POINTS - 1);
      const pulse = Math.max(0, Math.sin(u * Math.PI * 5 - this.time * 9)) ** 6;
      this.core.setColor(i, c.r * 0.6 + pulse * 0.4, c.g * 0.6 + pulse * 0.4, c.b * 0.6 + pulse * 0.4);
    }
    this.core.mesh.geometry.attributes.color.needsUpdate = true;

    const hu = (this.time * 0.7) % 1;
    const hi = Math.round(hu * (WAVE_POINTS - 1));
    this.head.position.set(pts[hi][0], pts[hi][1], 0.05);
  }

  // Your wave is audible: pitch follows frequency, loudness follows amplitude.
  #updateTone(dt, live) {
    if (!this.tone) return;
    this.toneBoost = Math.max(0, this.toneBoost - dt * 1.5);
    const vol = live ? (0.006 + 0.005 * this.a) * (0.35 + this.toneBoost) : 0;
    this.tone.set(NOTE[this.f], vol, this.a);
  }

  #placeCamera(dt) {
    this.shake = Math.max(0, this.shake - dt);
    const s = this.shake * 0.8;
    const cam = this.camera;
    cam.position.set((Math.random() - 0.5) * s, 1.1 + (Math.random() - 0.5) * s, 10);
    cam.lookAt(0, -0.4, -20);
    const fov = 65 + (this.speed - START_SPEED) * 0.25;
    cam.fov += (Math.max(65, fov) - cam.fov) * Math.min(dt * 3, 1);
    cam.updateProjectionMatrix();
  }

  #updateHud() {
    const ui = this.ui;
    ui.score.textContent = Math.floor(this.score).toLocaleString();
    ui.signal.style.width = `${clamp(this.signal / START_SIGNAL, 0, 1) * 100}%`;
    ui.signal.parentElement.classList.toggle('low', this.signal < 35);
    ui.combo.textContent = `×${this.combo}`;
    ui.speed.textContent = `${(Math.max(this.speed, START_SPEED) / START_SPEED).toFixed(1)}×`;
    ui.hint.style.opacity = this.elapsed < 7 || this.hintT > 0 ? 1 : 0;

    const next = this.walls.find((w) => !w.judged);
    ui.you.textContent = `${this.f} Hz · ${this.a} V`;
    ui.next.textContent = next ? (next.noisy ? '? Hz · ? V' : `${next.f} Hz · ${next.a} V`) : '';
    const match = next && next.f === this.f && next.a === this.a;
    ui.you.parentElement.classList.toggle('match', !!match);
    this.#drawScope(next);
  }

  // Mini oscilloscope: the next gap (magenta band) under your wave (cyan).
  #drawScope(next) {
    const cv = this.ui.scope;
    const g = cv.getContext('2d');
    const w = cv.width;
    const h = cv.height;
    const sy = (h / 2 - 8) / (A_MAX * AMP_UNIT + GAP);
    g.fillStyle = 'rgba(4, 2, 14, 0.92)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(120, 140, 200, 0.18)';
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      g.beginPath();
      g.moveTo((w * i) / 8, 0);
      g.lineTo((w * i) / 8, h);
      g.stroke();
    }
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(0, (h * i) / 4);
      g.lineTo(w, (h * i) / 4);
      g.stroke();
    }
    const trace = (pts, style, width, dash = []) => {
      g.strokeStyle = style;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      pts.forEach(([x, y], i) => {
        const px = ((x + W / 2) / W) * w;
        const py = h / 2 - y * sy;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.stroke();
      g.setLineDash([]);
    };
    if (next) {
      const tp = sampleWave(next.f, next.a, 90);
      if (next.noisy) for (const p of tp) p[1] += (Math.random() - 0.5) * 0.9;
      trace(tp, 'rgba(255, 63, 210, 0.35)', GAP * 2 * sy);
      trace(tp, '#ff8be8', 2, [6, 5]);
    }
    trace(sampleWave(this.fv, this.av, 90), '#3df5ff', 3);
  }

  #result() {
    return {
      score: Math.floor(this.score),
      stats: [
        ['Perfect matches', this.perfects],
        ['Best combo', `×${this.bestCombo}`],
        ['Noisy signals decoded', this.decodes ?? 0],
        ['Close calls', this.closes],
        ['Blocked', this.blocks],
        ['Top speed', `${(this.topSpeed / START_SPEED).toFixed(1)}×`],
      ],
      fact:
        'Every wireless signal is a wave like yours. Frequency (waves per second, in Hz) picks the channel: FM radio wiggles about 100 million times a second and Wi-Fi 2.4 billion. ' +
        'Amplitude is how strong the wave is. AM radio carries sound by changing amplitude and FM by changing frequency, which is exactly what you just did.',
    };
  }

  dispose() {
    this.tone?.stop();
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
