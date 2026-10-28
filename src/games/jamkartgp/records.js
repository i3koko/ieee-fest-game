// Today's lap record on this machine: the lap time, its two sector splits
// (for the live timing), the kart, and the driver's name once they sign the
// board. A new day starts a fresh record.
const KEY = 'jamkartgp-record';
const today = () => new Date().toDateString();

export function getRecord() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY));
    return r && r.day === today() ? r : null;
  } catch {
    return null;
  }
}

function save(r) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // Storage blocked: the record lasts as long as the page.
  }
}

// splits: [sector 1, sector 1+2, full lap] in seconds from the lap's start.
export function setRecord(splits, kart) {
  const r = { day: today(), lap: splits[2], splits, kart, name: null };
  save(r);
  return r;
}

export function nameRecord(name) {
  const r = getRecord();
  if (!r) return;
  r.name = name;
  save(r);
}
