import { runArcade } from './core/arcade.js';
import { PacketRacer } from './games/packetracer/PacketRacer.js';

runArcade({
  id: 'packetracer',
  name: 'PACKET RACER',
  Game: PacketRacer,
  logoLines: ['PACKET', 'RACER'],
  tagline: 'You are a data packet. Race across the network before your Time-To-Live runs out.',
  controlsHint: 'STEER ◀ ▶ · BOOST SPACE / Ⓐ',
  lead: 'Your TTL is ticking. Router hops add time. Collisions cost time. Hit zero and you get dropped.',
  howto: [
    ['STEER', '◀ ▶ / A D · stick'],
    ['BOOST', 'Hold SPACE / Ⓐ / ▲ to burn bandwidth'],
    ['DODGE', 'Red packets: a collision costs 4s of TTL'],
    ['FIREWALL', 'Thread the gap in the orange walls'],
    ['ROUTE', 'At router forks time slows down. Pick a side: low latency = more TTL, but congested'],
    ['PICKUPS', 'Green ring = ECC shield (blocks one hit) · Blue orb = bandwidth'],
  ],
  endTitle: 'PACKET DROPPED',
});
