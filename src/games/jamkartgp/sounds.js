// Jam Kart's own sound design, built on the shared audio context: an engine
// voice per player that matches their kart, tyre squeal and wind, and the
// race's effects. Wave Rider keeps the simpler shared beeps.
import { audioOut } from '../../core/audio.js';

let ac;
let out;
let noiseBuf;

function ensure() {
  if (ac) return true;
  const o = audioOut();
  if (!o.ctx) return false;
  ac = o.ctx;
  out = ac.createGain();
  out.gain.value = 0.9;
  out.connect(o.master);
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}

const now = () => ac.currentTime;

function noiseLoop() {
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  s.start();
  return s;
}

function filt(type, freq, q = 1) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function osc(type, freq) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start();
  return o;
}

// One-shot helpers ---------------------------------------------------------

function tone(freq, dur, { type = 'sine', vol = 0.08, when = 0, slide = 0, attack = 0.005, q } = {}) {
  const t = now() + when;
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o;
  if (q) {
    const f = filt('lowpass', q, 2);
    o.connect(f);
    node = f;
  }
  node.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function burst(dur, { vol = 0.1, type = 'bandpass', freq = 1500, to = freq, q = 1, when = 0 } = {}) {
  const t = now() + when;
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  const f = filt(type, freq, q);
  f.frequency.setValueAtTime(freq, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random());
  s.stop(t + dur + 0.05);
}

// Engines ------------------------------------------------------------------

// Each kart has its own engine and gearbox. Frequencies are the engine's
// note at idle and at the rev limit; `gears` 0 means electric (no gearbox).
// `tilt` shapes the tone (higher = mellower), `cut` is the filter range
// from off-throttle to full throttle, `rumble` adds a low lumpy beat, and
// `pops` lets the quicker karts crackle a little on downshifts.
const ENGINES = {
  fiber: { idle: 58, red: 205, gears: 4, tilt: 1.25, cut: [800, 2400], sub: 0.35, rumble: 0, pops: true, vol: 0.05 },
  '5g': { idle: 72, red: 255, gears: 5, tilt: 1.35, cut: [750, 2200], sub: 0.3, rumble: 0, pops: true, vol: 0.042 },
  satellite: { idle: 30, red: 100, gears: 3, tilt: 1.0, cut: [280, 900], sub: 0.7, rumble: 0.25, pops: false, vol: 0.06 },
  radio: { idle: 40, red: 145, gears: 4, tilt: 1.1, cut: [420, 1300], sub: 0.5, rumble: 0.15, pops: false, vol: 0.06 },
  laser: { idle: 150, red: 680, gears: 0, tilt: 2.2, cut: [1800, 3600], sub: 0, rumble: 0, pops: false, vol: 0.032 },
};

// A soft engine tone: harmonics falling away smoothly, odd ones a little
// stronger. Gentler than a raw sawtooth or square wave.
const waves = {};
function engineWave(tilt) {
  if (waves[tilt]) return waves[tilt];
  const n = 24;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let h = 1; h < n; h++) imag[h] = (h % 2 ? 1.3 : 1) / h ** tilt;
  return (waves[tilt] = ac.createPeriodicWave(real, imag));
}

// The top speed of each gear: geometric steps, with a tall top gear so
// cruising at the kart's top speed sits mid-revs, not up by the limiter.
function gearTops(gears, top) {
  const r = 0.28 ** (1 / (gears - 1));
  return Array.from({ length: gears }, (_, g) => top * 1.2 * r ** (gears - 1 - g));
}

export function createEngine(modelId) {
  if (!ensure()) return null;
  const e = ENGINES[modelId] ?? ENGINES.fiber;
  const main = osc('sine', e.idle);
  main.setPeriodicWave(engineWave(e.tilt));
  // A second voice a hair out of tune thickens it.
  const thick = osc('sine', e.idle * 1.004);
  thick.setPeriodicWave(engineWave(e.tilt));
  const thickG = ac.createGain();
  thickG.gain.value = 0.45;
  const sub = osc('sine', e.idle / 2);
  const subG = ac.createGain();
  subG.gain.value = e.sub;
  const lp = filt('lowpass', e.cut[0], 0.7);
  const amp = ac.createGain();
  amp.gain.value = 0;
  // Low lumpy beat for the big lazy engines.
  const lump = ac.createGain();
  lump.gain.value = 1;
  const lfo = osc('sine', 8);
  const lfoDepth = ac.createGain();
  lfoDepth.gain.value = e.rumble;
  lfo.connect(lfoDepth).connect(lump.gain);
  main.connect(lp);
  thick.connect(thickG).connect(lp);
  sub.connect(subG).connect(lp);
  lp.connect(lump).connect(amp).connect(out);

  // Tyres and wind share a noise source through their own filters.
  const hiss = noiseLoop();
  const skidF = filt('bandpass', 1800, 6);
  const skid = ac.createGain();
  skid.gain.value = 0;
  hiss.connect(skidF).connect(skid).connect(out);
  const windF = filt('bandpass', 600, 0.6);
  const wind = ac.createGain();
  wind.gain.value = 0;
  hiss.connect(windF).connect(wind).connect(out);
  const staticF = filt('highpass', 3000, 0.7);
  const stat = ac.createGain();
  stat.gain.value = 0;
  hiss.connect(staticF).connect(stat).connect(out);

  const nodes = [main, thick, sub, lfo, hiss];
  // Gearbox state.
  let tops = null;
  let gear = 0;
  let lastT = now();
  let lastSpeed = 0;
  let load = 0;
  let cutUntil = 0; // throttle cut during an upshift
  let wasOn = false;
  let cruiseT = 0; // how long it's been holding a steady speed

  // A few soft exhaust pops (quicker karts only, and not every time).
  const pop = (chance) => {
    if (!e.pops || Math.random() > chance) return;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      burst(0.05 + Math.random() * 0.04, { vol: 0.045 + Math.random() * 0.03, type: 'lowpass', freq: 900 + Math.random() * 700, to: 200, when: 0.04 + i * (0.06 + Math.random() * 0.07) });
    }
  };

  return {
    // speed in m/s, top = kart's top speed, slip = sideways slide (m/s),
    // brake/spin: off the throttle.
    update({ speed, top, slip, drifting, boost, air, jammed, on, brake = false, spin = false }) {
      const t = now();
      const dt = Math.max(t - lastT, 1e-3);
      lastT = t;
      const v = Math.abs(speed);
      const accel = (v - lastSpeed) / dt;
      lastSpeed = v;
      // How hard the engine is working: pulling away hard is full load,
      // holding top speed is light, braking or spinning is none.
      const throttle = on && !brake && !spin;
      const want = throttle ? Math.min(Math.max(accel / 6, 0.15), 1) : 0;
      load += (want - load) * Math.min(dt * 6, 1);

      let frac; // 0 idle .. 1 rev limit
      if (e.gears) {
        tops ??= gearTops(e.gears, top);
        // Up a gear near the limit (with a throttle cut), down a gear when
        // the one below would still be comfortably under it.
        if (gear < e.gears - 1 && v / tops[gear] > 0.93) {
          gear++;
          cutUntil = t + 0.09;
        } else if (gear > 0 && v / tops[gear - 1] < 0.72) {
          gear--;
          pop(brake ? 0.35 : 0.1);
        }
        frac = Math.min(v / tops[gear], 1);
      } else frac = Math.min(v / top, 1.1);
      frac = Math.max(frac, 0.05) + (boost ? 0.05 : 0);
      // Holding a steady speed, the engine settles back: quieter and
      // darker, letting the wind take over, so flat out isn't one long
      // drone. Any acceleration, braking or shift brings it straight back.
      cruiseT = throttle && Math.abs(accel) < 1.5 && frac > 0.5 ? cruiseT + dt : 0;
      const settle = Math.min(Math.max((cruiseT - 0.6) / 1.6, 0), 1);
      const ease = settle * settle * (3 - 2 * settle);
      // A slight wander (more when settled) so the note never sits still.
      const wander = 1 + (0.006 * Math.sin(t * 1.7) + 0.004 * Math.sin(t * 4.3 + 1)) * (1 + 1.5 * ease);
      const f = (e.idle + (e.red - e.idle) * frac) * wander;
      const cut = t < cutUntil;

      // Pitch slides quickly through a shift; the tone opens up with load.
      main.frequency.setTargetAtTime(f, t, 0.035);
      thick.frequency.setTargetAtTime(f * 1.004, t, 0.035);
      sub.frequency.setTargetAtTime(f / 2, t, 0.035);
      lfo.frequency.setTargetAtTime(Math.max(4, f / 6), t, 0.05);
      const bright = cut ? 0 : load;
      const open = e.cut[0] + (e.cut[1] - e.cut[0]) * (0.25 * frac + 0.75 * bright);
      lp.frequency.setTargetAtTime(open + (e.cut[0] * 1.1 - open) * ease, t, 0.15);
      const level = on ? e.vol * (0.5 + 0.3 * frac + 0.35 * load) * (cut ? 0.45 : 1) * (1 - 0.6 * ease) : 0;
      amp.gain.setTargetAtTime(level, t, cut ? 0.015 : ease > 0 ? 0.3 : 0.06);
      // Lifting off at high revs can crackle too.
      if (wasOn && !throttle && frac > 0.6) pop(0.25);
      wasOn = throttle;

      const squeal = on && !air ? Math.min(Math.max(Math.abs(slip) - 3, 0) / 10, 1) * (drifting ? 1 : 0.6) : 0;
      skid.gain.setTargetAtTime(squeal * 0.05, t, 0.05);
      skidF.frequency.setTargetAtTime(1500 + Math.abs(slip) * 40, t, 0.05);
      const r = Math.min(v / top, 1.3);
      wind.gain.setTargetAtTime(on ? Math.max(r - 0.4, 0) * (0.05 + 0.03 * ease) + (air ? 0.03 : 0) : 0, t, 0.1);
      windF.frequency.setTargetAtTime(400 + r * 900, t, 0.1);
      stat.gain.setTargetAtTime(on && jammed ? 0.06 : 0, t, 0.03);
    },
    stop() {
      const t = now();
      amp.gain.setTargetAtTime(0, t, 0.05);
      for (const g of [skid, wind, stat]) g.gain.setTargetAtTime(0, t, 0.05);
      setTimeout(() => nodes.forEach((n) => n.stop()), 400);
    },
  };
}

// Effects ------------------------------------------------------------------

// Rain on the roof: filtered noise whose level follows the downpour.
let rainGain = null;
export function setRain(amount) {
  if (!ensure()) return;
  if (!rainGain) {
    const src = noiseLoop();
    const bp = filt('bandpass', 2600, 0.4);
    const lp = filt('lowpass', 4500, 0.5);
    rainGain = ac.createGain();
    rainGain.gain.value = 0;
    src.connect(bp).connect(lp).connect(rainGain).connect(out);
  }
  // Kept well under the engines and music: a patter, not a roar.
  rainGain.gain.setTargetAtTime(amount * amount * 0.04, now(), 0.8);
}

export const kartSfx = {
  // A thunder rumble rolling in after a lightning flash.
  thunder() {
    if (!ensure()) return;
    burst(0.12, { vol: 0.12, type: 'highpass', freq: 1500, to: 800 });
    burst(2.8, { vol: 0.32, type: 'lowpass', freq: 260, to: 60, when: 0.08 });
  },
  // Item roulette: quick rising blips.
  pickup() {
    if (!ensure()) return;
    [660, 830, 990, 1320].forEach((f, n) => tone(f, 0.06, { type: 'square', vol: 0.035, when: n * 0.05, q: 3000 }));
  },
  // Radio squelch: a noise burst sweeping down plus a falling chirp.
  jammer() {
    if (!ensure()) return;
    burst(0.5, { vol: 0.12, freq: 4000, to: 300, q: 3 });
    tone(1800, 0.45, { type: 'sawtooth', vol: 0.03, slide: -1600, q: 2500 });
  },
  jammed() {
    if (!ensure()) return;
    burst(0.35, { vol: 0.08, type: 'highpass', freq: 2500, to: 5000 });
  },
  firewall() {
    if (!ensure()) return;
    tone(90, 0.35, { type: 'sine', vol: 0.14, slide: -50 });
    burst(0.25, { vol: 0.08, freq: 600, to: 200, q: 1 });
  },
  crash() {
    if (!ensure()) return;
    burst(0.4, { vol: 0.14, type: 'lowpass', freq: 3000, to: 200 });
    tone(130, 0.3, { type: 'square', vol: 0.06, slide: -90, q: 800 });
  },
  // Compression: a filtered zip that rushes upward.
  compress() {
    if (!ensure()) return;
    burst(0.5, { vol: 0.08, freq: 300, to: 6000, q: 4 });
    tone(220, 0.45, { type: 'sawtooth', vol: 0.04, slide: 1500, q: 4000 });
  },
  // ECC: a glassy major chord.
  shield() {
    if (!ensure()) return;
    [1047, 1319, 1568, 2093].forEach((f, n) => tone(f, 0.5, { vol: 0.03, when: n * 0.03 }));
  },
  shieldBlock() {
    if (!ensure()) return;
    [2093, 1568].forEach((f, n) => tone(f, 0.3, { vol: 0.05, when: n * 0.06, type: 'triangle' }));
  },
  // Metal piston clang: inharmonic partials.
  gate() {
    if (!ensure()) return;
    [440, 1187, 2017].forEach((f) => tone(f, 0.5, { type: 'sine', vol: 0.05 }));
    burst(0.12, { vol: 0.1, freq: 2500, to: 800, q: 2 });
  },
  boostPad() {
    if (!ensure()) return;
    tone(400, 0.3, { type: 'sawtooth', vol: 0.03, slide: 900, q: 3000 });
    burst(0.3, { vol: 0.04, freq: 1000, to: 5000, q: 2 });
  },
  hop() {
    if (!ensure()) return;
    tone(260, 0.1, { type: 'triangle', vol: 0.05, slide: 160 });
  },
  turbo(big) {
    if (!ensure()) return;
    burst(big ? 0.5 : 0.3, { vol: big ? 0.1 : 0.07, freq: 500, to: 4000, q: 3 });
    tone(big ? 880 : 660, 0.18, { type: 'square', vol: 0.04, slide: 400, q: 3000 });
  },
  land(hard) {
    if (!ensure()) return;
    tone(60, 0.25, { type: 'sine', vol: hard ? 0.18 : 0.1, slide: -25 });
    burst(0.15, { vol: hard ? 0.09 : 0.05, type: 'lowpass', freq: 900, to: 200 });
  },
  scrape() {
    if (!ensure()) return;
    burst(0.12, { vol: 0.05, freq: 3000, to: 1500, q: 4 });
  },
  bump() {
    if (!ensure()) return;
    tone(110, 0.12, { type: 'square', vol: 0.05, slide: -40, q: 600 });
  },
  overtake() {
    if (!ensure()) return;
    tone(1175, 0.07, { vol: 0.04 });
    tone(1568, 0.1, { vol: 0.04, when: 0.06 });
  },
  lap(final) {
    if (!ensure()) return;
    const notes = final ? [659, 784, 988, 1319] : [784, 1175];
    notes.forEach((f, n) => tone(f, 0.18, { type: 'square', vol: 0.045, when: n * 0.09, q: 3500 }));
  },
  finish(place) {
    if (!ensure()) return;
    const notes = place === 0 ? [523, 659, 784, 1047, 1319, 1568] : place < 3 ? [523, 659, 784, 1047] : [440, 523, 659];
    notes.forEach((f, n) => tone(f, 0.3, { type: 'triangle', vol: 0.08, when: n * 0.11 }));
  },
};
