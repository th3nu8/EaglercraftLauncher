/*
 * Overboost training drills: one car, one ball, one job.
 *   shooter - the ball is served somewhere in the attacking half; put it in the net before time runs out
 *   keeper  - a shot is on its way to your net; keep it out
 * Every drill has a rating (how hard it is) and is built from a seed, so "retry" serves the exact same ball.
 * The player has a rating per drill type that moves, Elo style, on the first attempt at each drill.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'));
  else root.OBDrill = factory(root.OBSim);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  var MIN = 300, MAX = 2200, START = 700, K = 32;
  var KINDS = ['shooter', 'keeper'];
  var TIERS = [[1900, 'Legend'], [1600, 'Elite'], [1350, 'Diamond'], [1150, 'Platinum'], [950, 'Gold'], [750, 'Silver'], [550, 'Bronze'], [0, 'Rookie']];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function tier(r) { for (var i = 0; i < TIERS.length; i++) if (r >= TIERS[i][0]) return TIERS[i][1]; return 'Rookie'; }
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) / 16777216; };
  }
  function ballAt(x, y, z, vx, vy, vz) { return { px: x, py: y, pz: z, vx: vx, vy: vy, vz: vz, wx: 0, wy: 0, wz: 0 }; }

  var probe = null, path = [];
  // where does this ball end up if nobody touches it? returns the scoring team (-1 for none), time in PT
  var PT = 0;
  function untouched(ball, seconds) {
    if (!probe) probe = S.createWorld({ mode: 'freeplay' });
    var b = probe.ball, k;
    for (k in ball) b[k] = ball[k];
    probe.ballOn = true;
    var who = S.predictBall(probe, path, seconds, 60);
    PT = path.length / 60;
    return who;
  }

  function shooter(rating, seed) {
    var r = rng(seed), d = clamp((rating - MIN) / (MAX - MIN), 0, 1);
    var goalDist = 1500 + r() * 1500 + d * 900;
    var bx = clamp((r() * 2 - 1) * (300 + d * 2700), -3300, 3300), by = S.HY - goalDist;
    var bz = S.BALL_R + 1.5, vz = 0;
    if (r() < (d - 0.3) * 1.2) { bz = S.BALL_R + 150 + r() * d * 700; vz = (r() * 2 - 1) * 300 + d * 300; }
    else if (r() < d * 0.8) vz = 250 + r() * d * 700;
    var roll = d * (200 + r() * 1100), ra = r() * Math.PI * 2;
    var ball = ballAt(bx, by, bz, Math.cos(ra) * roll, Math.sin(ra) * roll * 0.6, vz);
    // the car starts on the far side of the ball from the net, a little off line and not quite facing it
    var ux = bx, uy = by - S.HY, ul = Math.sqrt(ux * ux + uy * uy) || 1; ux /= ul; uy /= ul;
    var off = (r() * 2 - 1) * d * 1.1, cs = Math.cos(off), sn = Math.sin(off);
    var carDist = 700 + r() * 700 + d * 500;
    var cx = clamp(bx + (ux * cs - uy * sn) * carDist, -3600, 3600);
    var cy = clamp(by + (ux * sn + uy * cs) * carDist, -S.HY + 500, S.HY - 700);
    var yaw = Math.atan2(by - cy, bx - cx) + (r() * 2 - 1) * d * 1.0;
    var time = (4.2 - 1.4 * d) + (goalDist + carDist) / 1200 * (1.4 - 0.5 * d);
    return {
      kind: 'shooter', rating: rating, seed: seed, time: Math.round(time * 10) / 10,
      car: { x: cx, y: cy, yaw: yaw, boost: Math.round(100 - d * 55 * r()) }, ball: ball
    };
  }

  function keeper(rating, seed) {
    var d = clamp((rating - MIN) / (MAX - MIN), 0, 1), G = S.GRAVITY;
    var minT = 1.1 + (1 - d) * 1.3;
    for (var attempt = 0; attempt < 40; attempt++) {
      var r = rng(seed + attempt * 7919);
      var tx = (r() * 2 - 1) * (S.GW - 140) * (0.35 + 0.65 * d);
      var tz = S.BALL_R + r() * (S.GH - S.BALL_R - 130) * d, ty = -S.HY - 100;
      var oy = -S.HY + 2600 + r() * 2200, ox = (r() * 2 - 1) * (800 + d * 2400);
      var oz = S.BALL_R + 1.5;
      var lob = r() < (d - 0.35) * 1.3;                          // only the harder drills come through the air
      if (lob && r() < 0.5) oz = S.BALL_R + r() * 500;
      var speed = 1300 + d * 1900 + r() * 300;
      var dist = Math.sqrt((tx - ox) * (tx - ox) + (ty - oy) * (ty - oy)), T = dist / speed;
      var vz = lob ? (tz - oz) / T + 0.5 * G * T : r() * d * 220;   // the rest roll or skip along the grass
      var ball = ballAt(ox, oy, oz, (tx - ox) / T, (ty - oy) / T, vz);
      var cy = -S.HY + 200 + r() * 700, side = r() < 0.5 ? -1 : 1, yawOff = (r() * 2 - 1) * (0.3 + d * 1.5);
      if (untouched(ball, 7) !== 1 || PT < minT || PT > 5.5) continue;      // must be on target, and give a fair chance
      // start beside the ball's line, never on it, and never further off than the flight time allows
      var lineX = ox + (tx - ox) * (cy - oy) / (ty - oy);
      var cx = clamp(lineX + side * (220 + d * Math.min(700, (PT - 0.6) * 650)), -1500, 1500);
      var yaw = Math.PI / 2 + yawOff;
      return {
        kind: 'keeper', rating: rating, seed: seed, time: Math.round((PT + 2.2) * 10) / 10, arrives: PT,
        car: { x: cx, y: cy, yaw: yaw, boost: 100 }, ball: ball
      };
    }
    // could not find one (should not happen): a plain roll at the middle of the net
    return { kind: 'keeper', rating: rating, seed: seed, time: 5, arrives: 2.8, car: { x: 0, y: -S.HY + 500, yaw: Math.PI / 2, boost: 100 }, ball: ballAt(0, -S.HY + 4200, S.BALL_R + 1.5, 0, -1500, 0) };
  }

  function make(kind, rating, seed) {
    rating = Math.round(clamp(rating, MIN, MAX));
    return kind === 'keeper' ? keeper(rating, seed >>> 0) : shooter(rating, seed >>> 0);
  }
  // a drill near the player's level: sometimes a breather, sometimes a stretch
  function pick(kind, playerRating, rand) {
    rand = rand || Math.random;
    return make(kind, playerRating + (rand() - 0.5) * 260, (rand() * 4294967296) >>> 0);
  }

  // put a drill on the pitch (world made with mode 'freeplay' and one team-0 car)
  function load(w, drill) {
    var c = w.cars[0], b = w.ball, k;
    S.placeCar(c, drill.car.x, drill.car.y, drill.car.yaw);
    c.boost = drill.car.boost;
    for (k in drill.ball) b[k] = drill.ball[k];
    for (k = 0; k < w.pads.length; k++) w.pads[k] = 0;
    w.ballOn = true; w.phase = S.PH_COUNTDOWN; w.phaseT = 1;
  }

  // Elo step for the player after a first attempt
  function rate(player, drillRating, won) {
    var exp = 1 / (1 + Math.pow(10, (drillRating - player) / 400));
    var delta = Math.round(K * ((won ? 1 : 0) - exp));
    if (won && delta < 1) delta = 1;
    if (!won && delta > -1) delta = -1;
    var next = clamp(player + delta, MIN, MAX);
    return { rating: next, delta: next - player };
  }

  return { KINDS: KINDS, MIN: MIN, MAX: MAX, START: START, make: make, pick: pick, load: load, rate: rate, tier: tier, untouched: untouched };
});
