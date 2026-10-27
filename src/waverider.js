import { runArcade } from './core/arcade.js';
import { WaveRider } from './games/waverider/WaveRider.js';

runArcade({
  id: 'waverider',
  name: 'WAVE RIDER',
  Game: WaveRider,
  logoLines: ['WAVE', 'RIDER'],
  tagline: 'You are a radio signal. Shape your wave to slip through the gaps and stay on the air.',
  controlsHint: 'FREQUENCY ◀ ▶ · AMPLITUDE ▲ ▼',
  lead: 'Walls are coming with a wave-shaped gap cut in them. Make your wave match before it hits.',
  howto: [
    ['◀ ▶ FREQUENCY', 'How many waves fit across the gap. More waves = higher frequency (Hz), and you\'ll hear a higher note'],
    ['▲ ▼ AMPLITUDE', 'How tall the waves are. That\'s the signal\'s strength (volts), and it gets louder'],
    ['MATCH', 'Exact match = PERFECT and your combo grows. One step off = CLOSE. Further off = BLOCKED'],
    ['SCOPE', 'The scope at the bottom shows your wave (cyan) over the next gap (pink)'],
    ['SIGNAL', 'Misses drain your signal strength. Lose it all and you\'re off the air'],
  ],
  endTitle: 'SIGNAL LOST',
});
