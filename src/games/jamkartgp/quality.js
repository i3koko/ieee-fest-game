// Graphics quality for Jam Kart GP. On AUTO the game watches its own frame
// times and steps down a tier when it can't keep up (it never steps back up
// mid-session, so it can't flicker between tiers). The tier it settles on is
// remembered on this machine, so the next visit starts there. The how-to
// screen's GRAPHICS setting can pin a tier instead.
export const TIERS = {
  high: { name: 'high', shadows: true, shadowSize: 2048, rain: 1, meadows: 1, pixelRatio: 1.5 },
  medium: { name: 'medium', shadows: true, shadowSize: 1024, rain: 0.6, meadows: 0.5, pixelRatio: 1.25 },
  low: { name: 'low', shadows: false, shadowSize: 1024, rain: 0.35, meadows: 0, pixelRatio: 1 },
};
const ORDER = ['high', 'medium', 'low'];
const KEY = 'jamkartgp-quality';
const WINDOW = 120; // frames per measurement
const SLOW = 21; // ms: a median frame slower than this is under ~48 fps

function load() {
  try {
    const v = localStorage.getItem(KEY);
    return TIERS[v] ? v : null;
  } catch {
    return null;
  }
}

function save(tier) {
  try {
    localStorage.setItem(KEY, tier);
  } catch {
    // Private mode or storage blocked: it just re-measures next time.
  }
}

// apply(settings) is called whenever the tier in use changes.
export function createQuality(apply) {
  let auto = load() ?? 'high';
  let pinned = null;
  let last = 0;
  let slowWindows = 0;
  const frames = [];
  const current = () => TIERS[pinned ?? auto];

  return {
    get tier() {
      return current().name;
    },
    get settings() {
      return current();
    },
    // From the GRAPHICS setting: 'AUTO', 'HIGH', 'MEDIUM' or 'LOW'.
    setMode(choice = 'AUTO') {
      const want = TIERS[choice.toLowerCase()] ? choice.toLowerCase() : null;
      if (want === pinned) return;
      pinned = want;
      frames.length = 0;
      apply(current());
    },
    // Call once per rendered frame.
    sample(now = performance.now()) {
      const dt = now - last;
      last = now;
      // Skip pinned tiers, the floor, and gaps (a hidden tab or a pause).
      if (pinned || auto === 'low' || dt <= 0 || dt > 100) return;
      frames.push(dt);
      if (frames.length < WINDOW) return;
      const median = frames.sort((a, b) => a - b)[WINDOW >> 1];
      frames.length = 0;
      // Two slow measurements in a row (a few seconds) before acting,
      // so one hiccup doesn't cost the whole session its shadows.
      slowWindows = median > SLOW ? slowWindows + 1 : 0;
      if (slowWindows < 2) return;
      slowWindows = 0;
      auto = ORDER[ORDER.indexOf(auto) + 1];
      save(auto);
      apply(current());
    },
  };
}
