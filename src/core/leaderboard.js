// Per-game top-10 table kept in the booth machine's localStorage, plus a
// full log of every signed entry (name + ID) for the booth team to export.
const SIZE = 10;
const keyFor = (game) => `ieeefest.leaderboard.${game}`;
const logKey = (game) => `ieeefest.entries.${game}`;

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? [];
  } catch {
    return [];
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the table just won't persist.
  }
}

export function getScores(game) {
  return load(keyFor(game));
}

// The place (0-based) a score would take on the board.
export function rankFor(game, score) {
  return getScores(game).filter((s) => s.score >= score).length;
}

export function qualifies(game, score) {
  if (score <= 0) return false;
  const scores = getScores(game);
  return scores.length < SIZE || score > scores[scores.length - 1].score;
}

// One row per person: a repeat ID only replaces their row if it beats it.
// Returns the 0-based rank of that person's row (-1 if it fell off).
export function addScore(game, { name, id }, score) {
  const at = Date.now();
  save(logKey(game), [...load(logKey(game)), { name, id, score, at }]);

  let scores = getScores(game);
  const sameId = (s) => id && s.id?.toLowerCase() === id.toLowerCase();
  const prev = scores.find(sameId);
  if (prev && prev.score >= score) return scores.indexOf(prev);
  const entry = { name, id, score, at };
  scores = scores.filter((s) => !sameId(s));
  scores.push(entry);
  scores.sort((a, b) => b.score - a.score);
  scores.length = Math.min(scores.length, SIZE);
  save(keyFor(game), scores);
  return scores.indexOf(entry);
}

export function clearScores(game) {
  try {
    localStorage.removeItem(keyFor(game));
  } catch {}
}

// Every signed entry as CSV, for picking winners after the event.
export function entriesCsv(game) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = load(logKey(game)).map((e) => [e.name, e.id, e.score, new Date(e.at).toISOString()].map(cell).join(','));
  return ['name,id,score,time', ...rows].join('\n');
}
