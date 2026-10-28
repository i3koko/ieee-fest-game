import * as THREE from 'three';

// Headlight beams for Jam Kart GP's night finish. Real spotlights cost a
// lot per kart (and adding them mid-race makes every material recompile),
// so instead the road and grass shaders light up a beam-shaped patch in front
// of each kart themselves: one loop over the eight karts per pixel.
const MAX = 8;
const uniforms = {
  uLampPos: { value: Array.from({ length: MAX }, () => new THREE.Vector4()) }, // xyz, w = brightness
  uLampDir: { value: Array.from({ length: MAX }, () => new THREE.Vector2(0, 1)) },
  uLampCol: { value: new THREE.Color(1, 0.9, 0.74) },
};

const GLSL = /* glsl */ `
  uniform vec4 uLampPos[${MAX}];
  uniform vec2 uLampDir[${MAX}];
  uniform vec3 uLampCol;
  varying vec3 vLampWorld;
  float headlights() {
    float sum = 0.0;
    for (int i = 0; i < ${MAX}; i++) {
      vec4 lp = uLampPos[i];
      if (lp.w <= 0.0) continue;
      vec3 d = vLampWorld - lp.xyz;
      vec2 f = uLampDir[i];
      float along = dot(d.xz, f);
      float across = abs(d.x * f.y - d.z * f.x);
      // A beam that widens ahead of the kart and fades out at ~40 m, plus a
      // little spill round the nose. Surfaces far above or below (another
      // part of the circuit) are left alone.
      float width = 1.1 + along * 0.3;
      float beam = (1.0 - smoothstep(width * 0.4, width, across)) * smoothstep(0.0, 2.5, along) * (1.0 - smoothstep(14.0, 38.0, along));
      float spill = (1.0 - smoothstep(1.5, 4.0, length(d.xz))) * 0.25;
      float level = 1.0 - smoothstep(1.5, 4.0, abs(d.y));
      sum += lp.w * (beam / (1.0 + max(along, 0.0) * 0.05) + spill) * level;
    }
    // Overlapping beams add up, but softly, so a pack of karts doesn't
    // burn the road white.
    return sum / (1.0 + 0.6 * sum);
  }
`;

// Adds the beams to a MeshStandardMaterial (keeping any shader changes it
// already has). `key` keeps its compiled program apart from other materials'.
export function litByHeadlights(mat, key) {
  const before = mat.onBeforeCompile;
  const beforeKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    before.call(mat, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLampWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvLampWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${GLSL}`).replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      float lamp = headlights();
      reflectedLight.directDiffuse += diffuseColor.rgb * uLampCol * lamp;
      reflectedLight.directSpecular += uLampCol * lamp * (1.0 - roughnessFactor) * 0.35;`
    );
  };
  mat.customProgramCacheKey = () => `headlights-${key}-${beforeKey()}`;
  mat.needsUpdate = true;
}

// Each frame: where every kart is, which way it faces, and how bright its
// lights are (0 in daylight).
export function updateHeadlights(karts, level) {
  karts.forEach((k, i) => {
    if (i >= MAX) return;
    uniforms.uLampPos.value[i].set(k.x, k.y, k.z, level);
    uniforms.uLampDir.value[i].set(Math.sin(k.h), Math.cos(k.h));
  });
}
