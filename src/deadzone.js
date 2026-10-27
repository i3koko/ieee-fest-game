import { runArcade } from './core/arcade.js';
import { DeadZone } from './games/deadzone/DeadZone.js';

runArcade({
  id: 'deadzone',
  name: 'DEAD ZONE',
  Game: DeadZone,
  logoLines: ['DEAD', 'ZONE'],
  tagline: 'A disaster took the network down. Drive the emergency cell truck and bring the city back online.',
  controlsHint: 'DRIVE ▲▼◀▶ · DEPLOY SPACE / Ⓐ · CHANNEL SHIFT / Ⓧ',
  lead: 'People are stranded with NO SERVICE. You have 90 seconds and 6 portable cell towers.',
  howto: [
    ['1 · FIND', 'Follow the yellow arrow to a red crowd of people with no signal'],
    ['2 · STOP', 'Stop near them. A white ring shows what a tower here would cover, and how many people it reaches'],
    ['3 · DEPLOY', 'Press SPACE / Ⓐ to drop a tower. Press again beside one to pick it back up'],
    ['CHANNEL', 'SHIFT / Ⓧ. Overlapping towers on the SAME channel jam each other: give neighbours different colours'],
    ['SIGNAL', 'Tall buildings (red roof lights) block signal. Park with a clear view of the crowd'],
    ['SOS', 'Red beams are emergency callers. Connect them for a big bonus'],
  ],
  endTitle: "TIME'S UP",
});
