// Unified keyboard + gamepad input with per-frame edge detection.
// Booth hardware varies (keyboard, Xbox pad, USB wheel), so controls are
// mapped once here and games only ask for actions and axes.
const KEYS = {
  start: ['Enter', 'Space'],
  back: ['Escape'],
  action: ['Space', 'Enter'],
  alt: ['ShiftLeft', 'ShiftRight', 'KeyC', 'KeyQ'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
};

// Standard gamepad mapping button indices.
const PAD = {
  start: [0, 9],
  back: [8],
  action: [0],
  alt: [2, 3, 4, 5],
  left: [14],
  right: [15],
  up: [12],
  down: [13],
};

const DEADZONE = 0.18;

export class Input {
  constructor() {
    this.keys = new Set();
    this.prev = {};
    this.now = {};
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.typed = []; // letters typed this frame
    this.anyActivity = false;

    addEventListener('keydown', (e) => {
      // Typing a name into a text field isn't game input.
      if (e.target instanceof HTMLInputElement) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat && /^Key[A-Z]$/.test(e.code)) this.typed.push(e.code.slice(3));
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  update() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    this.prev = this.now;
    this.now = {};
    for (const action of Object.keys(KEYS)) {
      this.now[action] =
        KEYS[action].some((k) => this.keys.has(k)) ||
        pads.some((p) => PAD[action].some((b) => p.buttons[b]?.pressed));
    }

    this.stickY = 0; // up is positive
    for (const p of pads) {
      const y = p.axes[1] ?? 0;
      if (Math.abs(y) > DEADZONE) this.stickY = -y;
    }

    let steer = (this.now.right ? 1 : 0) - (this.now.left ? 1 : 0);
    let throttle = this.now.up ? 1 : 0;
    let brake = this.now.down ? 1 : 0;
    for (const p of pads) {
      const x = p.axes[0] ?? 0;
      if (Math.abs(x) > DEADZONE) steer = x;
      throttle = Math.max(throttle, p.buttons[7]?.value ?? 0);
      brake = Math.max(brake, p.buttons[6]?.value ?? 0);
      const y = p.axes[1] ?? 0;
      if (y < -0.5) throttle = Math.max(throttle, -y);
      if (y > 0.5) brake = Math.max(brake, y);
    }
    this.steer = Math.max(-1, Math.min(1, steer));
    this.throttle = throttle;
    this.brake = brake;

    this.anyActivity =
      Object.values(this.now).some(Boolean) || Math.abs(this.steer) > 0 || throttle > 0 || brake > 0;
  }

  // Call once per frame after update() consumers are done.
  endFrame() {
    this.typed.length = 0;
  }

  pressed(action) {
    return this.now[action] && !this.prev[action];
  }

  held(action) {
    return !!this.now[action];
  }

  // Stick or d-pad flicks for menus: -1, 0 or 1 on the frame it happens.
  menuX() {
    const stick = Math.abs(this.steer) > 0.6 ? Math.sign(this.steer) : 0;
    const flick = stick !== (this.prevStick ?? 0) ? stick : 0;
    this.prevStick = stick;
    if (this.pressed('left')) return -1;
    if (this.pressed('right')) return 1;
    return flick;
  }
}
