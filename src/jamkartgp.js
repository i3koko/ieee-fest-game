import { runArcade } from './core/arcade.js';
import { JamKartGP } from './games/jamkartgp/JamKartGP.js';
import { loadKarts } from './games/jamkartgp/kart.js';
import { loadProps } from './games/jamkartgp/details.js';

await Promise.all([loadKarts(), loadProps()]);

runArcade({
  id: 'jamkartgp',
  name: 'JAM KART GP',
  Game: JamKartGP,
  logoLines: ['JAM KART', 'GP'],
  tagline: 'Eight karts, two laps of a forest Grand Prix circuit. Jam their signal, firewall their path, compress for speed.',
  controlsHint: 'P1 · A D STEER · SPACE ITEM  ·  P2 · ◀ ▶ STEER · ENTER ITEM',
  lead: '2 laps of a real-style Grand Prix circuit: a hairpin, a steep climb, a long straight, chicanes and fast sweepers. Your kart drives itself forward: you steer and use power-ups.',
  howto: [
    ['PICK A KART', 'FIBER is fastest, 5G turns sharpest, SATELLITE is heaviest, RADIO holds two power-ups, LASER handles grass best'],
    ['STEER', 'Player 1: A / D (or the left stick). Player 2: ◀ / ▶ (or the second controller). Hold down to brake'],
    ['BRAKE', 'Hold down to brake. Most corners are flat out; ease off for the tightest hairpins'],
    ['? BOXES', 'Drive through the glowing boxes to grab a power-up, then press SPACE / ENTER (Ⓐ) to use it'],
    ['POWER-UPS', 'JAMMER scrambles everyone near you · FIREWALL drops a wall · COMPRESSION boosts · ECC SHIELD blocks a hit'],
    ['THE TRACK', 'Wet patches are slippery, green fibre strips boost you, the clock gates open on the beat, and grass slows you down'],
  ],
  modes: ['1 PLAYER · VS CPU', '2 PLAYERS'],
  options: [
    { key: 'hazards', label: 'HAZARDS', choices: ['ALL ON', 'NO GATES', 'BOOST ONLY', 'OFF'] },
    { key: 'graphics', label: 'GRAPHICS', choices: ['AUTO', 'HIGH', 'MEDIUM', 'LOW'] },
  ],
  endTitle: 'RACE OVER',
  song: 'drive',
  icon: 'jamkart',
});
