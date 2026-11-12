// Keyboard, mouse, gamepad and touch -> one input state per frame.
const S = window.OBSim;

export const ACTIONS = [
  ['forward', 'Accelerate, nose down in the air'], ['back', 'Brake and reverse, nose up in the air'],
  ['left', 'Steer left'], ['right', 'Steer right'],
  ['jump', 'Jump, press again to flip'], ['boost', 'Boost'], ['slide', 'Slide, air roll while held'],
  ['rollLeft', 'Air roll left'], ['rollRight', 'Air roll right'],
  ['ballCam', 'Ball cam on and off'], ['scoreboard', 'Scoreboard'], ['resetBall', 'Reset ball in free play']
];
const DEFAULTS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Mouse2'], boost: ['Mouse0', 'KeyX'], slide: ['ShiftLeft', 'ShiftRight'],
  rollLeft: ['KeyQ'], rollRight: ['KeyE'], ballCam: ['KeyC'], scoreboard: ['Tab'], resetBall: ['KeyR']
};
export const GAMEPAD_HELP = [
  ['Left stick', 'Steer, pitch and flip direction'], ['Right trigger', 'Accelerate'], ['Left trigger', 'Brake and reverse'],
  ['A', 'Jump'], ['B', 'Boost'], ['X', 'Slide and air roll'], ['Y', 'Ball cam'], ['Bumpers', 'Air roll left and right'], ['Start', 'Pause']
];
export const TOUCH_HELP = [
  ['Left thumb', 'Hold to drive, drag to steer, pull back to reverse'], ['Jump', 'Tap to jump, hold a direction and tap again to flip'],
  ['Boost', 'Hold to boost'], ['Slide', 'Hold while turning'], ['Cam', 'Ball cam on and off']
];

export function keyLabel(code) {
  if (!code) return 'Not set';
  if (code === 'Mouse0') return 'Left click';
  if (code === 'Mouse1') return 'Middle click';
  if (code === 'Mouse2') return 'Right click';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', 'Arrow ').replace('ShiftLeft', 'Left Shift').replace('ShiftRight', 'Right Shift').replace('ControlLeft', 'Left Ctrl').replace('AltLeft', 'Left Alt');
}

function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } }

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.active = false;           // true while a match has focus
    this.down = new Set();
    this.binds = Object.assign({}, JSON.parse(JSON.stringify(DEFAULTS)), store('ob.binds') || {});
    this.on = { ballCam() {}, pause() {}, chat() {}, reset() {}, any() {} };
    this.state = S.makeInput();
    this.scoreboard = false;
    this.touchMode = 'auto'; this.touchSeen = false;
    this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.tbtn = { jump: false, boost: false, slide: false };
    this.padPrev = [];
    this.listen = null;            // rebinding: { action, done }

    addEventListener('keydown', e => this.key(e, true));
    addEventListener('keyup', e => this.key(e, false));
    addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => this.down.clear());
    canvas.addEventListener('mousedown', e => this.mouse(e, true));
    addEventListener('mouseup', e => this.mouse(e, false));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.setupTouch();
  }

  key(e, isDown) {
    if (this.listen && isDown) { e.preventDefault(); if (e.code !== 'Escape') this.rebind(e.code); else this.listen.done(), this.listen = null; return; }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (isDown) this.on.any();
    if (e.code === 'Escape') { if (isDown && !e.repeat) this.on.pause(); return; }
    if (!this.active) return;
    if (isDown && !e.repeat) {
      if (this.binds.ballCam.includes(e.code)) this.on.ballCam();
      if (this.binds.resetBall.includes(e.code)) this.on.reset(e.shiftKey);
      if (/^Digit[1-8]$/.test(e.code)) this.on.chat(+e.code[5] - 1);
    }
    if (isDown) this.down.add(e.code); else this.down.delete(e.code);
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Quote' || e.code === 'Slash') e.preventDefault();
  }
  mouse(e, isDown) {
    const code = 'Mouse' + e.button;
    if (this.listen && isDown) { e.preventDefault(); this.rebind(code); return; }
    if (isDown) { this.on.any(); if (!this.active) return; this.down.add(code); e.preventDefault(); }
    else this.down.delete(code);
  }
  rebind(code) {
    const { action, done } = this.listen; this.listen = null;
    for (const a in this.binds) this.binds[a] = this.binds[a].filter(c => c !== code);
    this.binds[action] = [code].concat((this.binds[action] || []).slice(0, 1).filter(c => c !== code));
    store('ob.binds', this.binds); done();
  }
  resetBinds() { this.binds = JSON.parse(JSON.stringify(DEFAULTS)); store('ob.binds', this.binds); }
  is(action) { const b = this.binds[action]; for (let i = 0; i < b.length; i++) if (this.down.has(b[i])) return true; return false; }

  // ---- touch
  setupTouch() {
    const root = document.getElementById('touch'), stickEl = document.getElementById('stick'), nub = document.getElementById('stick-nub');
    const zone = document.createElement('div');
    zone.style.cssText = 'position:absolute;left:0;top:18%;bottom:0;width:46%;pointer-events:auto;touch-action:none';
    root.insertBefore(zone, root.firstChild);
    const st = this.stick, R = 56;
    const place = () => { nub.style.transform = `translate(${st.x * R}px, ${st.y * R}px)`; };
    zone.addEventListener('pointerdown', e => {
      if (st.id !== -1) return;
      st.id = e.pointerId; st.ox = e.clientX; st.oy = e.clientY; st.x = st.y = 0;
      stickEl.style.left = (e.clientX - 66) + 'px'; stickEl.style.top = (e.clientY - 66) + 'px'; stickEl.style.bottom = 'auto';
      zone.setPointerCapture(e.pointerId); place(); e.preventDefault();
    });
    zone.addEventListener('pointermove', e => {
      if (e.pointerId !== st.id) return;
      let x = (e.clientX - st.ox) / R, y = (e.clientY - st.oy) / R; const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      st.x = x; st.y = y; place();
    });
    const end = e => { if (e.pointerId !== st.id) return; st.id = -1; st.x = st.y = 0; place(); };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
    const hold = (id, key) => {
      const el = document.getElementById(id);
      el.addEventListener('pointerdown', e => { this.tbtn[key] = true; el.classList.add('on'); el.setPointerCapture(e.pointerId); e.preventDefault(); });
      const up = () => { this.tbtn[key] = false; el.classList.remove('on'); };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    };
    hold('tb-jump', 'jump'); hold('tb-boost', 'boost'); hold('tb-slide', 'slide');
    document.getElementById('tb-cam').addEventListener('pointerdown', e => { e.preventDefault(); this.on.ballCam(); });
    document.getElementById('tb-menu').addEventListener('pointerdown', e => { e.preventDefault(); this.on.pause(); });
    document.getElementById('tb-chat').addEventListener('pointerdown', e => { e.preventDefault(); this.on.chat(-1); });
    addEventListener('pointerdown', e => { if (e.pointerType === 'touch' && !this.touchSeen) { this.touchSeen = true; this.applyTouchMode(); } this.on.any(); }, true);
  }
  setTouchMode(m) { this.touchMode = m; this.applyTouchMode(); }
  get touchOn() { return this.touchMode === 'on' || (this.touchMode === 'auto' && this.touchSeen); }
  applyTouchMode() {
    document.body.classList.toggle('touch', this.touchOn);
    document.getElementById('touch').hidden = !this.touchOn;
  }

  // ---- sample
  sample() {
    const s = this.state;
    let steer = (this.is('right') ? 1 : 0) - (this.is('left') ? 1 : 0);
    let throttle = (this.is('forward') ? 1 : 0) - (this.is('back') ? 1 : 0);
    let pitch = -throttle;
    let roll = (this.is('rollRight') ? 1 : 0) - (this.is('rollLeft') ? 1 : 0);
    let jump = this.is('jump'), boost = this.is('boost'), slide = this.is('slide');
    this.scoreboard = this.is('scoreboard');

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i];
      if (!gp || !gp.connected || gp.buttons.length < 8) continue;
      const dz = v => Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86;
      const b = k => gp.buttons[k] ? gp.buttons[k].value || (gp.buttons[k].pressed ? 1 : 0) : 0;
      const ax = dz(gp.axes[0] || 0), ay = dz(gp.axes[1] || 0);
      if (ax) steer = ax;
      if (ay) pitch = ay;
      const t = b(7) - b(6); if (t) throttle = t;
      jump = jump || b(0) > 0.5; boost = boost || b(1) > 0.5; slide = slide || b(2) > 0.5;
      const r = (b(5) > 0.5 ? 1 : 0) - (b(4) > 0.5 ? 1 : 0); if (r) roll = r;
      if (b(8) > 0.5) this.scoreboard = true;
      const edge = (k, fn) => { const d = b(k) > 0.5; if (d && !this.padPrev[k]) { this.on.any(); fn(); } this.padPrev[k] = d; };
      if (this.active) { edge(3, () => this.on.ballCam()); edge(12, () => this.on.chat(0)); edge(13, () => this.on.chat(3)); edge(14, () => this.on.chat(2)); edge(15, () => this.on.chat(1)); }
      edge(9, () => this.on.pause());
      break;
    }
    // touch
    if (this.touchOn) {
      const st = this.stick;
      if (st.id !== -1) {
        steer = Math.abs(st.x) < 0.12 ? 0 : st.x;
        throttle = st.y > 0.5 ? -1 : 1;
        pitch = Math.abs(st.y) < 0.3 ? 0 : st.y;
      }
      jump = jump || this.tbtn.jump; boost = boost || this.tbtn.boost; slide = slide || this.tbtn.slide;
    }

    let yaw = steer;
    if (slide && !roll) { roll = steer; yaw = 0; }      // slide doubles as the air-roll modifier
    s.steer = steer; s.throttle = throttle; s.pitch = pitch; s.yaw = yaw; s.roll = roll;
    s.jump = jump; s.boost = boost; s.handbrake = slide;
    if (!this.active) { s.steer = s.throttle = s.pitch = s.yaw = s.roll = 0; s.jump = s.boost = s.handbrake = false; }
    return s;
  }
}
