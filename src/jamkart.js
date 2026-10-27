import { runArcade } from './core/arcade.js';
import { JamKart } from './games/jamkart/JamKart.js';
import { loadKarts } from './games/jamkart/kart.js';

await loadKarts();

runArcade({
  id: 'jamkart',
  name: 'JAM KART',
  Game: JamKart,
  logoLines: ['JAM', 'KART'],
  tagline: 'Race a rival round a circuit board. Jam their signal, firewall their path, compress for speed.',
  controlsHint: 'P1 · A D STEER · SPACE ITEM  ·  P2 · ◀ ▶ STEER · ENTER ITEM',
  lead: '3 laps round a circuit board. Your kart drives itself forward: you steer and use power-ups.',
  howto: [
    ['PICK A KART', 'FIBER is fastest, 5G turns sharpest, SATELLITE is heaviest. Each has its own perk'],
    ['STEER', 'Player 1: A / D (or the left stick). Player 2: ◀ / ▶ (or the second controller). Down brakes'],
    ['? BOXES', 'Drive through the glowing boxes to grab a power-up, then press SPACE / ENTER (Ⓐ) to use it'],
    ['JAMMER', 'Static on your rival\'s screen and a wobbly wheel, but only if they\'re within radio range'],
    ['MORE POWER-UPS', 'FIREWALL drops a wall behind you · COMPRESSION boosts · ECC SHIELD repairs the next hit'],
  ],
  modes: ['1 PLAYER · VS CPU', '2 PLAYERS'],
  endTitle: 'RACE OVER',
});
