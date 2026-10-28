import * as THREE from 'three';
import { TRACK_W, SAMPLES } from './track.js';

// TV-style cameras for after a player crosses the line: the race carries on
// and the view cuts between shots of their kart, like a broadcast. Trackside
// cameras that pan as the kart goes by (zoomed in from afar), a helicopter
// view, a low camera in front looking back, and one tracking alongside.
const SHOTS = ['trackside', 'heli', 'front', 'side', 'trackside'];
const clamp = THREE.MathUtils.clamp;

export function createDirector(track) {
  const ground = (x, z) => (track.terrainY ? track.terrainY(x, z) : 0);
  const step = track.length / SAMPLES;

  // One state per player camera.
  return function director() {
    let shot = null;
    let t = 0;
    let last = '';
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    const fixed = new THREE.Vector3();
    let side = 1;
    let fresh = false;

    const next = (k) => {
      const choices = SHOTS.filter((s) => s !== last);
      shot = choices[Math.floor(Math.random() * choices.length)];
      last = shot;
      t = 0;
      fresh = true;
      side = Math.random() < 0.5 ? -1 : 1;
      if (shot === 'trackside') {
        // A spot beside the track 50-80 m ahead, a little above the verge.
        const i = (k.idx + Math.round((50 + Math.random() * 30) / step)) % SAMPLES;
        const lat = side * (TRACK_W / 2 + 3.5 + Math.random() * 1.5);
        const p = track.pts[i];
        const x = p.x + track.side[i].x * lat;
        const z = p.y + track.side[i].y * lat;
        fixed.set(x, Math.max(ground(x, z), track.height[i]) + 1.8 + Math.random() * 2, z);
      }
      return true;
    };

    return (cam, k, dt) => {
      t += dt;
      const fx = Math.sin(k.h);
      const fz = Math.cos(k.h);
      const kart = new THREE.Vector3(k.x, k.y + 0.9, k.z);
      let cut = !shot;
      if (shot === 'trackside') {
        // Ends once the kart is well past the camera.
        const ahead = (fixed.x - k.x) * fx + (fixed.z - k.z) * fz;
        if (ahead < -25 || t > 9) cut = true;
      } else if (t > 4.5 + (shot === 'heli' ? 1.5 : 0)) cut = true;
      if (cut) next(k);

      let want;
      let fov;
      let ease = Math.min(dt * 3, 1);
      if (shot === 'trackside') {
        want = fixed;
        // Zoomed in while the kart is far off, opening up as it passes.
        const d = fixed.distanceTo(kart);
        fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan2(5, d)), 14, 60);
        ease = 1;
      } else if (shot === 'heli') {
        want = new THREE.Vector3(k.x - fx * 30 + fz * side * 24, k.y + 24, k.z - fz * 30 - fx * side * 24);
        fov = 38;
      } else if (shot === 'front') {
        want = new THREE.Vector3(k.x + fx * 11 + fz * side * 2.5, k.y + 1.1, k.z + fz * 11 - fx * side * 2.5);
        fov = 48;
      } else {
        // Alongside, sliding slowly from the front quarter to the rear.
        const a = THREE.MathUtils.degToRad(50 + (t / 4.5) * 80);
        const ox = fx * Math.cos(a) + fz * Math.sin(a) * side;
        const oz = fz * Math.cos(a) - fx * Math.sin(a) * side;
        want = new THREE.Vector3(k.x + ox * 7, k.y + 1.6, k.z + oz * 7);
        fov = 45;
      }
      // A fresh shot cuts straight there; within a shot the camera glides.
      if (fresh) {
        fresh = false;
        pos.copy(want);
        look.copy(kart);
        cam.fov = fov;
      } else {
        pos.lerp(want, ease);
        look.lerp(kart, Math.min(dt * 6, 1));
        cam.fov += (fov - cam.fov) * Math.min(dt * 3, 1);
      }
      pos.y = Math.max(pos.y, ground(pos.x, pos.z) + 0.8);
      cam.position.copy(pos);
      cam.lookAt(look);
      cam.updateProjectionMatrix();
    };
  };
}
