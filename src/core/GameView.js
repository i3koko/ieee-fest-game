import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Draws several cameras side by side into one frame (split screen), so the
// bloom that follows glows across the whole picture in a single pass.
class SplitPass extends Pass {
  constructor(scene, cameras) {
    super();
    this.scene = scene;
    this.cameras = cameras;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const { width: w, height: h } = readBuffer;
    const n = this.cameras.length;
    this.cameras.forEach((cam, i) => {
      const x = Math.round((i * w) / n);
      const cw = Math.round(((i + 1) * w) / n) - x;
      readBuffer.viewport.set(x, 0, cw, h);
      readBuffer.scissor.set(x, 0, cw, h);
      readBuffer.scissorTest = true;
      renderer.setRenderTarget(readBuffer);
      renderer.render(this.scene, cam);
    });
    readBuffer.viewport.set(0, 0, w, h);
    readBuffer.scissor.set(0, 0, w, h);
    readBuffer.scissorTest = false;
  }
}

// One WebGL renderer shared by every game, with a bloom pipeline so the
// neon parts glow.
export class GameView {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.composer = null;
    this.cameras = [];
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Pass an array of cameras for split screen (left to right).
  use(scene, cameras, { strength = 1.1, radius = 0.5, threshold = 0.2 } = {}) {
    this.composer?.dispose();
    this.cameras = [].concat(cameras);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(
      this.cameras.length > 1 ? new SplitPass(scene, this.cameras) : new RenderPass(scene, this.cameras[0])
    );
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), strength, radius, threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer?.setSize(innerWidth, innerHeight);
    for (const cam of this.cameras) {
      cam.aspect = innerWidth / this.cameras.length / innerHeight;
      cam.updateProjectionMatrix();
    }
  }

  render() {
    this.composer.render();
  }
}
