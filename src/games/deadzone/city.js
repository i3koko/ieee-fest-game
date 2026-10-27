// Procedural city for Dead Zone. Seeded so every player gets the same map,
// which keeps the leaderboard fair.
export const BLOCKS = 8;
export const BLOCK = 26;
export const STREET = 12;
export const PITCH = BLOCK + STREET;
export const EXTENT = BLOCKS * PITCH;
export const HALF = EXTENT / 2;
export const TALL = 12; // buildings at least this tall block signals

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const blockOrigin = (i) => -HALF + STREET / 2 + i * PITCH;

export function generateCity(seed = 2026) {
  const rand = mulberry32(seed);
  const between = (a, b) => a + rand() * (b - a);
  const buildings = [];
  const clusters = [];
  const blocks = [];

  const addBuilding = (minX, minZ, maxX, maxZ) => {
    const tall = rand() < 0.42;
    const h = tall ? between(TALL + 2, 34) : between(3, 9);
    buildings.push({ minX, minZ, maxX, maxZ, h });
  };

  for (let bx = 0; bx < BLOCKS; bx++) {
    for (let bz = 0; bz < BLOCKS; bz++) {
      const x0 = blockOrigin(bx);
      const z0 = blockOrigin(bz);
      const x1 = x0 + BLOCK;
      const z1 = z0 + BLOCK;
      blocks.push({ minX: x0, minZ: z0, maxX: x1, maxZ: z1 });

      const inset = 3;
      const kind = rand();
      if (kind < 0.14) {
        // Plaza: no building, a big crowd.
        clusters.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, count: 12 + Math.floor(rand() * 7), spread: 7 });
        continue;
      }
      if (kind < 0.4) {
        addBuilding(x0 + inset, z0 + inset, x1 - inset, z1 - inset);
      } else {
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        const gap = 1.2;
        addBuilding(x0 + inset, z0 + inset, mx - gap, mz - gap);
        addBuilding(mx + gap, z0 + inset, x1 - inset, mz - gap);
        addBuilding(x0 + inset, mz + gap, mx - gap, z1 - inset);
        addBuilding(mx + gap, mz + gap, x1 - inset, z1 - inset);
      }

      // A sidewalk crowd on some blocks. Kept sparse so a few well-placed
      // towers can make a visible dent in the total.
      if (rand() < 0.42) {
        const side = Math.floor(rand() * 4);
        const along = between(0.25, 0.75);
        const pos = [
          { x: x0 + BLOCK * along, z: z0 + 1.4 },
          { x: x0 + BLOCK * along, z: z1 - 1.4 },
          { x: x0 + 1.4, z: z0 + BLOCK * along },
          { x: x1 - 1.4, z: z0 + BLOCK * along },
        ][side];
        clusters.push({ ...pos, count: 4 + Math.floor(rand() * 4), spread: 2.5, edge: side });
      }
    }
  }

  const people = [];
  clusters.forEach((c, ci) => {
    c.people = [];
    for (let i = 0; i < c.count; i++) {
      const horizontal = c.edge === 0 || c.edge === 1;
      const vertical = c.edge === 2 || c.edge === 3;
      const p = {
        x: c.x + (vertical ? between(-0.8, 0.8) : between(-c.spread, c.spread) * (horizontal ? 1.6 : 1)),
        z: c.z + (horizontal ? between(-0.8, 0.8) : between(-c.spread, c.spread) * (vertical ? 1.6 : 1)),
        cluster: ci,
        phase: rand() * Math.PI * 2,
      };
      c.people.push(people.length);
      people.push(p);
    }
  });

  return { buildings, clusters, people, blocks };
}

// Does the 2D segment (ax,az)->(bx,bz) cross the box? Slab test.
export function segmentHitsBox(ax, az, bx, bz, b) {
  let tmin = 0;
  let tmax = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (const [o, d, lo, hi] of [
    [ax, dx, b.minX, b.maxX],
    [az, dz, b.minZ, b.maxZ],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}
