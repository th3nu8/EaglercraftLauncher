// Small synthesised sound set (no audio files): engine, boost, hits, pads, countdown, goal.
export class Sfx {
  constructor() { this.ctx = null; this.vol = 0.6; this.fxVol = 1; this.crowdVol = 0.7; this.engineOn = false; this.crowdOn = false; }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const c = this.ctx = new AC();
      this.out = c.createGain(); this.out.gain.value = this.vol; this.out.connect(c.destination);
      this.master = c.createGain(); this.master.gain.value = this.fxVol; this.master.connect(this.out);     // every effect below plays into this
      const len = c.sampleRate, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      // engine: two detuned saws through a low-pass
      this.eg = c.createGain(); this.eg.gain.value = 0;
      this.ef = c.createBiquadFilter(); this.ef.type = 'lowpass'; this.ef.frequency.value = 400;
      this.eo = [c.createOscillator(), c.createOscillator()];
      this.eo[0].type = 'sawtooth'; this.eo[1].type = 'square';
      for (const o of this.eo) { o.connect(this.ef); o.start(); }
      this.ef.connect(this.eg); this.eg.connect(this.master);
      // boost: filtered noise
      this.bg = c.createGain(); this.bg.gain.value = 0;
      const bf = c.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 1100; bf.Q.value = 0.6;
      const bs = c.createBufferSource(); bs.buffer = buf; bs.loop = true; bs.connect(bf); bf.connect(this.bg); this.bg.connect(this.master); bs.start();
      // crowd: a bed of filtered noise that swells when something happens
      this.cv = c.createGain(); this.cv.gain.value = this.crowdVol; this.cv.connect(this.out);
      this.cg = c.createGain(); this.cg.gain.value = 0;
      const cf = c.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 520; cf.Q.value = 0.35;
      const cf2 = c.createBiquadFilter(); cf2.type = 'lowpass'; cf2.frequency.value = 1700;
      const cs = c.createBufferSource(); cs.buffer = buf; cs.loop = true; cs.playbackRate.value = 0.7;
      cs.connect(cf); cf.connect(cf2); cf2.connect(this.cg); this.cg.connect(this.cv); cs.start();
    } catch (e) { this.ctx = null; }
  }
  setVolume(v) { this.vol = v; if (this.out) this.out.gain.value = v; }
  setEffects(v) { this.fxVol = v; if (this.master) this.master.gain.value = v; }
  setCrowdVolume(v) { this.crowdVol = v; if (this.cv) this.cv.gain.value = v; }
  // the stands are only full for matches
  crowd(on) {
    this.crowdOn = on;
    if (this.ctx) { const t = this.ctx.currentTime; this.cg.gain.cancelScheduledValues(t); this.cg.gain.setTargetAtTime(on ? 0.035 : 0, t, 0.4); }
  }
  cheer(k) {
    if (!this.ctx || !this.crowdOn) return;
    const t = this.ctx.currentTime, g = this.cg.gain;
    g.cancelScheduledValues(t); g.setTargetAtTime(0.035 + 0.3 * k, t, 0.09); g.setTargetAtTime(0.035, t + 0.5 + k, 0.9 + k);
  }

  engine(speed, throttle, boosting, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = 46 + speed * 0.052 + Math.abs(throttle) * 12;
    this.eo[0].frequency.setTargetAtTime(f, t, 0.05); this.eo[1].frequency.setTargetAtTime(f * 0.502, t, 0.05);
    this.ef.frequency.setTargetAtTime(260 + speed * 0.45, t, 0.08);
    this.eg.gain.setTargetAtTime(active ? 0.05 + Math.abs(throttle) * 0.03 : 0, t, 0.1);
    this.bg.gain.setTargetAtTime(active && boosting ? 0.16 : 0, t, 0.04);
  }

  tone(freq, dur, type = 'sine', gain = 0.2, slide = 0, delay = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }
  burst(dur, gain, freq, q = 0.8, delay = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  hit(k) { this.tone(150 - k * 60, 0.16 + k * 0.1, 'sine', 0.25 + k * 0.4, 0.5); this.burst(0.07 + k * 0.05, 0.12 + k * 0.3, 1600 + k * 1200, 0.7); }
  bounce(k) { this.tone(120, 0.12, 'sine', 0.06 + k * 0.2, 0.6); }
  jump() { this.burst(0.09, 0.12, 700, 1.2); }
  flip() { this.burst(0.16, 0.14, 1300, 0.9); }
  pad(big) { this.tone(big ? 420 : 660, big ? 0.28 : 0.1, 'triangle', 0.16, big ? 2.2 : 1.5); }
  beep(final) { this.tone(final ? 880 : 440, final ? 0.45 : 0.14, 'square', 0.12); }
  bump() { this.burst(0.12, 0.25, 500, 0.8); this.tone(90, 0.14, 'sine', 0.3, 0.6); }
  demo() { this.burst(0.7, 0.5, 300, 0.4); this.tone(70, 0.5, 'sine', 0.5, 0.4); }
  goal() {
    this.burst(1.1, 0.5, 240, 0.4); this.tone(60, 0.9, 'sine', 0.55, 0.5);
    [392, 494, 587, 784].forEach((f, i) => this.tone(f, 0.9, 'sawtooth', 0.07, 0, 0.12 + i * 0.07));
  }
  end() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.14, 0, i * 0.14)); }
}
