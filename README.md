# IEEE Fest booth games: ComSoc AUS

Communication-themed 3D arcade games for the browser, built with three.js + Vite. Each one is its own standalone page with its own self-playing title screen and leaderboard, so you can run one per booth screen.

**Play online:** https://i3koko.github.io/ieee-fest-game/ (opens Wave Rider). Every push to `main` redeploys it through GitHub Actions.

- **Wave Rider** (`waverider.html`), the current prototype: you are a radio signal riding down a neon tunnel. Reshape your wave with ◀ ▶ (frequency) and ▲ ▼ (amplitude) to fit wave-shaped gaps in oncoming walls. You hear your wave too: pitch follows frequency, loudness follows amplitude. A synthwave soundtrack, generated live in the browser, builds up and speeds up as the run gets faster.
- **Dead Zone** (`deadzone.html`): drive an emergency cell truck through a blacked-out city and deploy portable towers to reconnect people. Teaches coverage, path loss, line of sight and frequency reuse / co-channel interference (SINR).
- **Packet Racer** (`packetracer.html`): you are a data packet racing your TTL. Dodge collisions, thread firewalls, pick low-latency vs safe routes at router forks (time slows down so you can read them), and grab ECC shields.

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173/waverider.html (or deadzone.html / packetracer.html).

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
src/games/deadzone/               city generator (seeded) + game
src/games/packetracer/            game
```

Each game class takes `(view, hudRoot, { demo })` and exposes `update(dt, input, live)`, which returns `{ score, stats, fact }` when the round ends. In demo mode it drives itself with no HUD, which the title screen uses as its backdrop.
