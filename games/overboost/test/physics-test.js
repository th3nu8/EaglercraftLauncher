// Headless physics checks against reference numbers. Run: node test/physics-test.js
const S = require('../public/shared/sim.js');
const DT = S.DT;
let failures = 0;
function check(name, value, lo, hi, unit) {
  const ok = value >= lo && value <= hi;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${typeof value === 'number' ? (Math.abs(value) < 0.1 && value !== 0 ? value.toFixed(5) : value.toFixed(2)) : value}${unit || ''}  (expected ${lo}..${hi})`);
}
function world(opts) {
  const w = S.createWorld(Object.assign({ mode: 'freeplay', unlimitedBoost: true }, opts || {}));
  const c = S.addCar(w, 0);
  S.startMatch(w);
  w.ballOn = false;
  S.placeCar(c, 0, -2000, Math.PI / 2);
  return { w, c };
}
function run(w, seconds, fn) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { if (fn && fn(i * DT, i) === false) return i * DT; S.step(w); }
  return seconds;
}
const speed = c => Math.hypot(c.vx, c.vy, c.vz);

// --- rest
{
  const { w, c } = world();
  run(w, 2);
  check('rest height', c.pz, 16.5, 17.5);
  check('rest speed', speed(c), 0, 0.5);
  check('rest upright', c.uz, 0.9999, 1.0001);
}
// --- throttle
{
  const { w, c } = world();
  let t1400 = -1;
  run(w, 4, (t) => { c.in.throttle = 1; if (t1400 < 0 && speed(c) >= 1400) t1400 = t; });
  check('throttle top speed', speed(c), 1400, 1415);
  check('time to 1400 (throttle)', t1400, 1.9, 2.9, 's');
}
// --- boost
{
  const { w, c } = world();
  let t2300 = -1;
  run(w, 3, (t) => { c.in.throttle = 1; c.in.boost = true; if (t2300 < 0 && speed(c) >= 2299) t2300 = t; });
  check('boost top speed', speed(c), 2295, 2300.01);
  check('time to 2300 (boost)', t2300, 1.5, 2.0, 's');
}
// --- braking
{
  const { w, c } = world();
  run(w, 3, () => { c.in.throttle = 1; });
  const v0 = speed(c);
  const t = run(w, 2, () => { c.in.throttle = -1; return (c.vx * c.fx + c.vy * c.fy) > 0; });
  check('brake decel', v0 / t, 3000, 3600, ' uu/s^2');
}
// --- turning curvature vs speed
{
  const ref = [[300, 0.0052], [500, 0.00398], [1000, 0.00235], [1400, 0.0016], [1750, 0.0011], [2300, 0.00088]];
  for (const [target, k] of ref) {
    const { w, c } = world();
    S.placeCar(c, 0, 0, 0);
    let ks = [], vs = [];
    run(w, 5, (t) => {
      const v = speed(c);
      c.in.steer = 1;
      c.in.throttle = v < target ? 1 : (v > target + 30 ? 0 : 0.3);
      c.in.boost = target > 1400 && v < target;
      if (t > 3) { ks.push(Math.abs(c.wz) / Math.max(v, 1)); vs.push(v); }
    });
    const km = ks.reduce((a, b) => a + b, 0) / ks.length, vm = vs.reduce((a, b) => a + b, 0) / vs.length;
    check(`curvature @${target} (v=${vm.toFixed(0)})`, km, k * 0.8, k * 1.25);
  }
}
// --- powerslide keeps momentum while the nose swings round
{
  const { w, c } = world();
  run(w, 2, () => { c.in.throttle = 1; });
  const h0 = Math.atan2(c.fy, c.fx);
  run(w, 0.6, () => { c.in.throttle = 1; c.in.steer = 1; c.in.handbrake = true; });
  let dh = Math.abs(Math.atan2(c.fy, c.fx) - h0);
  check('powerslide heading change in 0.6s', dh * 180 / Math.PI, 70, 200, ' deg');
  check('powerslide speed kept', speed(c), 700, 1500);
}
// --- jumps
{
  let { w, c } = world();
  let apex = 0;
  run(w, 2, (t, i) => { c.in.jump = i < 1; apex = Math.max(apex, c.pz); });
  check('tap jump apex', apex, 60, 110);
  ({ w, c } = world()); apex = 0;
  run(w, 2, (t) => { c.in.jump = t < 0.25; apex = Math.max(apex, c.pz); });
  check('held jump apex', apex, 215, 260);
  ({ w, c } = world()); apex = 0;
  run(w, 3, (t) => { c.in.jump = t < 0.2 || (t > 0.22 && t < 0.3); apex = Math.max(apex, c.pz); });
  check('double jump apex', apex, 430, 540);
  check('lands upright', c.uz, 0.99, 1.001);
}
// --- front flip
{
  const { w, c } = world();
  run(w, 1.2, () => { c.in.throttle = 1; });
  const v0 = speed(c);
  let vmax = 0, landed = -1;
  run(w, 2.5, (t) => {
    c.in.throttle = 1;
    c.in.jump = t < 0.05 || (t > 0.1 && t < 0.15);
    c.in.pitch = (t > 0.1 && t < 0.15) ? -1 : 0;
    vmax = Math.max(vmax, Math.hypot(c.vx, c.vy));
    if (t > 0.3 && landed < 0 && c.onGround) landed = t;
  });
  check('flip speed gain', vmax - v0, 400, 620);
  check('flip lands on wheels', c.uz, 0.98, 1.001);
  check('flip air time', landed, 0.9, 1.6, 's');
}
// --- half flip (backflip + cancel) turns the car around
{
  const { w, c } = world();
  S.placeCar(c, 0, 0, Math.PI / 2);
  run(w, 1.6, (t) => {
    c.in.jump = t < 0.05 || (t > 0.1 && t < 0.15);
    c.in.pitch = (t > 0.1 && t < 0.15) ? 1 : (t >= 0.15 && t < 0.9 ? -1 : 0);   // back, then push forward to cancel
    c.in.roll = (t > 0.45 && t < 0.95) ? 1 : 0;
  });
  check('half flip reverses heading', c.fy, -1.001, -0.6);
}
// --- wall drive
{
  const { w, c } = world();
  S.placeCar(c, 1500, 0, 0);
  let maxZ = 0, minUp = 1;
  run(w, 4, () => { c.in.throttle = 1; c.in.boost = speed(c) < 1800; maxZ = Math.max(maxZ, c.pz); });
  check('drives up the side wall', maxZ, 1200, 2100);
}
{
  const { w, c } = world();
  S.placeCar(c, 1500, 0, 0);
  let maxZ = 0;
  run(w, 3.2, () => { c.in.throttle = 1; c.in.boost = true; maxZ = Math.max(maxZ, c.pz); });
  check('supersonic wall transition', maxZ, 1500, 2100);
}
// --- ball bounce
{
  const { w } = world();
  w.ballOn = true; const b = w.ball;
  b.px = 0; b.py = 0; b.pz = 1000; b.vx = b.vy = b.vz = 0;
  let apex = 0, bounced = false, prevVz = 0;
  run(w, 4, () => { if (prevVz < 0 && b.vz > 0) bounced = true; if (bounced) apex = Math.max(apex, b.pz); prevVz = b.vz; if (bounced && b.vz < 0 && prevVz < 0 && apex > 0 && b.pz < apex - 50) return false; });
  check('ball rebound height from 1000', apex - 91.25, 280, 345);
  run(w, 12);
  check('ball settles', Math.abs(b.vz), 0, 12);
  check('ball rest height', b.pz, 91, 92.5);
}
// --- ball rolls with matching spin
{
  const { w } = world();
  w.ballOn = true; const b = w.ball;
  b.px = 1500; b.py = -3000; b.pz = 93; b.vx = 0; b.vy = 1500; b.vz = 0;
  run(w, 2);
  check('sliding ball speed after 2s', b.vy, 880, 1080);
  check('ball spin capped', Math.abs(b.wx), 5.5, 6.1);
  b.px = 1500; b.py = -3000; b.pz = 92; b.vx = 0; b.vy = 400; b.vz = 0; b.wx = b.wy = b.wz = 0;
  run(w, 2);
  check('slow ball ends up rolling', Math.abs(b.wx) * 91.25 / Math.abs(b.vy), 0.97, 1.03);
  check('slow ball keeps rolling', b.vy, 250, 300);
}
// --- car hits ball
{
  const { w, c } = world();
  w.ballOn = true; const b = w.ball; S.resetBall(b);
  S.placeCar(c, 0, -2600, Math.PI / 2);
  let hitSpeed = 0, carBefore = 0;
  run(w, 4, () => { c.in.throttle = 1; if (b.vy === 0) carBefore = speed(c); if (!hitSpeed && Math.hypot(b.vx, b.vy) > 50) { hitSpeed = -1; } else if (hitSpeed === -1) { hitSpeed = Math.hypot(b.vx, b.vy, b.vz); return false; } });
  check('car speed at impact', carBefore, 1350, 1415);
  check('ball speed after 1400 hit', hitSpeed, 1500, 2300);
}
// --- dodge shot is harder than a drive-through
{
  const { w, c } = world();
  w.ballOn = true; const b = w.ball; S.resetBall(b);
  S.placeCar(c, 0, -2600, Math.PI / 2);
  let maxBall = 0;
  run(w, 4, () => {
    c.in.throttle = 1;
    const d = Math.hypot(b.px - c.px, b.py - c.py);
    const near = d < 350 && b.vy === 0;
    if (near && !c.hasJumped) c.in.jump = true;
    else if (c.hasJumped && !c.isJumping && !c.hasFlipped) { c.in.jump = true; c.in.pitch = -1; }
    else { c.in.jump = false; c.in.pitch = 0; }
    maxBall = Math.max(maxBall, Math.hypot(b.vx, b.vy, b.vz));
  });
  check("dodge shot ball speed", maxBall, 2200, 3600);
}
// --- goal + kickoff flow
{
  const w = S.createWorld({ mode: 'match', matchSeconds: 60 });
  S.addCar(w, 0); S.addCar(w, 1);
  S.startMatch(w);
  const ev = [];
  run(w, 3.1, () => S.step(w, ev) && false);
  const b = w.ball;
  b.px = 100; b.py = 4000; b.pz = 200; b.vx = 0; b.vy = 3000; b.vz = 100;
  for (let i = 0; i < 240 && w.phase === S.PH_PLAY; i++) S.step(w, ev);
  check('goal scored for blue', w.score[0], 1, 1);
  check('goal phase', w.phase, S.PH_GOAL, S.PH_GOAL);
  for (let i = 0; i < 400; i++) S.step(w, ev);
  check('kickoff after goal', w.phase, S.PH_COUNTDOWN, S.PH_COUNTDOWN);
  check('events include goal', ev.filter(e => e.t === 'goal').length, 1, 1);
}
// --- post: ball clipping the post bounces out, not through
{
  const { w } = world();
  w.ballOn = true; const b = w.ball;
  b.px = S.GW + 30; b.py = 4500; b.pz = 300; b.vx = 0; b.vy = 2500; b.vz = 0;
  run(w, 1.0);
  check('ball off the wall beside the post stays out', b.py, -6000, S.HY);
  b.px = S.GW - 60; b.py = 4500; b.pz = 300; b.vx = 0; b.vy = 2500; b.vz = 0;
  let minY = 1e9;
  run(w, 0.5, () => { minY = Math.min(minY, b.py); });
  check('post hit deflects sideways', Math.abs(b.vx), 200, 4000);
}
// --- snapshot round trip
{
  const w = S.createWorld({ mode: 'match' });
  for (let i = 0; i < 6; i++) S.addCar(w, i % 2);
  S.startMatch(w);
  w.phase = S.PH_PLAY;
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const drive = () => { for (const c of w.cars) { const i = c.in; i.throttle = rnd() * 2 - 1; i.steer = rnd() * 2 - 1; i.pitch = rnd() * 2 - 1; i.yaw = i.steer; i.jump = rnd() < 0.3; i.boost = rnd() < 0.5; i.handbrake = rnd() < 0.2; S.quantizeInput(i); } };
  for (let i = 0; i < 600; i++) { if (i % 20 === 0) drive(); S.step(w); }
  const buf = new ArrayBuffer(S.snapshotSize(w)), dv = new DataView(buf);
  S.encodeWorld(w, dv, 0);
  const w2 = S.createWorld({ mode: 'match' });
  for (let i = 0; i < 6; i++) S.addCar(w2, i % 2);
  S.decodeWorld(w2, dv, 0);
  for (let i = 0; i < 24; i++) { S.step(w); S.step(w2); }
  let err = 0;
  for (let i = 0; i < 6; i++) err = Math.max(err, Math.hypot(w.cars[i].px - w2.cars[i].px, w.cars[i].py - w2.cars[i].py, w.cars[i].pz - w2.cars[i].pz));
  err = Math.max(err, Math.hypot(w.ball.px - w2.ball.px, w.ball.py - w2.ball.py, w.ball.pz - w2.ball.pz));
  check('resim from snapshot drift after 0.2s', err, 0, 3, ' uu');
}
// --- soak: random inputs, nothing escapes or explodes
{
  const w = S.createWorld({ mode: 'match', matchSeconds: 3000 });
  for (let i = 0; i < 6; i++) S.addCar(w, i % 2);
  S.startMatch(w);
  const rnd = (() => { let s = 99; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  let worst = 1e9, nan = false, maxV = 0, goals = 0;
  const ev = [];
  const t0 = Date.now(), N = 120 * 240;
  for (let i = 0; i < N; i++) {
    if (i % 30 === 0) for (const c of w.cars) {
      const inp = c.in;
      inp.throttle = rnd() < 0.8 ? 1 : -1; inp.steer = Math.round((rnd() * 2 - 1) * 2) / 2; inp.pitch = Math.round(rnd() * 2 - 1); inp.yaw = inp.steer; inp.roll = rnd() < 0.2 ? 1 : 0;
      inp.jump = rnd() < 0.25; inp.boost = rnd() < 0.6; inp.handbrake = rnd() < 0.15;
    }
    ev.length = 0;
    S.step(w, ev);
    for (const e of ev) if (e.t === 'goal') goals++;
    for (const c of w.cars) {
      if (!(c.px === c.px && c.qw === c.qw && c.vx === c.vx)) nan = true;
      if (c.demoT <= 0) worst = Math.min(worst, S.sdf(c.px, c.py, c.pz));
      maxV = Math.max(maxV, speed(c));
    }
    if (w.ballOn) worst = Math.min(worst, S.sdf(w.ball.px, w.ball.py, w.ball.pz) - 60);
    if (!(w.ball.px === w.ball.px)) nan = true;
  }
  const ms = Date.now() - t0;
  check('soak: no NaN', nan ? 1 : 0, 0, 0);
  check('soak: everything stays inside the arena', worst, -25, 1e9, ' uu');
  check('soak: speed cap respected', maxV, 0, 2600);
  console.log(`     soak: ${N} ticks, 6 cars in ${ms} ms (${(ms / N * 1000).toFixed(1)} us/tick), goals ${goals}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall physics checks passed');
process.exit(failures ? 1 : 0);
