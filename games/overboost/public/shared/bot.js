/*
 * Overboost bots. Used by the server to backfill matches and by the client for offline play.
 * A bot only writes to its car's input, exactly like a player would.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sim.js'));
  else root.OBBot = factory(root.OBSim);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  var SKILLS = { novice: 0.1, rookie: 0.25, pro: 0.6, elite: 0.95 };
  // cosmetics: how many car bodies and trim colours exist (the renderer owns what they look like)
  var LOOKS = { bodies: 5, trims: 8 };
  function cleanLook(l) {
    var b = l && l[0] | 0, t = l && l[1] | 0;
    return [b >= 0 && b < LOOKS.bodies ? b : 0, t >= 0 && t < LOOKS.trims ? t : 0];
  }
  function randomLook(rand) { rand = rand || Math.random; return [(rand() * LOOKS.bodies) | 0, (rand() * LOOKS.trims) | 0]; }
  var NAMES = ['Bolt', 'Nitro', 'Gizmo', 'Piston', 'Sparks', 'Diesel', 'Torque', 'Clutch', 'Axle', 'Rivet', 'Cog', 'Gasket',
    'Throttle', 'Camber', 'Dynamo', 'Ratchet', 'Skid', 'Fender', 'Chassis', 'Hubcap', 'Wrench', 'Slick'];
  var GROUND_Z = 135;     // a ball centre below this can be hit without leaving the ground

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ball prediction shared by every bot in a world
  function shared(w) {
    var sh = w._bots || (w._bots = { tick: -999, pts: [], scorer: -1 });
    if (w.tick - sh.tick >= 8 || w.tick < sh.tick) { sh.scorer = S.predictBall(w, sh.pts, 3.4, 60); sh.tick = w.tick; }
    return sh;
  }

  function Bot(skill, seed) {
    this.skill = typeof skill === 'number' ? skill : (SKILLS[skill] || 0.6);
    this.seed = (seed || 1) * 7919 + 13;
    this.interval = Math.round(46 - 41 * this.skill);        // ticks between decisions: rookies react slowly
    this.thinkIn = 1 + (this.seed % this.interval);
    this.mode = 'idle';
    this.tx = 0; this.ty = 0; this.tz = 0; this.eta = 0; this.sx = 0; this.sy = 1;
    this.useBoost = true; this.committed = false;
    this.seq = null; this.seqI = 0; this.seqN = 0;
    this.stuck = 0; this.unstick = 0; this.kickDelay = 0; this.wasKickoff = false;
  }
  Bot.prototype.rand = function () { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; };

  Bot.prototype.decide = function (w, idx, sh) {
    var c = w.cars[idx], b = w.ball, cars = w.cars, i, o, t;
    var dir = c.team === 0 ? 1 : -1, ownY = -dir * S.HY, oppY = dir * S.HY;
    var skill = this.skill;
    this.useBoost = this.rand() < skill * 1.3 - 0.15;

    // --- kickoff
    var kickoff = Math.abs(b.px) < 2 && Math.abs(b.py) < 2 && Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.vz) < 12;
    if (kickoff && !this.wasKickoff) this.kickDelay = Math.round((1 - skill) * 70 * this.rand());
    this.wasKickoff = kickoff;

    // --- who goes for the ball? rank team-mates by a rough time-to-ball
    var myEta = 0, rank = 0, mates = 0;
    for (i = 0; i < cars.length; i++) {
      o = cars[i];
      if (o.team !== c.team || o.demoT > 0) continue;
      var dx = b.px - o.px, dy = b.py - o.py, d = Math.sqrt(dx * dx + dy * dy) || 1;
      var facing = (dx * o.fx + dy * o.fy) / d;
      var eta = d / 1600 + (1 - facing) * 0.35 + ((o.py - b.py) * dir > 0 ? 0.7 : 0);
      if (kickoff) eta = d / 1600 + i * 0.001;
      if (i === idx) myEta = eta;
      o._eta = eta; mates++;
    }
    for (i = 0; i < cars.length; i++) {
      o = cars[i];
      if (i === idx || o.team !== c.team || o.demoT > 0) continue;
      if (o._eta < myEta || (o._eta === myEta && i < idx)) rank++;
    }
    var threat = sh.scorer !== -1 && sh.scorer !== c.team;      // ball is heading into our net
    if (threat && rank === 1) rank = 0;

    if (rank === 0) {
      // --- intercept: the first spot on the predicted path where the ball is low enough and we can be there in time
      var pts = sh.pts, ip = null, last = null;
      var sp = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
      var vmax = (c.boost > 12 && this.useBoost ? 2050 : 1410) * (0.75 + 0.25 * skill);
      var vEst = Math.max(800, 0.4 * sp + 0.6 * vmax);
      for (i = 0; i < pts.length; i += 2) {
        var p = pts[i];
        if (p.z > GROUND_Z) continue;
        last = p;
        var px = p.x - c.px, py = p.y - c.py, pd = Math.sqrt(px * px + py * py) || 1;
        var turn = (1 - (px * c.fx + py * c.fy) / pd) * 0.45;
        if ((pd - 130) / vEst + turn <= p.t) { ip = p; break; }
      }
      if (!ip) ip = last || (pts.length ? pts[pts.length - 1] : { x: b.px, y: b.py, z: b.pz, t: 0.6 });
      if (kickoff) ip = { x: 0, y: 0, z: S.BALL_R, t: 0 };
      var ix = clamp(ip.x, -S.HX + 150, S.HX - 150), iy = clamp(ip.y, -S.HY + 150, S.HY - 150);

      // --- where should the ball go?
      var sx, sy;
      if (iy * dir < -2400 || threat) {
        // defending: clear it up-field and away from the middle
        sx = ix * 0.6 + (ix >= 0 ? 500 : -500); sy = (iy - ownY) + 900;
        if (dir < 0) sy = (iy - ownY) - 900;
      } else if (Math.abs(ix) > 2300 && (oppY - iy) * dir < 1700) {
        // deep in a corner: cut it back in front of goal rather than shooting from no angle
        sx = -ix; sy = (oppY - dir * 1100) - iy;
      } else {
        sx = clamp(ix * 0.25, -520, 520) - ix; sy = oppY - iy;
      }
      t = Math.sqrt(sx * sx + sy * sy) || 1; sx /= t; sy /= t;
      var err = (1 - skill) * 300;
      var ex = (this.rand() - 0.5) * err, ey = (this.rand() - 0.5) * err;

      // --- approach: get on the far side of the ball from the target, then drive through it
      var cx = ix - c.px, cy = iy - c.py, cd = Math.sqrt(cx * cx + cy * cy) || 1;
      var lineUp = (cx * sx + cy * sy) / cd;                 // 1 = car, ball and target in a straight line
      var lined = kickoff || lineUp > (this.committed ? 0.74 : 0.9);
      this.committed = lined;
      var tx, ty;
      if (lined) { tx = ix - sx * 55 + ex; ty = iy - sy * 55 + ey; }
      else {
        var back = clamp(cd * 0.55, 330, 1300);
        tx = ix - sx * back; ty = iy - sy * back;
        // would the straight run to that spot clip the ball? then go round it on our side
        var sxp = tx - c.px, syp = ty - c.py, sl = sxp * sxp + syp * syp || 1;
        var u = clamp((cx * sxp + cy * syp) / sl, 0, 1);
        var nx = cx - sxp * u, ny = cy - syp * u;
        if (skill > 0.4 && nx * nx + ny * ny < 330 * 330) {
          var side = (cx * sy - cy * sx) >= 0 ? -1 : 1;     // which side of the shot line we are on
          tx = ix + sy * side * 430 - sx * 120; ty = iy - sx * side * 430 - sy * 120;
        }
      }
      this.tx = clamp(tx, -S.HX + 280, S.HX - 280); this.ty = clamp(ty, -S.HY + 260, S.HY - 260);
      this.tz = ip.z; this.eta = ip.t; this.sx = sx; this.sy = sy;
      this.mode = kickoff ? 'kickoff' : 'attack';
      return;
    }

    // --- off-ball positions
    this.committed = false;
    if ((rank === 1 && mates >= 3) || (rank === 1 && b.py * dir > 0)) {
      // support: trail the play on the other side of the pitch
      this.tx = clamp(-b.px * 0.45, -2600, 2600);
      this.ty = clamp(b.py - dir * 2400, -S.HY + 700, S.HY - 700);
    } else {
      // last back: sit between ball and goal
      this.tx = clamp(b.px * 0.3, -750, 750);
      this.ty = ownY + dir * 520;
    }
    this.mode = 'position'; this.tz = 0; this.eta = 0;
    if (c.boost < 30) {
      // grab a pad that is roughly on the way
      var best = -1, bestD = 2400 * 2400;
      for (i = 0; i < S.PADS.length; i++) {
        if (w.pads[i] > 0) continue;
        var pad = S.PADS[i];
        if ((pad[1] - c.py) * dir > 700) continue;           // do not push up for boost
        var pdx = pad[0] - c.px, pdy = pad[1] - c.py, d2 = pdx * pdx + pdy * pdy;
        if (pad[2]) d2 *= 0.3;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      if (best >= 0) { this.tx = S.PADS[best][0]; this.ty = S.PADS[best][1]; this.mode = 'pad'; }
    }
  };

  Bot.prototype.startSeq = function (steps) { this.seq = steps; this.seqI = 0; this.seqN = 0; };

  Bot.prototype.recover = function (w, c, inp) {
    var wlx = c.wx * c.fx + c.wy * c.fy + c.wz * c.fz;
    var wly = c.wx * c.lx + c.wy * c.ly + c.wz * c.lz;
    if (c.uz < -0.2) inp.roll = c.lz >= 0 ? -1 : 1;
    else inp.roll = clamp(-c.lz * 4 - wlx * 0.5, -1, 1);
    inp.pitch = clamp(-c.fz * 4 + wly * 0.5, -1, 1);
    inp.throttle = 1;
    if (c.hullHit && c.uz < -0.3 && c.wheels < 3) inp.jump = (w.tick % 24) < 3;
  };

  Bot.prototype.update = function (w, idx) {
    var c = w.cars[idx], inp = c['in'], b = w.ball;
    inp.steer = inp.throttle = inp.pitch = inp.yaw = inp.roll = 0;
    inp.jump = inp.boost = inp.handbrake = false;
    if (w.phase !== S.PH_PLAY || c.demoT > 0) { this.seq = null; this.thinkIn = 1; return; }
    var sh = shared(w);

    // scripted button sequences (dodges)
    if (this.seq) {
      var st = this.seq[this.seqI];
      inp.jump = !!st.jump; inp.pitch = st.pitch || 0; inp.yaw = st.yaw || 0; inp.steer = st.yaw || 0;
      inp.throttle = 1;
      if (++this.seqN >= st.n) { this.seqN = 0; if (++this.seqI >= this.seq.length) this.seq = null; }
      if (this.seq && this.seqI === this.seq.length - 1 && c.onGround && !c.isJumping) this.seq = null;
      return;
    }

    if (--this.thinkIn <= 0) { this.thinkIn = this.interval; this.decide(w, idx, sh); }
    if (!c.onGround) { this.recover(w, c, inp); return; }
    if (this.kickDelay > 0) { this.kickDelay--; return; }

    var dx = this.tx - c.px, dy = this.ty - c.py, dz = S.REST_Z - c.pz;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var lf = dx * c.fx + dy * c.fy + dz * c.fz, ll = dx * c.lx + dy * c.ly + dz * c.lz;
    var ang = Math.atan2(-ll, lf), aa = Math.abs(ang);
    var speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy + c.vz * c.vz);
    var vf = c.vx * c.fx + c.vy * c.fy + c.vz * c.fz;
    var attack = this.mode === 'attack' || this.mode === 'kickoff';

    // unstick: back out if we have been pushing against something
    if (this.unstick > 0) { this.unstick--; inp.throttle = -1; inp.steer = ang > 0 ? -1 : 1; return; }
    if (speed < 45 && (attack || dist > 400)) { if (++this.stuck > 110) { this.stuck = 0; this.unstick = 60; } } else this.stuck = 0;

    if (this.mode === 'position' && dist < 320) {
      // hold position, nose towards the ball
      var bx = b.px - c.px, by = b.py - c.py;
      var a2 = Math.atan2(-(bx * c.lx + by * c.ly), bx * c.fx + by * c.fy);
      if (Math.abs(a2) > 0.5 && speed < 350) { inp.throttle = 0.4; inp.steer = a2 > 0 ? 1 : -1; }
      return;
    }

    inp.steer = clamp(ang * 2.8, -1, 1);
    inp.throttle = 1;
    if (aa > 1.7 && vf > 500) inp.handbrake = true;                 // swing the back round for big turns
    else if (aa > 0.9 && vf > 950) inp.throttle = 0;
    // on a wall: just point at the target and come down
    if (c.gnz < 0.6) { inp.handbrake = false; inp.throttle = 1; return; }

    if (this.skill < 0.4 && vf > 1150) inp.throttle = Math.min(inp.throttle, 0.25);      // rookies are not comfortable flat out
    else if (this.skill < 0.8 && vf > 1380 && !this.committed) inp.throttle = Math.min(inp.throttle, 0.6);
    if (attack) {
      var kick = this.mode === 'kickoff';
      if (!kick && !this.committed) {
        // lining up: do not arrive at the turn-in point too fast to make the turn
        if (dist < 650 && vf > 850 + dist * 0.6) inp.throttle = vf > 1500 ? -1 : 0;
        else if (aa < 0.25 && dist > 1400 && c.boost > 30 && this.useBoost && speed < 2200) inp.boost = true;
      } else {
        // driving through the ball: arrive when it does
        var left = this.eta - (w.tick - sh.tick) * S.DT;
        var need = dist / Math.max(left, 0.05);
        if (!kick && left > 0.5 && speed > need * 1.35 && dist > 300) inp.throttle = speed > need * 2 ? -0.5 : 0.15;
        else if (aa < 0.3 && c.boost > 0 && speed < 2250 && (kick || (this.useBoost && dist > 350))) inp.boost = true;
        if (aa > 0.5 && dist < 700 && vf > 700) inp.throttle = 0;
      }

      // dodge into the ball for a harder hit
      var bx2 = b.px - c.px, by2 = b.py - c.py, bd = Math.sqrt(bx2 * bx2 + by2 * by2);
      var ba = Math.atan2(-(bx2 * c.lx + by2 * c.ly), bx2 * c.fx + by2 * c.fy);
      var closing = vf - (b.vx * c.fx + b.vy * c.fy);
      var onLine = kick || (bx2 * this.sx + by2 * this.sy) / (bd || 1) > 0.72;
      if (this.skill > 0.35 && onLine && (this.committed || kick) && (this.skill > 0.8 || this.useBoost)) {
        if (b.pz < 170 && Math.abs(ba) < 0.28 && closing > 350 && bd < 285 + closing * 0.11) {
          this.startSeq([{ n: 3, jump: true }, { n: 2 }, { n: 2, jump: true, pitch: -1, yaw: clamp(ba * 2.5, -1, 1) }, { n: 70 }]);
          return;
        }
        // pop up for a ball that is dropping just in front of us
        if (this.skill > 0.8 && b.pz > 185 && b.pz < 400 && Math.abs(ba) < 0.3 && bd < 200 + closing * 0.26 && closing > 250 && b.vz < 200) {
          var hold = clamp(Math.round((b.pz - 120) / 13), 4, 24);
          this.startSeq([{ n: hold, jump: true }, { n: 3 }, { n: 2, jump: true, pitch: -1, yaw: clamp(ba * 2.5, -1, 1) }, { n: 80 }]);
          return;
        }
      }
    } else {
      if (dist < 900) inp.throttle = Math.min(inp.throttle, speed > dist * 1.5 ? 0 : 0.6);
      else if (dist > 2800 && c.boost > 40 && aa < 0.25 && this.useBoost) inp.boost = true;
    }
  };

  return { Bot: Bot, SKILLS: SKILLS, NAMES: NAMES, LOOKS: LOOKS, cleanLook: cleanLook, randomLook: randomLook };
});
