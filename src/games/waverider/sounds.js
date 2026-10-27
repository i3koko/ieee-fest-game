// Wave Rider's sound: the player's wave as a playable voice, plus effects.
import { audioOut } from '../../core/audio.js';

let ac;
let out;
let noiseBuf;

function ensure() {
  if (ac) return;
  const o = audioOut();
  ac = o.ctx;
  out = ac.createGain();
  out.connect(o.master);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

// Your wave, as an instrument: a soft sine/triangle pair whose filter opens
// with amplitude (taller wave = brighter, louder), with a gentle vibrato.
export function createWaveVoice() {
  ensure();
  const t0 = ac.currentTime;
  const a = ac.createOscillator();
  const b = ac.createOscillator();
  a.type = 'sine';
  b.type = 'triangle';
  b.detune.value = 7;
  const vib = ac.createOscillator();
  vib.frequency.value = 5;
  const vibDepth = ac.createGain();
  vibDepth.gain.value = 6;
  vib.connect(vibDepth);
  vibDepth.connect(a.detune);
  vibDepth.connect(b.detune);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 4;
  const g = ac.createGain();
  g.gain.value = 0;
  a.connect(lp);
  b.connect(lp);
  lp.connect(g).connect(out);
  for (const o of [a, b, vib]) o.start(t0);
  return {
    set(freq, vol, amp = 2) {
      const t = ac.currentTime;
      a.frequency.setTargetAtTime(freq, t, 0.03);
      b.frequency.setTargetAtTime(freq * 2, t, 0.03);
      lp.frequency.setTargetAtTime(500 + amp * 600, t, 0.08);
      g.gain.setTargetAtTime(vol, t, 0.05);
    },
    stop() {
      const t = ac.currentTime;
      g.gain.setTargetAtTime(0, t, 0.05);
      for (const o of [a, b, vib]) o.stop(t + 0.4);
    },
  };
}

function burst(dur, vol, from, to, q = 1.5) {
  const t = ac.currentTime;
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
}

function tone(freq, dur, vol, when = 0, type = 'sine') {
  const t = ac.currentTime + when;
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

export const waveSfx = {
  // A wall rushing past: a noise swoosh that falls in pitch, louder at speed.
  whoosh(speed) {
    ensure();
    burst(0.35, 0.05 + Math.min(speed, 4) * 0.02, 2400 + speed * 600, 300);
  },
  // Combo milestone: a quick sparkling run up the current chord.
  sparkle(chordTones) {
    ensure();
    [0, 1, 2, 3, 4, 5].forEach((n) => {
      const m = chordTones[n % 3] + 24 + 12 * Math.floor(n / 3);
      tone(midiHz(m), 0.25, 0.035, n * 0.045, 'triangle');
    });
  },
  // Low signal: a soft double heartbeat.
  heartbeat() {
    ensure();
    tone(55, 0.18, 0.12);
    tone(50, 0.2, 0.09, 0.17);
  },
};
