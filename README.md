# IEEE Fest booth games: ComSoc AUS

Communication-themed 3D arcade games for the browser, built with three.js + Vite. Each one is its own standalone page with its own self-playing title screen and leaderboard, so you can run one per booth screen.

**Play online:** https://i3koko.github.io/ieee-fest-game/ (opens Wave Rider). Every push to `main` redeploys it through GitHub Actions.

- **Wave Rider** (`waverider.html`): you are a radio signal riding down a neon tunnel. Reshape your wave with ◀ ▶ (frequency) and ▲ ▼ (amplitude) to fit wave-shaped gaps in oncoming walls. You hear your wave too: pitch follows frequency, brightness and loudness follow amplitude. A synthwave soundtrack, generated live in the browser, builds with your speed and combo.
- **Jam Kart** (`jamkart.html`): an 8-kart race round a circuit board, for 1 player (full screen, vs 7 CPUs) or 2 (split screen, plus 6 CPUs). Players pick one of five Blender-built karts and a colour: **FIBER** (fastest, longer boosts), **5G** (sharpest turns, shrugs off hits), **SATELLITE** (heaviest, longest-range jammer), **RADIO** (all-rounder, holds two power-ups) or **LASER** (light and quick, fastest drift charge). Karts carry momentum and drift: tap brake while turning, hold the turn, let go for a mini-turbo. The track has hills, a jump and banked corners, and power-ups are comms tricks (Jammer, Firewall, Compression, ECC Shield). Each one explains itself when picked up.
- **Jam Kart GP** (`jamkartgp.html`): Jam Kart v2, kept separate from v1 with its own leaderboard. Same karts, drifting and power-ups, on a 1.3 km Grand Prix circuit loosely inspired by Spa: a hairpin after the start, a dip and steep climb, a long straight, chicanes, a hairpin and fast sweepers, through forested hills. Daylight racetrack dressing: asphalt with grid slots, red/white kerbs, gravel traps, armco, grandstands with a crowd, pits with a satellite ground station, start lights that count down, a bridge, sponsor boards, braking boards and TV camera towers. Arcade kart-racer handling: quick steering that stays sharp at speed, high grip, most corners flat out (only the tightest hairpins need a lift), bounces off the barriers, no drifting. Each kart has spring-damper suspension (it squats, dives, rolls and rattles over kerbs) that is automatically kept inside the kart's carved wheel arches, slick tyres with a rim design per kart, front wheels that steer, and wheels that spin at road speed. Top speed ~105-112 km/h; running wide onto the grass slows you. A km/h speedometer shows your speed. Two laps.
- **Dead Zone** (`deadzone.html`): drive an emergency cell truck through a blacked-out city and deploy portable towers to reconnect people. Teaches coverage, path loss, line of sight and frequency reuse / co-channel interference (SINR).
- **Packet Racer** (`packetracer.html`): you are a data packet racing your TTL. Dodge collisions, thread firewalls, pick low-latency vs safe routes at router forks (time slows down so you can read them), and grab ECC shields.

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173/waverider.html or http://localhost:5173/jamkart.html (the older deadzone.html and packetracer.html are still there too).

For the booth, build once and serve the static files (works offline):

```bash
npm run build && npm run preview
```

## Controls

| | Keyboard | Gamepad |
|---|---|---|
| Start / confirm | Enter / Space | A / Start |
| Quit to title | Esc | Back |
| Drive / steer | Arrows / WASD | Stick, RT throttle, LT brake |
| Deploy tower / boost | Space | A |
| Change channel (Dead Zone) | Shift / C | X / Y / bumpers |
| Jam Kart player 1 | A / D steer, S brake (tap while turning to drift), Space item | Pad 1: stick, A item, B / LB drift |
| Jam Kart player 2 | ◀ ▶ steer, ▼ brake / drift, Enter item | Pad 2: stick, A item, B / LB drift |

Signing the leaderboard needs a keyboard: players with a top-10 score type their **name** and **ID**, press Enter to save, or press Esc to skip. Only names appear on screen. Each ID gets one row on the board, showing that person's best score.

## Booth operator keys

- **F**: toggle fullscreen
- **Ctrl + Shift + E**: download every signed name, ID and score as a CSV (for picking winners)
- **Ctrl + Shift + Backspace**: wipe that game's on-screen top 10 (the CSV log is kept)
- Scores live in this browser's localStorage only. Nothing is uploaded, so use the same machine and browser all day and export the CSV before clearing browser data.
- When idle, the title screen shows the top 10 every so often. Results and leaderboard screens return to the title on their own.

## Layout

```
waverider.html, deadzone.html, packetracer.html   one page per game (index.html forwards to Wave Rider)
src/waverider.js, deadzone.js, packetracer.js     page entry: game text + runArcade()
src/core/arcade.js                screen flow: demo title → how-to → countdown → play → results → name + ID → leaderboard
src/core/music.js                 procedural soundtrack (Am–F–C–G synthwave; layers follow game intensity)
src/core/                         input (keyboard + gamepad), sound effects, leaderboard, shared bloom renderer
src/games/waverider/              wave maths + game
src/games/jamkart/                track + hazards, set dressing (details.js), kart models + stats, sounds, game
src/core/music.js                 (also) two songs: 'synthwave' for Wave Rider, 'drive' for Jam Kart
tools/build_karts.py              Blender script that builds the five karts into public/models/*.glb
tools/build_track_props.py        Blender script for Jam Kart GP's buildings (public/models/gp/*.glb)
src/games/jamkartgp/              Jam Kart GP: its own copy of the game, circuit, terrain and set dressing
src/games/deadzone/               city generator (seeded) + game
src/games/packetracer/            game
```

Each game class takes `(view, hudRoot, { demo })` and exposes `update(dt, input, live)`, which returns `{ score, stats, fact }` when the round ends. In demo mode it drives itself with no HUD, which the title screen uses as its backdrop.

## Rebuilding the karts

The kart models are generated by a Blender script, so they can be tweaked in code and re-exported:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --python tools/build_karts.py -- public/models
```

The game recolours any material named `Paint` or `Glow` to the player's chosen colour and spins objects named `Wheel_*`.

## Jam Kart track features

**Jam Kart GP**: pick on the how-to screen (▲ ▼ to the HAZARDS row, ◀ ▶ to change): ALL ON, NO GATES, BOOST ONLY or OFF. Features are `rain` (wet, slippery patches), `boost` (fibre strips) and `gates` (clock-gate pistons), defined in `HAZARDS` in `src/games/jamkartgp/track.js`.

**Jam Kart v1**: delete a line (or set it to `[]`) in `HAZARDS` near the top of the track file to switch that feature off. Its sign goes too, and the CPUs stop reacting to it.

**Jam Kart v1** (`src/games/jamkart/track.js`):

| Feature | Effect |
|---|---|
| `flux` | Slippery solder-flux spills (grip drops to a fifth) |
| `boost` | Green fibre-link strips that boost you |
| `emi` | Interference zone by a crackling coil: wobbly steering and light static |
| `fan` | A cooling fan whose gusts push karts sideways |
| `gates` | Clock-gate pistons rising on a beat; one lane is always open |

## Branding

The official IEEE ComSoc logo (white) is in `public/brand/comsoc-white.png`, converted from `ieee-comsoc-registered-white.eps`. It appears on every title screen and on Jam Kart GP's banners and billboards. Replace the file to update it everywhere.
