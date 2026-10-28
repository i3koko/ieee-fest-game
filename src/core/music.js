// Procedural soundtracks, played live through WebAudio (no files). Each game
// picks a song; layers come in as the game raises `intensity`.
//
// 'synthwave' (Wave Rider): Am - F - C - G, one bar each.
//   0+    pad chords and a held bass note
//   0.15  pulsing eighth-note bass
//   0.2   off-beat hi-hats
//   0.3   kick (the pad and bass duck under it)
//   0.45  snare on 2 and 4
//   0.5   sixteenth-note arpeggio with echo
//   0.65  sixteenth hi-hats
//   0.75  lead melody
// A minor pentatonic matches Wave Rider's wave notes (A C D E G).
//
// 'drive' (Jam Kart): a breakbeat racer in E minor, Em - C - D - B, with a
// wobbling reese bass, offbeat chord stabs, a pluck arpeggio and a lead hook.
import { audioOut } from './audio.js';

const CHORDS = [
  { root: 45, tones: [57, 60, 64] }, // Am
  { root: 41, tones: [57, 60, 65] }, // F
  { root: 48, tones: [55, 60, 64] }, // C
  { root: 43, tones: [55, 59, 62] }, // G
];

// [bar, step, midi, length in sixteenths]
const MELODY = [
  [0, 0, 76, 4], [0, 4, 74, 2], [0, 6, 72, 2], [0, 8, 69, 6],
  [1, 0, 72, 4], [1, 4, 74, 2], [1, 6, 76, 2], [1, 8, 69, 4], [1, 12, 72, 4],
  [2, 0, 79, 4], [2, 4, 76, 4], [2, 8, 74, 2], [2, 10, 72, 6],
  [3, 0, 74, 6], [3, 6, 71, 2], [3, 8, 74, 4], [3, 12, 79, 4],
];

const DRIVE_CHORDS = [
  { root: 40, tones: [64, 67, 71] }, // Em
  { root: 36, tones: [64, 67, 72] }, // C
  { root: 38, tones: [62, 66, 69] }, // D
  { root: 35, tones: [63, 66, 71] }, // B
];
const DRIVE_HOOK = [
  [0, 0, 76, 3], [0, 3, 79, 3], [0, 6, 78, 2], [0, 8, 76, 2], [0, 10, 74, 2], [0, 12, 71, 4],
  [1, 0, 72, 3], [1, 3, 76, 3], [1, 6, 79, 2], [1, 8, 84, 4], [1, 12, 83, 4],
  [2, 0, 81, 3], [2, 3, 78, 3], [2, 6, 74, 2], [2, 8, 76, 2], [2, 10, 78, 2], [2, 12, 81, 4],
  [3, 0, 83, 6], [3, 6, 78, 2], [3, 8, 75, 4], [3, 12, 71, 4],
];
// Bass rhythm for the drive song: [step, semitones above the root].
const REESE = [[0, 0], [3, 0], [6, 12], [8, 0], [11, 7], [14, 12]];

const VOLUME = 0.55;
const LOOKAHEAD = 0.12; // seconds of notes scheduled ahead of the clock
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

let ac, out, duck, drums, echo, echoDelay, verb, noiseBuf;
let timer = null;
let stopTimer = null;
let nextTime = 0;
let step = 0;
let bpm = 104;
let targetBpm = 104;
let intensity = 0.1;
let chord = CHORDS[0];
let song = 'synthwave';
// The drive song runs faster for the same requested tempo.
const TEMPO = { synthwave: 1, drive: 1.28 };

function build() {
  const { ctx, master } = audioOut();
  ac = ctx;
  out = ac.createGain();
  out.gain.value = 0;
  out.connect(master);

  // Pad, bass and arp run through `duck` so they pump under the kick.
  duck = ac.createGain();
  duck.connect(out);
  drums = ac.createGain();
  drums.connect(out);

  // Echo: a filtered feedback delay, three sixteenths long.
  echo = ac.createGain();
  const delay = (echoDelay = ac.createDelay(1));
  const fb = ac.createGain();
  const tone = ac.createBiquadFilter();
  fb.gain.value = 0.38;
  tone.frequency.value = 2400;
  echo.connect(delay).connect(tone).connect(fb).connect(delay);
  const wet = ac.createGain();
  wet.gain.value = 0.5;
  tone.connect(wet).connect(duck);

  // Reverb from a decaying noise impulse.
  verb = ac.createGain();
  const conv = ac.createConvolver();
  const len = ac.sampleRate * 2.4;
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  conv.buffer = ir;
  const verbOut = ac.createGain();
  verbOut.gain.value = 0.35;
  verb.connect(conv).connect(verbOut).connect(out);

  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const n = noiseBuf.getChannelData(0);
  for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
}

// Gain envelope: quick attack, then an exponential fade to silence.
function env(t, peak, attack, dur) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}

function osc(type, freq, t, dur, detune = 0) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function noiseSrc(t, dur) {
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
  return s;
}

function filter(type, freq, q = 0.7) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function kick(t) {
  const o = osc('sine', 150, t, 0.35);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  o.connect(env(t, 0.9, 0.002, 0.32)).connect(drums);
  duck.gain.setValueAtTime(0.35, t);
  duck.gain.linearRampToValueAtTime(1, t + 0.2);
}

function snare(t) {
  const g = env(t, 0.32, 0.002, 0.2);
  noiseSrc(t, 0.2).connect(filter('bandpass', 1900, 0.8)).connect(g);
  g.connect(drums);
  g.connect(verb);
  osc('triangle', 190, t, 0.1).connect(env(t, 0.18, 0.002, 0.09)).connect(drums);
}

function hat(t, vol, open) {
  noiseSrc(t, 0.25).connect(filter('highpass', 7500)).connect(env(t, vol, 0.002, open ? 0.2 : 0.045)).connect(drums);
}

function bass(t, midi, dur) {
  const f = filter('lowpass', 900, 4);
  f.frequency.setValueAtTime(260 + intensity * 900, t);
  f.frequency.exponentialRampToValueAtTime(140, t + dur);
  const g = env(t, 0.2, 0.005, dur);
  osc('sawtooth', midiHz(midi), t, dur).connect(f);
  osc('square', midiHz(midi - 12), t, dur).connect(f);
  f.connect(g).connect(duck);
}

function pad(t, tones, dur) {
  const f = filter('lowpass', 700 + intensity * 1500);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.045, t + dur * 0.25);
  g.gain.setValueAtTime(0.045, t + dur * 0.8);
  g.gain.linearRampToValueAtTime(0.0001, t + dur * 1.05);
  for (const m of tones) for (const d of [-8, 8]) osc('sawtooth', midiHz(m), t, dur * 1.05, d).connect(f);
  f.connect(g);
  g.connect(duck);
  g.connect(verb);
}

function arp(t, midi) {
  const g = env(t, 0.05, 0.003, 0.16);
  osc('square', midiHz(midi), t, 0.16).connect(filter('lowpass', 2600)).connect(g);
  g.connect(duck);
  g.connect(echo);
}

function lead(t, midi, dur) {
  const f = filter('lowpass', 2400);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.055, t + 0.02);
  g.gain.setTargetAtTime(0.035, t + 0.05, 0.1);
  g.gain.setTargetAtTime(0.0001, t + dur * 0.92, 0.05);
  const vib = osc('sine', 5.5, t, dur);
  const depth = ac.createGain();
  depth.gain.value = 12;
  vib.connect(depth);
  for (const [type, d] of [['sawtooth', -6], ['square', 6]]) {
    const o = osc(type, midiHz(midi), t, dur + 0.3, d);
    depth.connect(o.detune);
    o.connect(f);
  }
  f.connect(g);
  g.connect(duck);
  g.connect(echo);
  g.connect(verb);
}

// Detuned saw pair with a slow filter wobble: the drum'n'bass "reese".
function reese(t, midi, dur) {
  const f = filter('lowpass', 300, 6);
  const wob = osc('sine', 2.2 + intensity * 2, t, dur);
  const depth = ac.createGain();
  depth.gain.value = 180 + intensity * 400;
  wob.connect(depth).connect(f.frequency);
  const g = env(t, 0.16, 0.01, dur);
  for (const d of [-14, 14]) osc('sawtooth', midiHz(midi), t, dur, d).connect(f);
  osc('sine', midiHz(midi - 12), t, dur).connect(g);
  f.connect(g).connect(duck);
}

// Short filtered chord stab on the off-beat.
function stab(t, tones) {
  const f = filter('lowpass', 1800 + intensity * 1600, 2);
  f.frequency.setValueAtTime(3400, t);
  f.frequency.exponentialRampToValueAtTime(700, t + 0.18);
  const g = env(t, 0.06, 0.003, 0.22);
  for (const m of tones) osc('square', midiHz(m), t, 0.22, 5).connect(f);
  f.connect(g);
  g.connect(duck);
  g.connect(verb);
}

function pluck(t, midi) {
  const g = env(t, 0.06, 0.002, 0.12);
  osc('triangle', midiHz(midi), t, 0.12).connect(g);
  osc('square', midiHz(midi + 12), t, 0.05).connect(env(t, 0.015, 0.001, 0.05)).connect(duck);
  g.connect(duck);
  g.connect(echo);
}

function drive(s, t) {
  const s16 = 60 / bpm / 4;
  const bar = Math.floor(s / 16) % 4;
  const i = s % 16;
  const c = DRIVE_CHORDS[bar];
  const lvl = intensity;
  if (i === 0) {
    chord = c;
    if (lvl < 0.35) pad(t, c.tones.map((m) => m - 12), 16 * s16);
  }
  if (lvl < 0.15) {
    if (i === 0) reese(t, c.root + 12, 14 * s16);
  } else {
    for (const [at, up] of REESE) if (at === i) reese(t, c.root + 12 + up, s16 * 2.6);
  }
  // Breakbeat: kick on 1 and the "and" of 3, snare on 2 and 4, ghost notes.
  if (lvl >= 0.25 && (i === 0 || i === 10)) kick(t);
  if (lvl >= 0.55 && i === 6) kick(t);
  if (lvl >= 0.35 && (i === 4 || i === 12)) snare(t);
  if (lvl >= 0.6 && (i === 7 || i === 15) && Math.random() < 0.7) hatGhost(t);
  if (lvl >= 0.5) hat(t, i % 2 ? 0.08 : 0.045, i === 14);
  else if (lvl >= 0.2 && i % 2 === 0) hat(t, 0.06, false);
  if (lvl >= 0.3 && (i === 2 || i === 10 || (lvl > 0.7 && i === 13))) stab(t, c.tones);
  if (lvl >= 0.6 && i % 2 === 1) pluck(t, c.tones[(i >> 1) % 3] + 12);
  if (lvl >= 0.8) for (const [b, at, m, len] of DRIVE_HOOK) if (b === bar && at === i) lead(t, m, len * s16);
}

// A quiet snare ghost note.
function hatGhost(t) {
  const g = env(t, 0.08, 0.002, 0.08);
  noiseSrc(t, 0.1).connect(filter('bandpass', 2400, 1)).connect(g);
  g.connect(drums);
}

function synthwave(s, t) {
  const s16 = 60 / bpm / 4;
  const bar = Math.floor(s / 16) % 4;
  const i = s % 16;
  const c = CHORDS[bar];
  const lvl = intensity;
  if (i === 0) {
    chord = c;
    pad(t, c.tones, 16 * s16);
    if (lvl < 0.15) bass(t, c.root, 14 * s16);
  }
  if (lvl >= 0.15 && i % 2 === 0) bass(t, c.root + (i % 4 === 2 ? 12 : 0), s16 * 1.6);
  if (lvl >= 0.3 && i % 4 === 0) kick(t);
  if (lvl >= 0.45 && (i === 4 || i === 12)) snare(t);
  if (lvl >= 0.65) hat(t, i % 2 ? 0.09 : 0.04, i === 14);
  else if (lvl >= 0.2 && i % 4 === 2) hat(t, 0.08, false);
  if (lvl >= 0.5) {
    const up = [c.tones[0], c.tones[1], c.tones[2], c.tones[0] + 12];
    arp(t, up[i % 4] + 12);
  }
  if (lvl >= 0.75) {
    for (const [b, at, m, len] of MELODY) if (b === bar && at === i) lead(t, m, len * s16);
  }
}

function pump() {
  if (nextTime < ac.currentTime) nextTime = ac.currentTime + 0.05; // tab was asleep
  while (nextTime < ac.currentTime + LOOKAHEAD) {
    bpm += (targetBpm - bpm) * 0.05;
    echoDelay.delayTime.setValueAtTime((60 / bpm / 4) * 3, nextTime);
    (song === 'drive' ? drive : synthwave)(step, nextTime);
    nextTime += 60 / bpm / 4;
    step++;
  }
}

export const music = {
  play(name = 'synthwave') {
    if (!ac) build();
    if (name !== song) {
      song = name;
      step = 0;
    }
    clearTimeout(stopTimer);
    const t = ac.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setTargetAtTime(VOLUME, t, 0.3);
    if (!timer) {
      step = 0;
      nextTime = t + 0.05;
      timer = setInterval(pump, 25);
    }
  },

  stop(fade = 1) {
    if (!ac || !timer) return;
    out.gain.setTargetAtTime(0, ac.currentTime, fade / 4);
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      clearInterval(timer);
      timer = null;
    }, fade * 1000);
  },

  // Quieter while the game is paused.
  duck(on) {
    if (!ac || !timer) return;
    out.gain.setTargetAtTime(on ? VOLUME * 0.35 : VOLUME, ac.currentTime, 0.2);
  },

  set({ intensity: i, bpm: b } = {}) {
    if (i !== undefined) intensity = Math.max(0, Math.min(1, i));
    if (b !== undefined) targetBpm = b * TEMPO[song];
  },

  // Chord tones (MIDI) of the bar now playing, so effects can harmonise.
  get chord() {
    return chord.tones;
  },
};
