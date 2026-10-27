// Tiny synth for chiptune-style sound effects. No audio files needed.
let ctx;
let master;
let muted = false;

// The title screen's self-playing demo runs silently.
export function setMuted(on) {
  muted = on;
}

function ensure() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// The music module builds its own voices on the same context and output.
export function audioOut() {
  ensure();
  return { ctx, master };
}

export function beep(freq, dur = 0.1, { when = 0, type = 'square', vol = 0.08, slide = 0 } = {}) {
  if (muted) return;
  const ac = ensure();
  const t0 = ac.currentTime + when;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function noise(dur = 0.2, vol = 0.1) {
  if (muted) return;
  const ac = ensure();
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = vol;
  src.buffer = buf;
  src.connect(gain).connect(master);
  src.start();
}

// A continuous tone you can retune live (Wave Rider's "hear your wave").
export function createTone(type = 'sine') {
  if (muted) return { set() {}, stop() {} };
  const ac = ensure();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  gain.gain.value = 0;
  osc.connect(gain).connect(master);
  osc.start();
  return {
    set(freq, vol) {
      const t = ac.currentTime;
      osc.frequency.setTargetAtTime(freq, t, 0.03);
      gain.gain.setTargetAtTime(vol, t, 0.05);
    },
    stop() {
      gain.gain.setTargetAtTime(0, ac.currentTime, 0.05);
      osc.stop(ac.currentTime + 0.4);
    },
  };
}

export const sfx = {
  select: () => beep(660, 0.06),
  move: () => beep(440, 0.04, { vol: 0.05 }),
  start: () => {
    beep(880, 0.08);
    beep(1320, 0.14, { when: 0.09 });
  },
  back: () => beep(330, 0.1, { slide: -150 }),
  deploy: () => {
    beep(300, 0.25, { type: 'sawtooth', slide: 600, vol: 0.06 });
    beep(1200, 0.1, { when: 0.25 });
  },
  pickup: () => beep(900, 0.12, { slide: -500 }),
  connect: () => beep(1500 + Math.random() * 400, 0.04, { vol: 0.03, type: 'sine' }),
  error: () => beep(140, 0.2, { type: 'sawtooth', vol: 0.07 }),
  hit: () => {
    noise(0.25, 0.15);
    beep(120, 0.25, { type: 'sawtooth', slide: -80 });
  },
  boost: () => beep(200, 0.35, { type: 'sawtooth', slide: 900, vol: 0.05 }),
  shield: () => beep(700, 0.2, { type: 'triangle', slide: 700 }),
  checkpoint: () => {
    beep(784, 0.08);
    beep(988, 0.08, { when: 0.08 });
    beep(1318, 0.14, { when: 0.16 });
  },
  tick: () => beep(1000, 0.03, { vol: 0.05 }),
  slowmo: () => {
    beep(900, 0.5, { type: 'sine', slide: -700, vol: 0.07 });
    beep(450, 0.6, { type: 'triangle', slide: -350, vol: 0.05 });
  },
  hint: () => beep(1250, 0.05, { type: 'sine', vol: 0.05 }),
  gameOver: () => {
    [523, 392, 330, 262].forEach((f, i) => beep(f, 0.22, { when: i * 0.18, type: 'triangle', vol: 0.1 }));
  },
};
