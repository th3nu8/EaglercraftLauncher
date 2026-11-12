// A running game on the client. Online sessions predict the whole world locally and roll back to each
// server snapshot; offline sessions (bots, free play, menu backdrop) are their own authority.
const S = window.OBSim, B = window.OBBot;
const DT = S.DT;

class Ent {
  constructor() {
    this.prev = new Float64Array(7); this.cur = new Float64Array(7); this.out = new Float64Array(7);
    this.off = new Float64Array([0, 0, 0, 0, 0, 0, 1]); this.before = new Float64Array(7);
    this.prev[6] = this.cur[6] = this.out[6] = 1;
  }
}
function readPose(o, a) { a[0] = o.px; a[1] = o.py; a[2] = o.pz; if (o.qw !== undefined) { a[3] = o.qx; a[4] = o.qy; a[5] = o.qz; a[6] = o.qw; } }
// o = a * b (quaternions stored at index 3..6 of 7-vectors, or plain 4-arrays with base 0)
function qmul(a, ai, b, bi, o, oi) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3], bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
const T4 = new Float64Array(4), T4b = new Float64Array(4);

export class Session {
  /**
   * opts.mode: 'online' | 'bots' | 'freeplay' | 'demo'
   * online:  opts.net, opts.start (server start message)
   * bots:    opts.size, opts.skill, opts.minutes, opts.name
   */
  constructor(opts) {
    this.mode = opts.mode; this.net = opts.net || null; this.onEvent = opts.onEvent || (() => {});
    this.acc = 0; this.alpha = 0; this.timeScale = 1; this.depthAvg = 2;
    this.pending = []; this.seq = 0; this.snap = null; this.gotSnap = false; this.depths = [2]; this.depthI = 0;
    this.ev = []; this.out = []; this.ended = false; this.rows = null;
    this.bots = []; this.tracker = null; this.ranked = false; this.size = 1; this.code = null;
    const names = B.NAMES.slice().sort(() => Math.random() - 0.5);

    if (this.mode === 'online') {
      const st = opts.start;
      this.players = st.players; this.me = st.you; this.size = st.size; this.ranked = st.ranked; this.code = st.code || null;
      this.world = S.createWorld({ mode: 'match', matchSeconds: st.seconds });
      for (const p of this.players) S.addCar(this.world, p.team);
      S.startMatch(this.world);
    } else if (this.mode === 'freeplay') {
      this.players = [{ name: opts.name || 'You', team: 0, bot: false }]; this.me = 0;
      this.world = S.createWorld({ mode: 'freeplay', unlimitedBoost: true });
      S.addCar(this.world, 0); S.startMatch(this.world);
      S.placeCar(this.world.cars[0], 0, -2200, Math.PI / 2);
    } else {
      const demo = this.mode === 'demo';
      const size = this.size = demo ? 2 : (opts.size || 2);
      this.players = []; this.me = demo ? -1 : 0;
      this.world = S.createWorld({ mode: 'match', matchSeconds: demo ? 36000 : (opts.minutes || 5) * 60, seed: (Math.random() * 256) | 0 });
      for (let i = 0; i < size * 2; i++) {
        const team = i % 2, human = !demo && i === 0;
        this.players.push({ name: human ? (opts.name || 'You') : names[i], team, bot: !human });
        S.addCar(this.world, team);
        this.bots.push(human ? null : new B.Bot(demo ? (i < 2 ? 'elite' : 'pro') : (opts.skill || 'pro'), 1 + ((Math.random() * 1e6) | 0)));
      }
      S.startMatch(this.world);
      if (demo) { this.world.phase = S.PH_PLAY; this.world.phaseT = 0; }
      this.tracker = new S.MatchTracker(this.world);
    }
    this.ents = this.world.cars.map(() => new Ent());
    this.ballEnt = new Ent();
    this.capture('cur'); this.capture('prev');
    this.myInput = S.makeInput();
    this.sendBuf = new ArrayBuffer(6 + 12 * S.INPUT_BYTES);
    this.newInputs = [];
  }

  capture(which) {
    const cars = this.world.cars;
    for (let i = 0; i < cars.length; i++) readPose(cars[i], this.ents[i][which]);
    readPose(this.world.ball, this.ballEnt[which]);
  }

  // ---- network input
  onSnapshot(dv) { this.snap = dv; }
  onServer(m) {
    if (m.t === 'stats') { this.rows = m.rows; return; }
    if (m.t === 'end') this.ended = true;
    this.onEvent(m);
  }

  applySnapshot() {
    const dv = this.snap, w = this.world; this.snap = null;
    const ack = dv.getUint32(1, true), depth = dv.getUint8(5);
    const ents = this.ents, n = ents.length;
    for (let i = 0; i < n; i++) ents[i].before.set(ents[i].cur);
    this.ballEnt.before.set(this.ballEnt.cur);
    S.decodeWorld(w, dv, 6);
    const pend = this.pending;
    while (pend.length && pend[0].seq <= ack) pend.shift();
    if (pend.length > 70) pend.splice(0, pend.length - 70);
    const mine = this.me >= 0 ? w.cars[this.me]['in'] : null;
    this.capture('prev');
    for (let k = 0; k < pend.length; k++) {
      if (k === pend.length - 1) this.capture('prev');
      if (mine) S.copyInput(mine, pend[k].inp);
      S.step(w, null);
    }
    this.capture('cur');
    if (!pend.length) this.capture('prev');
    // hide the correction: keep drawing where things were and ease the difference out
    for (let i = 0; i <= n; i++) {
      const e = i < n ? ents[i] : this.ballEnt, b = e.before, c = e.cur, o = e.off;
      const dx = b[0] - c[0], dy = b[1] - c[1], dz = b[2] - c[2];
      if (!this.gotSnap || dx * dx + dy * dy + dz * dz > 450 * 450) { o[0] = o[1] = o[2] = 0; o[3] = o[4] = o[5] = 0; o[6] = 1; continue; }
      o[0] += dx; o[1] += dy; o[2] += dz;
      if (i < n) {
        T4[0] = -c[3]; T4[1] = -c[4]; T4[2] = -c[5]; T4[3] = c[6];       // conj(after)
        qmul(b, 3, T4, 0, T4b, 0);                                       // before * conj(after)
        qmul(o, 3, T4b, 0, T4, 0);
        const l = Math.hypot(T4[0], T4[1], T4[2], T4[3]) || 1, s = T4[3] < 0 ? -1 / l : 1 / l;
        o[3] = T4[0] * s; o[4] = T4[1] * s; o[5] = T4[2] * s; o[6] = T4[3] * s;
      }
    }
    this.gotSnap = true;
    // pace our clock so the server's queue of our inputs only just avoids running dry
    const dh = this.depths; dh[this.depthI++ % 40] = depth;
    let mn = 255; for (let i = 0; i < dh.length; i++) if (dh[i] < mn) mn = dh[i];
    this.depthAvg += (depth - this.depthAvg) * 0.08;
    this.timeScale = 1 + Math.max(-0.02, Math.min(0.015, (1 - mn) * 0.008));
  }

  // ---- one simulation tick
  tick(input) {
    const w = this.world, ev = this.ev;
    ev.length = 0;
    this.capture('prev');
    if (this.mode === 'online') {
      const inp = S.makeInput(); S.copyInput(inp, input); S.quantizeInput(inp);
      const p = { seq: ++this.seq, inp };
      this.pending.push(p); this.newInputs.push(p);
      if (this.me >= 0) S.copyInput(w.cars[this.me]['in'], inp);
      S.step(w, ev);
      for (let i = 0; i < ev.length; i++) { const t = ev[i].t; if (t === 'touch' || t === 'bounce' || t === 'jump' || t === 'flip' || t === 'pad' || t === 'bump') this.onEvent(ev[i]); }
    } else {
      for (let i = 0; i < w.cars.length; i++) {
        if (this.bots[i]) this.bots[i].update(w, i);
        else if (i === this.me) { S.copyInput(w.cars[i]['in'], input); S.quantizeInput(w.cars[i]['in']); }
      }
      S.step(w, ev);
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i], t = e.t;
        if (t === 'touch' || t === 'bounce' || t === 'jump' || t === 'flip' || t === 'pad' || t === 'bump') this.onEvent(e);
      }
      if (this.tracker) {
        const out = this.out; out.length = 0;
        this.tracker.update(ev, out);
        for (let i = 0; i < out.length; i++) { if (out[i].t === 'end') this.ended = true; this.onEvent(out[i]); }
        if (w.tick % 60 === 0) this.rows = this.tracker.stats.map(s => [s.goals, s.assists, s.saves, s.shots, s.score, s.demos, -1]);
      } else {
        for (let i = 0; i < ev.length; i++) if (ev[i].t === 'goal') this.onEvent(Object.assign({ scorer: 0, assist: -1, own: false, score: w.score }, ev[i]));
      }
    }
  }
  update(dt, input) {
    if (this.snap) this.applySnapshot();
    if (this.ended && this.mode !== 'online') { this.blend(dt); return; }
    this.acc += Math.min(dt, 0.25) * this.timeScale;
    let n = 0;
    while (this.acc >= DT) {
      this.acc -= DT;
      if (n++ < 30) this.tick(input); else { this.acc = 0; break; }
    }
    if (n) this.capture('cur');
    this.alpha = this.acc / DT;
    if (this.mode === 'online' && this.newInputs.length) this.flushInputs();
    this.blend(dt);
  }

  flushInputs() {
    const list = this.newInputs, n = Math.min(list.length, 12), first = list[list.length - n];
    const dv = new DataView(this.sendBuf);
    dv.setUint8(0, 1); dv.setUint32(1, first.seq, true); dv.setUint8(5, n);
    for (let i = 0; i < n; i++) S.encodeInput(list[list.length - n + i].inp, dv, 6 + i * S.INPUT_BYTES);
    this.net.sendBinary(this.sendBuf.slice(0, 6 + n * S.INPUT_BYTES));
    list.length = 0;
  }

  // interpolate between the last two ticks and add the fading correction offsets
  blend(dt) {
    const a = this.alpha, k = Math.exp(-dt * 14), n = this.ents.length;
    for (let i = 0; i <= n; i++) {
      const e = i < n ? this.ents[i] : this.ballEnt, p = e.prev, c = e.cur, o = e.off, out = e.out;
      o[0] *= k; o[1] *= k; o[2] *= k;
      let jump = Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]) + Math.abs(c[2] - p[2]) > 300 ? 1 : a;   // teleports are not interpolated
      out[0] = p[0] + (c[0] - p[0]) * jump + o[0]; out[1] = p[1] + (c[1] - p[1]) * jump + o[1]; out[2] = p[2] + (c[2] - p[2]) * jump + o[2];
      if (i === n) break;
      // nlerp rotation
      let s = p[3] * c[3] + p[4] * c[4] + p[5] * c[5] + p[6] * c[6] < 0 ? -1 : 1;
      T4[0] = p[3] + (c[3] * s - p[3]) * jump; T4[1] = p[4] + (c[4] * s - p[4]) * jump; T4[2] = p[5] + (c[5] * s - p[5]) * jump; T4[3] = p[6] + (c[6] * s - p[6]) * jump;
      o[3] *= k; o[4] *= k; o[5] *= k; o[6] = o[6] * k + (1 - k);
      let l = Math.hypot(o[3], o[4], o[5], o[6]) || 1; o[3] /= l; o[4] /= l; o[5] /= l; o[6] /= l;
      qmul(o, 3, T4, 0, out, 3);
      l = Math.hypot(out[3], out[4], out[5], out[6]) || 1; out[3] /= l; out[4] /= l; out[5] /= l; out[6] /= l;
    }
  }

  // free play helpers
  resetBall(toss) {
    if (this.mode !== 'freeplay') return;
    const w = this.world, b = w.ball, c = w.cars[0];
    S.resetBall(b); w.ballOn = true; if (w.phase !== S.PH_PLAY) { w.phase = S.PH_PLAY; w.phaseT = 0; }
    if (toss) {
      b.px = S.clamp(c.px + c.fx * 1400, -3200, 3200); b.py = S.clamp(c.py + c.fy * 1400, -4300, 4300); b.pz = 300;
      b.vx = -c.fx * 500; b.vy = -c.fy * 500; b.vz = 900;
    }
  }
}
