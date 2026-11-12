// Bot-vs-bot matches, headless. Run: node test/bot-test.js
const S = require('../public/shared/sim.js');
const B = require('../public/shared/bot.js');
let seedState = 12345;
Math.random = () => (seedState = (seedState * 16807) % 2147483647) / 2147483647;   // repeatable kickoffs

function match(size, skillBlue, skillOrange, seconds, seed) {
  const w = S.createWorld({ mode: 'match', matchSeconds: seconds, seed });
  const bots = [];
  for (let i = 0; i < size * 2; i++) { S.addCar(w, i % 2); bots.push(new B.Bot(i % 2 === 0 ? skillBlue : skillOrange, seed * 31 + i)); }
  S.startMatch(w);
  const tr = new S.MatchTracker(w), ev = [], out = [];
  let ticks = 0, idle = 0, kickTicks = 0, kicks = 0, inKick = false, kStart = 0;
  while (w.phase !== S.PH_END && ticks < (seconds + 90) * 120) {
    for (let i = 0; i < bots.length; i++) bots[i].update(w, i);
    ev.length = 0; out.length = 0; S.step(w, ev); tr.update(ev, out); ticks++;
    for (const e of ev) {
      if (e.t === 'go') { inKick = true; kStart = w.tick; }
      if (e.t === 'touch' && inKick) { inKick = false; kickTicks += w.tick - kStart; kicks++; }
    }
    if (w.phase === S.PH_PLAY) for (const c of w.cars) if (Math.hypot(c.vx, c.vy, c.vz) < 20 && c.demoT <= 0) idle++;
  }
  const sum = k => tr.stats.reduce((a, s) => a + s[k], 0);
  return { score: w.score.slice(), touches: sum('touches'), shots: sum('shots'), saves: sum('saves'), kickoff: kicks ? kickTicks / kicks / 120 : 0, idle: idle / (ticks * size * 2) };
}

let failures = 0;
const check = (name, ok, extra) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${extra}`); };
for (const size of [1, 2, 3]) {
  const r = match(size, 'pro', 'pro', 180, 40 + size);
  check(`${size}v${size} pro bots play a real match`, r.score[0] + r.score[1] >= 1 && r.touches > 30 && r.idle < 0.2,
    `score ${r.score.join('-')}, ${r.touches} touches, ${r.shots} shots, ${r.saves} saves, kickoff reached in ${r.kickoff.toFixed(2)}s, idle ${(r.idle * 100).toFixed(1)}%`);
}
let strong = 0, weak = 0;
for (let k = 0; k < 6; k++) {
  const size = 1 + (k % 3), flip = k % 2;
  const sc = match(size, flip ? 'rookie' : 'elite', flip ? 'elite' : 'rookie', 150, 70 + k * 3).score;
  strong += flip ? sc[1] : sc[0]; weak += flip ? sc[0] : sc[1];
}
check('elite bots outscore rookie bots', strong > weak * 1.5, `${strong} goals to ${weak} over 6 matches`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall bot checks passed');
process.exit(failures ? 1 : 0);
