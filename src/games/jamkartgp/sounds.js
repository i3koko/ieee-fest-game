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

// Each kart gets its own engine character. `gears` is how many times the
// revs climb and drop on the way to top speed (0 = electric, no gears).
const ENGINES = {
  fiber: { idle: 70, range: 260, gears: 3, wave: 'sawtooth', cutoff: 1800, whine: 4, burble: 0, vol: 0.05 },
  '5g': { idle: 95, range: 320, gears: 5, wave: 'square', cutoff: 1400, whine: 0, burble: 0, vol: 0.035 },
  satellite: { idle: 38, range: 110, gears: 4, wave: 'sawtooth', cutoff: 520, whine: 0, burble: 0.5, vol: 0.075 },
  radio: { idle: 48, range: 150, gears: 4, wave: 'sawtooth', cutoff: 760, whine: 0, burble: 1, vol: 0.065 },
  laser: { idle: 180, range: 900, gears: 0, wave: 'triangle', cutoff: 3200, whine: 2, burble: 0, vol: 0.045 },
};

export function createEngine(modelId) {
  if (!ensure()) return null;
  const e = ENGINES[modelId] ?? ENGINES.fiber;
  const main = osc(e.wave, e.idle);
  const sub = osc('sine', e.idle / 2);
  const lp = filt('lowpass', e.cutoff, 3);
  const amp = ac.createGain();
  amp.gain.value = 0;
  // V8-style burble: a tremolo tied to the revs.
  const trem = ac.createGain();
  trem.gain.value = 1;
  const lfo = osc('sine', 12);
  const lfoDepth = ac.createGain();
  lfoDepth.gain.value = e.burble * 0.5;
  lfo.connect(lfoDepth).connect(trem.gain);
  main.connect(lp);
  sub.connect(lp);
  lp.connect(trem).connect(amp).connect(out);

  // Turbine / electric whine on top.
  let whine = null;
  if (e.whine) {
    whine = osc('sine', e.idle * e.whine);
    const wg = ac.createGain();
    wg.gain.value = 0.25;
    whine.connect(wg).connect(amp);
  }

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

  const nodes = [main, sub, lfo, hiss, whine].filter(Boolean);
  return {
    // speed in m/s, top = kart's top speed, slip = sideways slide (m/s).
    update({ speed, top, slip, drifting, boost, air, jammed, on }) {
      const t = now();
      const r = Math.min(Math.abs(speed) / top, 1.3);
      let rev;
      if (e.gears) {
        // Climb through each gear, then drop back when it shifts up.
        const g = Math.min(Math.floor(r * e.gears), e.gears - 1);
        const inGear = r * e.gears - g;
        rev = 0.25 + inGear * 0.6 + g * 0.06;
      } else rev = r;
      const f = e.idle + e.range * rev + (boost ? e.range * 0.25 : 0) + (air ? e.range * 0.3 : 0);
      main.frequency.setTargetAtTime(f, t, 0.04);
      sub.frequency.setTargetAtTime(f / 2, t, 0.04);
      if (whine) whine.frequency.setTargetAtTime(f * e.whine, t, 0.05);
      lfo.frequency.setTargetAtTime(6 + rev * 20, t, 0.05);
      amp.gain.setTargetAtTime(on ? e.vol * (0.55 + r * 0.6) : 0, t, 0.08);
      const squeal = on && !air ? Math.min(Math.max(Math.abs(slip) - 3, 0) / 10, 1) * (drifting ? 1 : 0.6) : 0;
      skid.gain.setTargetAtTime(squeal * 0.05, t, 0.05);
      skidF.frequency.setTargetAtTime(1500 + Math.abs(slip) * 40, t, 0.05);
      wind.gain.setTargetAtTime(on ? Math.max(r - 0.4, 0) * 0.05 + (air ? 0.03 : 0) : 0, t, 0.1);
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
