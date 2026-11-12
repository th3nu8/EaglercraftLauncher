// Training drills, headless. Run: node test/drill-test.js
const S = require('../public/shared/sim.js');
const D = require('../public/shared/drills.js');
const { Bot } = require('../public/shared/bot.js');
let failures = 0;
const check = (name, ok, extra) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const seeds = n => Array.from({ length: n }, (_, i) => ((i + 1) * 2654435761) >>> 0);
const RATINGS = [300, 600, 900, 1200, 1500, 1800, 2200];

// play one drill: with a bot at the wheel, or with nobody (skill null). Returns true when the drill is passed.
function play(kind, rating, seed, skill) {
  const w = S.createWorld({ mode: 'freeplay' }); S.addCar(w, 0); S.startMatch(w);
  const d = D.make(kind, rating, seed); D.load(w, d);
  const bot = skill ? new Bot(skill, seed % 1000 + 1) : null, ev = [];
  for (let t = 0, i = 0; i < 120 * 14; i++) {
    if (bot) bot.update(w, 0);
    ev.length = 0; S.step(w, ev);
    if (w.phase !== S.PH_COUNTDOWN) t += S.DT;
    for (const e of ev) if (e.t === 'goal') return kind === 'shooter' ? e.team === 0 : e.team !== 1;
    if (!Number.isFinite(w.ball.px + w.cars[0].px)) return null;
    if (t >= d.time) return kind === 'keeper';
  }
  return kind === 'keeper';
}
const rate = (kind, rating, skill, n) => seeds(n).filter(s => play(kind, rating, s, skill)).length / n;

// --- every drill is well formed
let bad = 0, offTarget = 0, selfScoring = 0, total = 0, shortest = 9, same = true;
for (const kind of D.KINDS) for (const r of RATINGS) for (const s of seeds(40)) {
  const d = D.make(kind, r, s), e = D.make(kind, r, s); total++;
  if (JSON.stringify(d) !== JSON.stringify(e)) same = false;
  const inside = S.sdf(d.ball.px, d.ball.py, d.ball.pz) >= S.BALL_R - 0.01 && S.sdf(d.car.x, d.car.y, S.REST_Z) > 10;
  if (!inside || !(d.time >= 3 && d.time <= 12) || !(d.car.boost >= 30 && d.car.boost <= 100) || !Number.isFinite(d.car.yaw)) bad++;
  const who = D.untouched(d.ball, 8);
  if (kind === 'keeper') { if (who !== 1) offTarget++; shortest = Math.min(shortest, d.arrives); }
  else if (who === 0) selfScoring++;
}
check('the same seed always builds the same drill', same);
check('every drill starts inside the arena with sane numbers', bad === 0, `${bad} bad of ${total}`);
check('every keeper shot is on target', offTarget === 0, `${offTarget} off target`);
check('keeper shots leave time to react', shortest >= 1.05, `fastest arrives after ${shortest.toFixed(2)} s`);
check('no shooter drill scores itself', selfScoring === 0, `${selfScoring}`);

// --- difficulty tracks the rating
check('doing nothing never passes a shooter drill', rate('shooter', 300, null, 30) === 0 && rate('shooter', 1500, null, 30) === 0);
check('doing nothing never passes a keeper drill', rate('keeper', 300, null, 30) === 0 && rate('keeper', 1500, null, 30) === 0);
const sh = [300, 1100, 1900].map(r => rate('shooter', r, 'elite', 40)), kp = [300, 1100, 1900].map(r => rate('keeper', r, 'elite', 40));
check('shooter drills get harder with rating', sh[0] >= 0.9 && sh[0] > sh[1] && sh[1] > sh[2] && sh[2] < 0.5, 'elite bot scores ' + sh.map(v => Math.round(v * 100) + '%').join(' / '));
check('keeper drills get harder with rating', kp[0] >= 0.9 && kp[0] >= kp[1] && kp[1] > kp[2] && kp[2] < 0.5, 'elite bot saves ' + kp.map(v => Math.round(v * 100) + '%').join(' / '));

// --- ratings
const up = D.rate(700, 700, true), down = D.rate(700, 700, false), easy = D.rate(1200, 600, true), hard = D.rate(600, 1200, true);
check('a pass raises the rating and a miss lowers it', up.delta > 0 && down.delta < 0 && up.rating === 700 + up.delta);
check('hard drills are worth more than easy ones', hard.delta > up.delta && up.delta > easy.delta && easy.delta >= 1, `${hard.delta} / ${up.delta} / ${easy.delta}`);
check('ratings stay in range', D.rate(D.MIN, 2000, false).rating === D.MIN && D.rate(D.MAX, 300, true).rating === D.MAX);
let near = true; for (let i = 0; i < 200; i++) { const d = D.pick('shooter', 1000); if (Math.abs(d.rating - 1000) > 131) near = false; }
check('served drills stay near the player\'s rating', near);

console.log(failures ? `\n${failures} drill check(s) failed` : '\nall drill checks passed');
process.exit(failures ? 1 : 0);
