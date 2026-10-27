import '../style.css';
import { Input } from './input.js';
import { GameView } from './GameView.js';
import { sfx, setMuted } from './audio.js';
import { music } from './music.js';
import { getScores, qualifies, addScore, clearScores, entriesCsv } from './leaderboard.js';

const BOARD_EVERY = 14; // idle seconds on the title before showing the top 10
const BOARD_FOR = 7;
const SCREEN_TIMEOUT = 20;
const ENTRY_TIMEOUT = 45; // seconds without typing before the name form gives up

const ICONS = {
  // Cell tower with pulsing signal arcs.
  deadzone: `
    <svg viewBox="0 0 120 120" class="icon">
      <path d="M60 46 L44 112 M60 46 L76 112 M49 90 L71 90 M52 76 L68 76 M55 62 L65 62" />
      <circle cx="60" cy="40" r="6" class="dot" />
      <path class="arc a1" d="M44 24 A22 22 0 0 0 44 56 M76 24 A22 22 0 0 1 76 56" />
      <path class="arc a2" d="M32 14 A36 36 0 0 0 32 66 M88 14 A36 36 0 0 1 88 66" />
      <path class="arc a3" d="M20 4 A50 50 0 0 0 20 76 M100 4 A50 50 0 0 1 100 76" />
    </svg>`,
  // A data packet with speed lines.
  packetracer: `
    <svg viewBox="0 0 120 120" class="icon">
      <path class="streak s1" d="M4 44 L40 44" />
      <path class="streak s2" d="M10 60 L36 60" />
      <path class="streak s3" d="M4 76 L40 76" />
      <path d="M80 20 L112 60 L80 100 L48 60 Z" />
      <path d="M80 20 L80 100 M48 60 L112 60" class="thin" />
    </svg>`,
  // A kart with speed lines.
  jamkart: `
    <svg viewBox="0 0 120 120" class="icon">
      <path class="streak s1" d="M4 54 L28 54" />
      <path class="streak s2" d="M10 68 L28 68" />
      <path class="streak s3" d="M4 82 L28 82" />
      <path d="M36 80 L40 62 L66 58 L76 44 L94 44 L98 60 L114 64 L114 80 Z" />
      <circle cx="52" cy="84" r="9" />
      <circle cx="100" cy="84" r="9" />
      <path class="thin" d="M86 44 L86 24" />
      <circle cx="86" cy="22" r="4" class="dot" />
    </svg>`,
  // A sine wave threading a slot.
  waverider: `
    <svg viewBox="0 0 120 120" class="icon">
      <path class="thin" d="M8 30 L112 30 M8 90 L112 90" />
      <path class="wave" d="M8 60 C 21 20, 34 20, 47 60 S 73 100, 86 60 S 108 28, 112 40" />
    </svg>`,
};

function template(cfg) {
  return `
    <div id="game-stage"></div>
    <div id="game-hud"></div>

    <div id="title-ui" class="screen">
      <div class="title-shade"></div>
      <div class="brand">IEEE FEST <span>·</span> ComSoc AUS Student Branch</div>
      <div class="title-main">
        <div class="logo">
          ${ICONS[cfg.id]}
          <h1>${cfg.logoLines.map((l) => `<span>${l}</span>`).join('')}</h1>
        </div>
        <p class="tagline">${cfg.tagline}</p>
      </div>
      <div class="title-board">
        <h2>TOP 10</h2>
        <table class="leaderboard" id="title-board-table"></table>
      </div>
      <div class="top3-box">
        <div class="top3-title">TOP SCORES</div>
        <ol class="top3" id="top3"></ol>
      </div>
      <div class="prompt">PRESS START</div>
      <div class="controls-hint">${cfg.controlsHint}</div>
    </div>

    <div id="howto" class="screen panel-screen hidden">
      <div class="panel">
        <h1>${cfg.name}</h1>
        <p class="lead">${cfg.lead}</p>
        <ul class="howto-list">
          ${cfg.howto.map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`).join('')}
        </ul>
        ${cfg.modes ? `<div class="modes" id="modes"></div>` : ''}
        <div class="blink">PRESS START WHEN READY</div>
      </div>
    </div>

    <div id="countdown" class="screen hidden"><div id="countdown-num"></div></div>

    <div id="results" class="screen panel-screen hidden">
      <div class="panel">
        <h1 id="results-title">${cfg.endTitle}</h1>
        <div class="score-big" id="results-score"></div>
        <table class="stats" id="results-stats"></table>
        <div class="fact"><span>DID YOU KNOW?</span><p id="results-fact"></p></div>
        <form id="entry" class="entry hidden" autocomplete="off">
          <div class="label">NEW HIGH SCORE! SIGN THE BOARD</div>
          <div class="fields">
            <label class="name"><span>NAME</span><input id="entry-name" maxlength="18" spellcheck="false" placeholder="Your name" /></label>
            <label><span>ID</span><input id="entry-id" maxlength="12" spellcheck="false" placeholder="Student ID" /></label>
          </div>
          <div class="entry-error" id="entry-error"></div>
          <div class="hint-small">ENTER save · ESC skip · only your name is shown on screen</div>
        </form>
        <div class="blink" id="results-continue">PRESS START</div>
      </div>
    </div>

    <div id="board" class="screen panel-screen hidden">
      <div class="panel">
        <h1>${cfg.name} · TOP 10</h1>
        <table class="leaderboard" id="board-table"></table>
        <div class="blink">PRESS START</div>
      </div>
    </div>

    <div class="flash" id="flash"></div>`;
}

// Runs one game as a complete booth cabinet: self-playing title screen,
// how-to, countdown, round, results, name entry and leaderboard.
export function runArcade(cfg) {
  document.body.insertAdjacentHTML('afterbegin', template(cfg));
  const $ = (id) => document.getElementById(id);

  const input = new Input();
  const view = new GameView($('game-stage'));
  const hud = $('game-hud');

  let state = 'title';
  let stateTime = 0;
  let idle = 0;
  let game = null;
  let result = null;
  let entry = null; // { idle } while the name form is up
  let lastRank = -1;
  let mode = 0; // index into cfg.modes, remembered between rounds

  function renderModes() {
    $('modes').innerHTML =
      cfg.modes.map((m, i) => `<span class="${i === mode ? 'on' : ''}">${m}</span>`).join('') +
      '<div class="hint-small">◀ ▶ to choose</div>';
  }

  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // Soundtrack energy per screen; the round itself can push it higher.
  const MOOD = {
    howto: { intensity: 0.12, bpm: 100 },
    select: { intensity: 0.2, bpm: 104 },
    countdown: { intensity: 0.3, bpm: 104 },
    play: { intensity: 0.6, bpm: 112 },
    results: { intensity: 0.1, bpm: 96 },
    board: { intensity: 0.1, bpm: 96 },
  };

  function setState(next) {
    state = next;
    stateTime = 0;
    for (const id of ['title-ui', 'howto', 'countdown', 'results', 'board']) show(id, false);
    show('game-hud', next === 'select' || next === 'countdown' || next === 'play');
    const ids = { title: 'title-ui', howto: 'howto', countdown: 'countdown', results: 'results', board: 'board' };
    if (ids[next]) show(ids[next]);
    if (MOOD[next]) music.set(MOOD[next]);
  }

  function flash() {
    const el = $('flash');
    el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 60);
  }

  function boardRows(highlight = -1) {
    const rows = getScores(cfg.id);
    if (!rows.length) return '<tr><td class="empty">No scores yet. Be the first!</td></tr>';
    return rows
      .map(
        (s, i) =>
          `<tr class="${i === highlight ? 'me' : ''}"><td>${String(i + 1).padStart(2, '0')}</td><td>${esc(s.name)}</td><td>${s.score.toLocaleString()}</td></tr>`
      )
      .join('');
  }

  function startDemo() {
    game?.dispose();
    setMuted(true);
    music.stop();
    game = new cfg.Game(view, null, { demo: true });
    const top = getScores(cfg.id).slice(0, 3);
    $('top3').innerHTML = top.length
      ? top.map((s) => `<li><b>${esc(s.name)}</b><span>${s.score.toLocaleString()}</span></li>`).join('')
      : '<li class="empty">Be the first!</li>';
    $('title-board-table').innerHTML = boardRows();
    $('title-ui').classList.remove('show-board');
    idle = 0;
    setState('title');
  }

  function startRound() {
    game?.dispose();
    setMuted(false);
    music.play(cfg.song);
    sfx.start();
    flash();
    game = new cfg.Game(view, hud);
    if (cfg.modes) renderModes();
    setState('howto');
  }

  function showResults(r) {
    result = r;
    $('results-title').textContent = r.title ?? cfg.endTitle;
    $('results-score').textContent = r.score.toLocaleString();
    $('results-stats').innerHTML = r.stats.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    $('results-fact').textContent = r.fact;
    const signing = qualifies(cfg.id, r.score);
    entry = signing ? { idle: 0 } : null;
    show('entry', signing);
    show('results-continue', !signing);
    $('results').classList.toggle('signing', signing);
    setState('results');
    if (signing) {
      nameEl.value = idEl.value = '';
      setError('');
      nameEl.focus();
    }
  }

  // Name + ID form. Typing goes straight into the inputs; the game's own
  // keyboard handling ignores keys aimed at a text field.
  const nameEl = $('entry-name');
  const idEl = $('entry-id');
  const cleanName = () => nameEl.value.replace(/\s+/g, ' ').trim();
  const cleanId = () => idEl.value.trim();

  function setError(msg, field) {
    $('entry-error').textContent = msg;
    for (const el of [nameEl, idEl]) el.classList.toggle('bad', el === field);
    if (field) {
      sfx.error();
      field.focus();
    }
  }

  function submitEntry() {
    if (cleanName().length < 2) return setError('Please type your name', nameEl);
    if (cleanId().length < 3) return setError('Please type your ID', idEl);
    finishEntry(true);
  }

  function finishEntry(save) {
    entry = null;
    document.activeElement?.blur();
    lastRank = save ? addScore(cfg.id, { name: cleanName(), id: cleanId() }, result.score) : -1;
    save ? sfx.start() : sfx.back();
    showBoard();
  }

  idEl.addEventListener('input', () => {
    idEl.value = idEl.value.replace(/[^A-Za-z0-9-]/g, '');
  });
  $('entry').addEventListener('submit', (e) => e.preventDefault());
  $('entry').addEventListener('keydown', (e) => {
    if (!entry) return;
    entry.idle = 0;
    if (e.key === 'Escape') finishEntry(false);
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.target === nameEl) {
      if (cleanName().length < 2) setError('Please type your name', nameEl);
      else {
        setError('');
        sfx.select();
        idEl.focus();
      }
    } else submitEntry();
  });

  function showBoard() {
    $('board-table').innerHTML = boardRows(lastRank);
    setState('board');
  }

  // Hidden operator keys.
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'KeyF' && state !== 'results') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
    // Ctrl+Shift+Backspace wipes this game's leaderboard (end-of-day reset).
    if (e.code === 'Backspace' && e.ctrlKey && e.shiftKey) {
      clearScores(cfg.id);
      if (state === 'title') startDemo();
    }
    // Ctrl+Shift+E downloads every signed name + ID as a CSV.
    if (e.code === 'KeyE' && e.ctrlKey && e.shiftKey) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([entriesCsv(cfg.id)], { type: 'text/csv' }));
      a.download = `${cfg.id}-entries.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  });

  function tick(dt) {
    stateTime += dt;
    input.update();
    idle = input.anyActivity ? 0 : idle + dt;

    switch (state) {
      case 'title': {
        game.update(dt, input, true);
        // Attract loop: every so often swap the logo for the top 10.
        const cycle = (idle - BOARD_EVERY) % (BOARD_EVERY + BOARD_FOR);
        $('title-ui').classList.toggle('show-board', idle > BOARD_EVERY && cycle < BOARD_FOR);
        if (input.pressed('start')) startRound();
        break;
      }
      case 'howto':
        game.update(dt, input, false);
        if (cfg.modes) {
          const mx = input.menuX();
          if (mx && mode + mx >= 0 && mode + mx < cfg.modes.length) {
            mode += mx;
            renderModes();
            sfx.move();
          }
        }
        if (input.pressed('back')) startDemo();
        else if (input.pressed('start') && stateTime > 0.5) {
          sfx.select();
          if (cfg.modes) game.setMode(mode);
          setState(game.updateSelect ? 'select' : 'countdown');
        } else if (stateTime > 30) startDemo();
        break;
      case 'select':
        // The game draws its own pick-your-kart screen and says when it's done.
        if (input.pressed('back')) startDemo();
        else if (game.updateSelect(dt, input)) setState('countdown');
        break;
      case 'countdown': {
        game.update(dt, input, false);
        const n = 3 - Math.floor(stateTime);
        const label = n > 0 ? String(n) : 'GO!';
        if ($('countdown-num').textContent !== label) {
          $('countdown-num').textContent = label;
          n > 0 ? sfx.tick() : sfx.start();
        }
        if (stateTime > 3.6) setState('play');
        break;
      }
      case 'play': {
        const r = game.update(dt, input, true);
        if (input.pressed('back')) {
          sfx.back();
          startDemo();
        } else if (r) {
          sfx.gameOver();
          flash();
          showResults(r);
        }
        break;
      }
      case 'results':
        view.render();
        if (entry) {
          // Walked away: keep the score if they at least typed a name.
          entry.idle += dt;
          if (entry.idle > ENTRY_TIMEOUT) finishEntry(cleanName().length >= 2);
        } else if ((input.pressed('start') && stateTime > 1) || stateTime > SCREEN_TIMEOUT) {
          lastRank = -1;
          showBoard();
        }
        break;
      case 'board':
        view.render();
        if ((input.pressed('start') && stateTime > 0.8) || stateTime > SCREEN_TIMEOUT) startDemo();
        break;
    }
    input.endFrame();
  }

  let last = performance.now();
  function frame(now) {
    // rAF's timestamp can predate `last` on the first frame; never go negative.
    tick(Math.min(Math.max((now - last) / 1000, 0), 0.05));
    last = now;
    requestAnimationFrame(frame);
  }

  // Dev console hook; step() runs frames by hand (e.g. in a background tab).
  window.__arcade = {
    input,
    view,
    get game() { return game; },
    get state() { return state; },
    step: (frames = 1, dt = 1 / 60) => { for (let i = 0; i < frames; i++) tick(dt); },
  };

  startDemo();
  requestAnimationFrame(frame);
}
