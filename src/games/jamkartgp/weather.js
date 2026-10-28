import * as THREE from 'three';
import { canvasTexture } from './track.js';

// Jam Kart GP's sky and weather. One dial, `cloud` (0 clear .. 1 storm), and
// one for the rain, `wet` (0 dry .. 1 pouring), drive everything: the sky
// dome, two layers of drifting clouds, the sun (which casts the shadows), the
// ambient light, the fog, falling rain around each player's camera, and a
// sky reflection map so wet tarmac and kart paint pick up the sky.
// A third dial, `night` (0 day .. 1 night), brings the sunset at the end of
// the race: the sun sinks and goes orange, then the moon and stars come out.
const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
const MOON_DIR = new THREE.Vector3(0.5, 0.5, 0.7).normalize();
const CLEAR = { fog: new THREE.Color(0xa9c6e4), zenith: new THREE.Color(0x3d7fd6), near: 140, far: 520, sun: 2.1, hemi: 0.65 };
const STORM = { fog: new THREE.Color(0x7d8791), zenith: new THREE.Color(0x58606c), near: 50, far: 260, sun: 0.5, hemi: 0.6 };
const DUSK = { fog: new THREE.Color(0xe0a27c), zenith: new THREE.Color(0x4a5a9a), sun: new THREE.Color(0xff9a4a) };
const NIGHT = { fog: new THREE.Color(0x111a30), zenith: new THREE.Color(0x040919), moon: new THREE.Color(0x9fb6ff), moonI: 0.85 };
const SUN_SWAP = 0.68; // night level where the (set) sun hands over to the moon

export function buildWeather(scene, renderer, { rainDrops = 2200 } = {}) {
  // ---------------------------------------------------------------- light
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x4a5a32, CLEAR.hemi);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e6, CLEAR.sun);
  const SUN_COLOR = sun.color.clone();
  const HEMI_SKY = hemi.color.clone();
  const HEMI_GROUND = hemi.groundColor.clone();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = c.bottom = -70;
  c.right = c.top = 70;
  c.near = 10;
  c.far = 320;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.5;
  scene.add(sun, sun.target);

  // ---------------------------------------------------------------- sky
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // The horizon colours match the fog, so distant hills melt into the sky.
    // The colours are worked out on the CPU each frame (see update).
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uSunCol: { value: new THREE.Color(1, 0.8, 0.55) },
      uMoon: { value: MOON_DIR },
      uCloud: { value: 0 },
      uNight: { value: 0 },
      uHorizon: { value: CLEAR.fog.clone() },
      uZenith: { value: CLEAR.zenith.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // Pinned to the far plane, so the dome is never clipped however far
        // the camera is from its centre.
        gl_Position = (projectionMatrix * modelViewMatrix * vec4(position, 1.0)).xyww;
        gl_Position.z *= 0.99999;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun, uSunCol, uMoon;
      uniform float uCloud, uNight;
      uniform vec3 uHorizon, uZenith;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 horizon = uHorizon;
        vec3 col = mix(horizon, uZenith, pow(h, 0.5));
        float s = max(dot(vDir, uSun), 0.0);
        float clear = 1.0 - uCloud;
        // Warm glow round the sun and the disc, kept just bright enough for
        // a little glare (any brighter and the bloom hazes the whole screen).
        // At sunset the glow spreads wider along the horizon.
        float sunUp = 1.0 - smoothstep(0.55, 0.7, uNight);
        col += uSunCol * (pow(s, 10.0) * 0.22 + pow(s, 3.0) * 0.25 * uNight) * clear * sunUp;
        col = mix(col, uSunCol * 1.15 + 0.15, smoothstep(0.9994, 0.9998, s) * clear * sunUp);
        // The moon: a pale disc with a faint halo.
        float m = max(dot(vDir, uMoon), 0.0);
        float moonUp = smoothstep(0.7, 0.95, uNight) * (1.0 - uCloud * 0.8);
        col += vec3(0.5, 0.6, 0.85) * pow(m, 60.0) * 0.12 * moonUp;
        col = mix(col, vec3(0.95, 0.96, 1.0), smoothstep(0.99955, 0.9998, m) * moonUp);
        col = mix(col, horizon * 0.9, (1.0 - smoothstep(-0.05, 0.1, vDir.y)) * 0.5);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  // Stars, faded in as night falls. Points on the dome, drawn just after it.
  const starCount = 1400;
  const starPos = new Float32Array(starCount * 3);
  const starCol = new Float32Array(starCount * 3);
  for (let n = 0; n < starCount; n++) {
    const y = Math.pow(Math.random(), 0.7) * 0.97 + 0.03;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    starPos.set([Math.cos(a) * r * 850, y * 850, Math.sin(a) * r * 850], n * 3);
    const b = 0.35 + Math.random() ** 3 * 1.4;
    const warm = Math.random();
    starCol.set([b * (0.85 + 0.15 * warm), b * 0.92, b * (1.05 - 0.2 * warm)], n * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const starMat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -1;
  stars.frustumCulled = false;
  stars.visible = false;
  scene.add(stars);

  // ---------------------------------------------------------------- clouds
  // Soft puffs painted once, then scattered as big billboards in two layers.
  // Storm clouds are the same puffs, more of them, darker and lower.
  const puff = canvasTexture(512, 256, (g, w, h) => {
    for (let n = 0; n < 40; n++) {
      const x = w * (0.15 + Math.random() * 0.7);
      const y = h * (0.5 + (Math.random() - 0.5) * 0.35 * (1 - Math.abs(x / w - 0.5)));
      const r = 30 + Math.random() * 55;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.6, 'rgba(240,244,250,0.25)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
    // Shade the undersides.
    const shade = g.createLinearGradient(0, h * 0.35, 0, h);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(70,80,95,0.35)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
  });
  const clouds = [];
  const cloudMats = [0, 1].map(() => new THREE.SpriteMaterial({ map: puff, transparent: true, depthWrite: false, fog: false }));
  for (let n = 0; n < 40; n++) {
    const storm = n >= 12; // the rest only show up as it clouds over
    const layer = n % 2;
    const s = new THREE.Sprite(cloudMats[layer]);
    const a = Math.random() * Math.PI * 2;
    const d = 160 + Math.random() * 520;
    s.position.set(Math.cos(a) * d + 60, (layer ? 150 : 105) + Math.random() * 50 - (storm ? 25 : 0), Math.sin(a) * d + 30);
    const k = (storm ? 0.9 : 0.6) + Math.random() * 0.8;
    s.scale.set(260 * k, 110 * k, 1);
    s.material = cloudMats[layer].clone();
    scene.add(s);
    clouds.push({ s, storm, base: s.position.clone(), speed: 2 + Math.random() * 3 + layer * 2 });
  }

  // ---------------------------------------------------------------- rain
  // Short falling streaks in a box that follows each camera.
  const makeRain = () => {
    const pos = new Float32Array(rainDrops * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xc4d2e0, transparent: true, opacity: 0, depthWrite: false, fog: false })
    );
    lines.frustumCulled = false;
    scene.add(lines);
    const drops = Array.from({ length: rainDrops }, () => ({ x: (Math.random() - 0.5) * 70, y: Math.random() * 34, z: (Math.random() - 0.5) * 70, v: 20 + Math.random() * 6 }));
    return { lines, drops, pos };
  };
  const rains = [makeRain(), makeRain()];
  const WIND = new THREE.Vector3(2.5, 0, 1.2);

  // ---------------------------------------------------------------- reflections
  // One sky reflection map (wet tarmac, paint, metal), from a part-cloudy
  // sky. It dims as the storm rolls in rather than swapping maps, which
  // would make the whole scene's lighting jump.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  // Reflections use the sky without the sun, or its warm glow tints
  // everything that reflects (the sun itself comes from the light).
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat.clone());
  const envU = envSky.material.uniforms;
  envU.uSun.value.set(0, -1, 0);
  envScene.add(envSky);
  envU.uCloud.value = 0.35;
  envU.uHorizon.value.copy(CLEAR.fog).lerp(STORM.fog, 0.35);
  envU.uZenith.value.copy(CLEAR.zenith).lerp(STORM.zenith, 0.35);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.55;

  // ---------------------------------------------------------------- state
  const state = { cloud: 0, wet: 0, night: 0, flash: 0, rain: 1 };
  const lerp = (a, b, t) => a + (b - a) * t;
  const ramp = (a, b, v) => {
    const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const tmp = new THREE.Color();
  const sunDir = new THREE.Vector3();
  return {
    sun,
    SUN_DIR,
    get wet() {
      return state.wet;
    },
    get cloud() {
      return state.cloud;
    },
    get night() {
      return state.night;
    },
    // Night follows the race directly (it is already a smooth ramp).
    setNight(n) {
      state.night = n;
    },
    // Graphics tier: shadows on/off and their sharpness, and how much rain.
    setQuality({ shadows, shadowSize, rain }) {
      sun.castShadow = shadows;
      if (sun.shadow.mapSize.x !== shadowSize) {
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
        sun.shadow.mapSize.set(shadowSize, shadowSize);
      }
      state.rain = rain;
    },
    // A lightning flash: the whole scene lights up for a moment.
    flash() {
      state.flash = 0.25;
    },
    // Ease towards the target weather (it rolls in over several seconds).
    set(cloud, wet, dt) {
      const k = Math.min(dt * 0.25, 1);
      state.cloud += (cloud - state.cloud) * k;
      state.wet += (wet - state.wet) * k;
    },
    // focuses: one point per camera (rain follows it); shadowFocus: where the
    // shadow map is centred.
    update(dt, time, focuses, shadowFocus) {
      const { cloud, wet, night } = state;
      // Sunset: the sun sinks to the horizon, warming and fading; once it
      // has set, the light swaps over to a dim blue moon. The swap happens
      // with the light almost off, so the shadows don't visibly jump.
      const sinking = Math.min(night / SUN_SWAP, 1);
      const dusk = ramp(0, 0.45, night) * (1 - ramp(0.55, 0.95, night)); // warm, peaks mid-sunset
      const dark = ramp(0.4, 1, night);
      sunDir.copy(SUN_DIR);
      sunDir.y = lerp(SUN_DIR.y, 0.03, ramp(0, 1, sinking));
      sunDir.normalize();
      const moonUp = ramp(SUN_SWAP, 1, night);
      const lightDir = night < SUN_SWAP ? sunDir : MOON_DIR;
      skyMat.uniforms.uSun.value.copy(sunDir);
      skyMat.uniforms.uSunCol.value.setRGB(1, 0.8, 0.55).lerp(DUSK.sun, ramp(0, 0.6, night));
      skyMat.uniforms.uCloud.value = cloud;
      skyMat.uniforms.uNight.value = night;
      if (night < SUN_SWAP) {
        sun.intensity = lerp(CLEAR.sun, STORM.sun, cloud) * (1 - ramp(0.3, SUN_SWAP, night));
        sun.color.copy(SUN_COLOR).lerp(DUSK.sun, ramp(0.05, 0.55, night) * 0.85);
      } else {
        sun.intensity = NIGHT.moonI * moonUp * (1 - 0.6 * cloud);
        sun.color.copy(NIGHT.moon);
      }
      state.flash = Math.max(0, state.flash - dt);
      hemi.intensity = lerp(CLEAR.hemi, STORM.hemi, cloud) * lerp(1, 0.5, dark) + (state.flash > 0.12 || (state.flash > 0 && state.flash < 0.06) ? 3 : 0);
      hemi.color.copy(HEMI_SKY).lerp(tmp.set(0x6074a8), dark);
      hemi.groundColor.copy(HEMI_GROUND).lerp(tmp.set(0x1a2016), dark);

      // Sky and fog: day (clear..storm), warmed at sunset, then night.
      const horizon = skyMat.uniforms.uHorizon.value.copy(CLEAR.fog).lerp(STORM.fog, cloud);
      const zenith = skyMat.uniforms.uZenith.value.copy(CLEAR.zenith).lerp(STORM.zenith, cloud);
      horizon.lerp(DUSK.fog, dusk * 0.85).lerp(NIGHT.fog, dark);
      zenith.lerp(DUSK.zenith, dusk * 0.6).lerp(NIGHT.zenith, dark);
      scene.fog.color.copy(horizon);
      scene.fog.near = lerp(CLEAR.near, STORM.near, wet);
      scene.fog.far = lerp(CLEAR.far, STORM.far, wet);
      if (scene.background?.isColor) scene.background.copy(scene.fog.color);
      scene.environmentIntensity = lerp(0.6, 0.35, cloud) * lerp(1, 0.15, dark);
      if (sun.castShadow) sun.shadow.intensity = lerp(1, 0.35, cloud) * (night < SUN_SWAP ? 1 : 0.6);
      stars.visible = dark > 0.01;
      starMat.opacity = ramp(0.55, 1, night) * (1 - cloud * 0.9);

      // Shadows follow the action.
      if (shadowFocus) {
        sun.target.position.copy(shadowFocus);
        sun.position.copy(shadowFocus).addScaledVector(lightDir, 150);
      }

      // Clouds drift with the wind and wrap round; storm clouds fade in.
      // At sunset their undersides glow, then they go dark against the stars.
      const tone = lerp(1, 0.42, cloud);
      tmp.setScalar(tone).lerp(DUSK.sun, dusk * 0.5).multiplyScalar(lerp(1, 0.08, dark));
      for (const c of clouds) {
        c.s.position.x = c.base.x + ((time * c.speed + c.base.z) % 900) - 450;
        const show = c.storm ? Math.max(0, (cloud - 0.25) / 0.6) : 1;
        c.s.material.opacity = Math.min(1, show) * lerp(0.85, 0.95, cloud);
        c.s.material.color.copy(tmp);
      }

      // Rain around each camera.
      rains.forEach((r, n) => {
        const f = focuses[n];
        r.lines.visible = !!f && wet > 0.02;
        if (!r.lines.visible) return;
        r.lines.material.opacity = Math.min(1, wet * 1.2) * 0.55;
        const shown = Math.floor(r.drops.length * wet * state.rain);
        for (let i = 0; i < r.drops.length; i++) {
          const d = r.drops[i];
          d.y -= d.v * dt;
          d.x += WIND.x * dt;
          d.z += WIND.z * dt;
          if (d.y < -4) {
            d.y = 28 + Math.random() * 6;
            d.x = (Math.random() - 0.5) * 70;
            d.z = (Math.random() - 0.5) * 70;
          }
          const o = i * 6;
          if (i >= shown) {
            r.pos.fill(0, o, o + 6);
            continue;
          }
          const x = f.x + d.x;
          const y = f.y + d.y;
          const z = f.z + d.z;
          r.pos[o] = x;
          r.pos[o + 1] = y;
          r.pos[o + 2] = z;
          r.pos[o + 3] = x - WIND.x * 0.04;
          r.pos[o + 4] = y + 0.9;
          r.pos[o + 5] = z - WIND.z * 0.04;
        }
        r.lines.geometry.attributes.position.needsUpdate = true;
      });
    },
  };
}
