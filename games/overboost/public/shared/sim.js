/*
 * Overboost shared simulation.
 * Runs unchanged on the server (authoritative) and in the browser (prediction / offline play).
 * Units: 1 uu ~ 1 cm. World axes: x across the pitch, y goal-to-goal, z up.
 * Car axes: x forward, y left, z up. Blue (team 0) defends -y, orange (team 1) defends +y.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OBSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TICK_RATE = 120;
  var DT = 1 / TICK_RATE;

  // ----------------------------------------------------------------- arena
  var HX = 4096, HY = 5120, HZ = 2044;
  var RC = 1400;            // plan-view corner radius
  var RF = 256;             // floor <-> wall ramp radius
  var RT = 256;             // wall <-> ceiling ramp radius
  var GW = 892.755, GH = 642.775, GD = 880; // goal half-width, height, depth

  // ----------------------------------------------------------------- ball
  var BALL_R = 91.25, BALL_MASS = 30;
  var BALL_MAX_SPEED = 6000, BALL_MAX_SPIN = 6, BALL_DRAG = 0.03;
  var BALL_REST = 0.6, BALL_MU = 0.35;
  var BALL_INV_I = 1 / (0.4 * BALL_MASS * BALL_R * BALL_R);
  var GRAVITY = 650;

  // ----------------------------------------------------------------- car
  var CAR_MASS = 180, INV_M = 1 / CAR_MASS;
  var HLX = 59.0, HLY = 42.1, HLZ = 18.08;      // hitbox half extents
  var HB_OX = 13.88, HB_OZ = 20.75;             // hitbox centre relative to centre of mass
  var INV_IX = 1 / (CAR_MASS / 3 * (HLY * HLY + HLZ * HLZ)); // roll
  var INV_IY = 1 / (CAR_MASS / 3 * (HLX * HLX + HLZ * HLZ)); // pitch
  var INV_IZ = 1 / (CAR_MASS / 3 * (HLX * HLX + HLY * HLY)); // yaw
  var CAR_MAX_SPEED = 2300, CAR_MAX_SPIN = 5.5, GROUND_MAX_SPIN = 12;
  var REST_Z = 17.0;
  var WHEELS = [51.25, 25.9, 51.25, -25.9, -33.75, 29.5, -33.75, -29.5]; // x (fwd), y (left)

  var SUSP_REST = 18.5, SUSP_EXT = 3.5, SUSP_MAXC = 14;
  var SUSP_K = 29250, SUSP_CC = 3000, SUSP_CR = 1700;
  var LAT_GRIP = 0.1;                           // share of its own lateral slip each wheel removes per tick
  var BRAKE_ACC = 3500, COAST_ACC = 525;
  var BOOST_ACC = 991.667, BOOST_USE = 100 / 3, BOOST_MIN_T = 0.1, BOOST_START = 100 / 3;
  var AIR_THROTTLE = 66.667;
  var STICKY = 325;
  var JUMP_IMPULSE = 291.667, JUMP_ACC = 1458.333, JUMP_MIN_T = 0.025, JUMP_MAX_T = 0.2;
  var DJ_MAX_DELAY = 1.25;
  var FLIP_VEL = 500, FLIP_TORQUE_T = 0.65, FLIP_MIN_T = 0.41, FLIP_LOCK_T = 0.95;
  var FLIP_TQ_PITCH = 224, FLIP_TQ_ROLL = 260;
  var AIR_TQ_ROLL = 38.35, AIR_TQ_PITCH = 12.46, AIR_TQ_YAW = 9.11;
  var AIR_DAMP_ROLL = 4.79, AIR_DAMP_PITCH = 2.876, AIR_DAMP_YAW = 1.917;
  var SUPER_ON = 2200, SUPER_KEEP = 2100;
  var DEMO_TIME = 3;

  var STEER_CURVE = [0, 0.5304, 500, 0.3262, 1000, 0.1972, 1500, 0.1164, 1750, 0.0932, 2300, 0.0747];
  var SLIDE_STEER_CURVE = [0, 0.39235, 2500, 0.12610];
  var DRIVE_CURVE = [0, 1600, 1400, 160, 1410, 0];
  var HIT_CURVE = [500, 0.65, 2300, 0.55, 4600, 0.30];
  var BUMP_GROUND = [0, 0.8333, 1400, 1100, 2200, 1530];
  var BUMP_AIR = [0, 0.8333, 1400, 1390, 2200, 1945];
  var BUMP_UP = [0, 0.3333, 1400, 278, 2200, 417];

  // boost pads: x, y, big?
  var PADS = [
    [0, -4240, 0], [-1792, -4184, 0], [1792, -4184, 0], [-3072, -4096, 1], [3072, -4096, 1],
    [-940, -3308, 0], [940, -3308, 0], [0, -2816, 0], [-3584, -2484, 0], [3584, -2484, 0],
    [-1788, -2300, 0], [1788, -2300, 0], [-2048, -1036, 0], [0, -1024, 0], [2048, -1036, 0],
    [-3584, 0, 1], [-1024, 0, 0], [1024, 0, 0], [3584, 0, 1], [-2048, 1036, 0], [0, 1024, 0],
    [2048, 1036, 0], [-1788, 2300, 0], [1788, 2300, 0], [-3584, 2484, 0], [3584, 2484, 0],
    [0, 2816, 0], [-940, 3308, 0], [940, 3308, 0], [-3072, 4096, 1], [3072, 4096, 1],
    [-1792, 4184, 0], [1792, 4184, 0], [0, 4240, 0]
  ];
  var PAD_BIG_R = 208, PAD_SMALL_R = 144, PAD_H = 168;
  var PAD_BIG_TICKS = 10 * TICK_RATE, PAD_SMALL_TICKS = 4 * TICK_RATE;

  // kickoff spots for blue: x, y, yaw
  var KICKOFF = [
    [-2048, -2560, Math.PI * 0.25], [2048, -2560, Math.PI * 0.75],
    [-256, -3840, Math.PI * 0.5], [256, -3840, Math.PI * 0.5], [0, -4608, Math.PI * 0.5]
  ];
  var RESPAWN = [[-2304, -4608], [-2688, -4608], [2304, -4608], [2688, -4608]];

  var PH_COUNTDOWN = 0, PH_PLAY = 1, PH_GOAL = 2, PH_END = 3;
  var COUNTDOWN_TIME = 3, GOAL_TIME = 3;

  var NOEV = { push: function () {} };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function curve(pts, x) {
    var n = pts.length;
    if (x <= pts[0]) return pts[1];
    for (var i = 2; i < n; i += 2) {
      if (x <= pts[i]) {
        var t = (x - pts[i - 2]) / (pts[i] - pts[i - 2]);
        return pts[i - 1] + (pts[i + 1] - pts[i - 1]) * t;
      }
    }
    return pts[n - 1];
  }

  // ------------------------------------------------------- arena distance field
  // sdf(x,y,z) returns the distance to the nearest surface (positive in free space) and leaves the
  // surface normal (pointing into free space) in NX,NY,NZ.
  var NX = 0, NY = 0, NZ = 1;

  function sdfBase(x, y, z) {
    var sx = x < 0 ? -1 : 1, sy = y < 0 ? -1 : 1;
    var ax = x * sx, ay = y * sy;
    var qx = ax - (HX - RC), qy = ay - (HY - RC);
    var wallD, gx, gy, l, a, b, s;
    if (qx > 0 && qy > 0) {
      l = Math.sqrt(qx * qx + qy * qy);
      wallD = RC - l;
      if (l > 1e-9) { gx = -qx / l; gy = -qy / l; } else { gx = -0.70710678; gy = -0.70710678; }
    } else if (qx > qy) { wallD = HX - ax; gx = -1; gy = 0; }
    else { wallD = HY - ay; gx = 0; gy = -1; }
    if (wallD < RF && z < RF) {
      a = RF - wallD; b = RF - z;
      l = Math.sqrt(a * a + b * b);
      if (l > 1e-9) { s = a / l; NX = gx * s * sx; NY = gy * s * sy; NZ = b / l; return RF - l; }
    } else if (wallD < RT && z > HZ - RT) {
      a = RT - wallD; b = z - (HZ - RT);
      l = Math.sqrt(a * a + b * b);
      if (l > 1e-9) { s = a / l; NX = gx * s * sx; NY = gy * s * sy; NZ = -b / l; return RT - l; }
    }
    var dc = HZ - z;
    if (wallD <= z && wallD <= dc) { NX = gx * sx; NY = gy * sy; NZ = 0; return wallD; }
    if (z <= dc) { NX = 0; NY = 0; NZ = 1; return z; }
    NX = 0; NY = 0; NZ = -1; return dc;
  }

  function sdf(x, y, z) {
    var ay = y < 0 ? -y : y;
    if (ay < HY - 700) return sdfBase(x, y, z);
    var ax = x < 0 ? -x : x;
    var sx = x < 0 ? -1 : 1, sy = y < 0 ? -1 : 1;
    var d, nx, ny, nz, t;
    if (ay <= HY) {
      if (ax >= GW || z >= GH) return sdfBase(x, y, z);
      // in front of the goal mouth: the back wall is open here
      d = z; nx = 0; ny = 0; nz = 1;
      var dxs = GW - ax;
      var dp = sdfBase(sx * GW, y, z);       // wall + ramp profile beside the mouth
      if (dp <= 0) { if (dxs < d) { d = dxs; nx = -sx; ny = 0; nz = 0; } }
      else {
        t = Math.sqrt(dxs * dxs + dp * dp);
        if (t < d) { d = t; nx = -sx * dxs / t; ny = NY * dp / t; nz = NZ * dp / t; }
      }
      var dzt = GH - z, dyt = HY - ay;
      t = Math.sqrt(dzt * dzt + dyt * dyt);
      if (t < d && t > 1e-9) { d = t; nx = 0; ny = -sy * dyt / t; nz = -dzt / t; }
      NX = nx; NY = ny; NZ = nz;
      return d;
    }
    // behind the goal line
    d = GW - ax; nx = -sx; ny = 0; nz = 0;
    t = GH - z; if (t < d) { d = t; nx = 0; ny = 0; nz = -1; }
    t = z; if (t < d) { d = t; nx = 0; ny = 0; nz = 1; }
    t = HY + GD - ay; if (t < d) { d = t; nx = 0; ny = -sy; nz = 0; }
    if (d < 0) {
      var db = sdfBase(x, y, z);              // negative: depth back into the arena
      if (db > d) return db;
    }
    NX = nx; NY = ny; NZ = nz;
    return d;
  }

  // distance from a point to the surface along -up (suspension probe). Normal is left in PNX..
  var PNX = 0, PNY = 0, PNZ = 1;
  function probe(hx, hy, hz, ux, uy, uz) {
    var d = sdf(hx, hy, hz);
    var c = NX * ux + NY * uy + NZ * uz;
    var t = c > 0.3 ? d / c : d;
    if (t > 60) return 1e9;
    d = sdf(hx - ux * t, hy - uy * t, hz - uz * t);
    c = NX * ux + NY * uy + NZ * uz;
    if (c <= 0.3) return 1e9;
    PNX = NX; PNY = NY; PNZ = NZ;
    return t + d / c;
  }

  // ------------------------------------------------------- state construction
  function makeInput() {
    return { steer: 0, throttle: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
  }
  // snap an input to the precision that travels over the wire so client and server agree exactly
  function quantizeInput(i) {
    i.steer = Math.round(clamp(i.steer, -1, 1) * 127) / 127;
    i.throttle = Math.round(clamp(i.throttle, -1, 1) * 127) / 127;
    i.pitch = Math.round(clamp(i.pitch, -1, 1) * 127) / 127;
    i.yaw = Math.round(clamp(i.yaw, -1, 1) * 127) / 127;
    i.roll = Math.round(clamp(i.roll, -1, 1) * 127) / 127;
    i.jump = !!i.jump; i.boost = !!i.boost; i.handbrake = !!i.handbrake;
    return i;
  }
  function copyInput(dst, src) {
    dst.steer = src.steer; dst.throttle = src.throttle; dst.pitch = src.pitch; dst.yaw = src.yaw; dst.roll = src.roll;
    dst.jump = src.jump; dst.boost = src.boost; dst.handbrake = src.handbrake;
  }

  function makeCar(team) {
    return {
      team: team,
      px: 0, py: 0, pz: REST_Z, vx: 0, vy: 0, vz: 0,
      qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0,
      fx: 1, fy: 0, fz: 0, lx: 0, ly: 1, lz: 0, ux: 0, uy: 0, uz: 1,
      boost: BOOST_START,
      'in': makeInput(), prevJump: false,
      isJumping: false, hasJumped: false, hasDJ: false, hasFlipped: false, isFlipping: false,
      jumpT: 0, airT: 0, flipT: 0, flipF: 0, flipS: 0,
      hb: 0, boostT: 0, boosting: false, superSonic: false, superT: 0,
      demoT: 0, autoFlipT: 0, autoFlipDir: 0, bumpT: 0, ballCd: 0,
      // derived each tick (not serialised)
      wheels: 4, onGround: true, hullHit: false, hnx: 0, hny: 0, hnz: 1, steerA: 0,
      gnx: 0, gny: 0, gnz: 1
    };
  }

  function basis(c) {
    var x = c.qx, y = c.qy, z = c.qz, w = c.qw;
    c.fx = 1 - 2 * (y * y + z * z); c.fy = 2 * (x * y + w * z); c.fz = 2 * (x * z - w * y);
    c.lx = 2 * (x * y - w * z); c.ly = 1 - 2 * (x * x + z * z); c.lz = 2 * (y * z + w * x);
    c.ux = 2 * (x * z + w * y); c.uy = 2 * (y * z - w * x); c.uz = 1 - 2 * (x * x + y * y);
  }

  function placeCar(c, x, y, yaw) {
    c.px = x; c.py = y; c.pz = REST_Z; c.vx = c.vy = c.vz = 0; c.wx = c.wy = c.wz = 0;
    c.qx = 0; c.qy = 0; c.qz = Math.sin(yaw / 2); c.qw = Math.cos(yaw / 2);
    c.isJumping = c.hasJumped = c.hasDJ = c.hasFlipped = c.isFlipping = false;
    c.jumpT = c.airT = c.flipT = c.flipF = c.flipS = 0;
    c.hb = 0; c.boostT = 0; c.boosting = false; c.superSonic = false; c.superT = 0;
    c.demoT = 0; c.autoFlipT = 0; c.autoFlipDir = 0; c.bumpT = 0; c.ballCd = 0;
    c.wheels = 4; c.onGround = true; c.hullHit = false; c.steerA = 0;
    basis(c);
  }

  function resetBall(b) {
    b.px = 0; b.py = 0; b.pz = BALL_R + 1.5; b.vx = b.vy = b.vz = 0; b.wx = b.wy = b.wz = 0;
  }

  function kickoffPerm(seed) {
    var p = [0, 1, 2, 3, 4], s = (seed * 2654435761 + 12345) >>> 0;
    for (var i = 4; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      var j = (s >>> 8) % (i + 1), t = p[i]; p[i] = p[j]; p[j] = t;
    }
    return p;
  }

  function resetKickoff(w) {
    var perm = kickoffPerm(w.kickoffSeed), nb = 0, no = 0;
    for (var i = 0; i < w.cars.length; i++) {
      var c = w.cars[i];
      var spot = KICKOFF[perm[(c.team === 0 ? nb++ : no++) % 5]];
      if (c.team === 0) placeCar(c, spot[0], spot[1], spot[2]);
      else placeCar(c, -spot[0], -spot[1], spot[2] + Math.PI);
      c.boost = BOOST_START;
    }
    resetBall(w.ball);
    w.ballOn = true;
    for (var k = 0; k < w.pads.length; k++) w.pads[k] = 0;
  }

  function respawnCar(w, c, idx) {
    var s = RESPAWN[(idx * 7 + w.tick) & 3];
    if (c.team === 0) placeCar(c, s[0], s[1], Math.PI / 2);
    else placeCar(c, -s[0], -s[1], -Math.PI / 2);
    c.boost = BOOST_START;
  }

  // cfg: { mode: 'match' | 'freeplay', matchSeconds, unlimitedBoost }
  function createWorld(cfg) {
    cfg = cfg || {};
    var w = {
      cfg: { mode: cfg.mode || 'match', matchSeconds: cfg.matchSeconds || 300, unlimitedBoost: !!cfg.unlimitedBoost },
      tick: 0, phase: PH_COUNTDOWN, phaseT: COUNTDOWN_TIME, clock: cfg.matchSeconds || 300, overtime: false,
      score: [0, 0], kickoffSeed: (cfg.seed || 0) & 255, ballOn: true, ballGround: false,
      ball: { px: 0, py: 0, pz: BALL_R + 1.5, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 },
      cars: [], pads: new Uint16Array(PADS.length)
    };
    return w;
  }
  function addCar(w, team) { var c = makeCar(team); w.cars.push(c); return c; }
  function startMatch(w) {
    resetKickoff(w);
    if (w.cfg.mode === 'freeplay') { w.phase = PH_PLAY; w.phaseT = 0; }
    else { w.phase = PH_COUNTDOWN; w.phaseT = COUNTDOWN_TIME; }
  }

  // ------------------------------------------------------- rigid body helpers
  function applyImpulse(c, jx, jy, jz, rx, ry, rz) {
    c.vx += jx * INV_M; c.vy += jy * INV_M; c.vz += jz * INV_M;
    var tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
    var a = (tx * c.fx + ty * c.fy + tz * c.fz) * INV_IX;
    var b = (tx * c.lx + ty * c.ly + tz * c.lz) * INV_IY;
    var d = (tx * c.ux + ty * c.uy + tz * c.uz) * INV_IZ;
    c.wx += c.fx * a + c.lx * b + c.ux * d;
    c.wy += c.fy * a + c.ly * b + c.uy * d;
    c.wz += c.fz * a + c.lz * b + c.uz * d;
  }
  function angK(c, rx, ry, rz, nx, ny, nz) {
    var tx = ry * nz - rz * ny, ty = rz * nx - rx * nz, tz = rx * ny - ry * nx;
    var a = tx * c.fx + ty * c.fy + tz * c.fz;
    var b = tx * c.lx + ty * c.ly + tz * c.lz;
    var d = tx * c.ux + ty * c.uy + tz * c.uz;
    return a * a * INV_IX + b * b * INV_IY + d * d * INV_IZ;
  }

  var W_ON = [false, false, false, false];
  var W_S = new Float64Array(4), W_N = new Float64Array(12), W_R = new Float64Array(12);

  // ------------------------------------------------------- car update
  function updateCar(w, c, idx, ev) {
    var inp = c['in'];
    if (c.demoT > 0) {
      c.demoT -= DT;
      if (c.demoT <= 0) { c.demoT = 0; respawnCar(w, c, idx); }
      c.prevJump = inp.jump;
      return;
    }
    basis(c);
    var fx = c.fx, fy = c.fy, fz = c.fz, lx = c.lx, ly = c.ly, lz = c.lz, ux = c.ux, uy = c.uy, uz = c.uz;
    var i, rx, ry, rz, nx, ny, nz, s, t;
    var accX = 0, accY = 0, accZ = -GRAVITY;   // linear acceleration (world)
    var alx = 0, aly = 0, alz = 0;             // angular acceleration (car-local: roll, pitch-down, yaw-left)

    // ---- wheel contacts
    var nW = 0, gnx = 0, gny = 0, gnz = 0;
    var near = sdf(c.px, c.py, c.pz) < 110;
    for (i = 0; i < 4; i++) {
      W_ON[i] = false;
      if (!near) continue;
      var hx = WHEELS[i * 2], hy = WHEELS[i * 2 + 1];
      rx = fx * hx + lx * hy; ry = fy * hx + ly * hy; rz = fz * hx + lz * hy;
      s = probe(c.px + rx, c.py + ry, c.pz + rz, ux, uy, uz);
      if (s < SUSP_REST + SUSP_EXT) {
        W_ON[i] = true; W_S[i] = s;
        W_N[i * 3] = PNX; W_N[i * 3 + 1] = PNY; W_N[i * 3 + 2] = PNZ;
        W_R[i * 3] = rx; W_R[i * 3 + 1] = ry; W_R[i * 3 + 2] = rz;
        gnx += PNX; gny += PNY; gnz += PNZ; nW++;
      }
    }
    if (nW > 0) {
      t = Math.sqrt(gnx * gnx + gny * gny + gnz * gnz) || 1;
      gnx /= t; gny /= t; gnz /= t;
      c.gnx = gnx; c.gny = gny; c.gnz = gnz;
    }
    var onGround = nW >= 3;
    c.wheels = nW; c.onGround = onGround;

    // ---- timers and analog handbrake
    if (c.bumpT > 0) c.bumpT -= DT;
    if (inp.handbrake) c.hb = Math.min(1, c.hb + 5 * DT); else c.hb = Math.max(0, c.hb - 2 * DT);

    // ---- boost
    var boosting = c.boost > 0 && (inp.boost || (c.boostT > 0 && c.boostT < BOOST_MIN_T));
    if (boosting) {
      if (!w.cfg.unlimitedBoost) c.boost = Math.max(0, c.boost - BOOST_USE * DT);
      c.boostT += DT;
      accX += fx * BOOST_ACC; accY += fy * BOOST_ACC; accZ += fz * BOOST_ACC;
    } else c.boostT = 0;
    c.boosting = boosting;
    var th = boosting ? 1 : inp.throttle;

    // ---- jumping
    var jumpPressed = inp.jump && !c.prevJump;
    var jumpedNow = false;
    if (onGround && !c.isJumping) {
      c.hasJumped = false; c.hasDJ = false; c.hasFlipped = false; c.airT = 0;
      if (jumpPressed) {
        c.isJumping = true; c.hasJumped = true; c.jumpT = 0; jumpedNow = true;
        c.vx += ux * JUMP_IMPULSE; c.vy += uy * JUMP_IMPULSE; c.vz += uz * JUMP_IMPULSE;
        ev.push({ t: 'jump', car: idx });
      }
    }
    if (c.isJumping) {
      if (c.jumpT >= JUMP_MIN_T && (!inp.jump || c.jumpT >= JUMP_MAX_T)) c.isJumping = false;
      else {
        s = c.jumpT < JUMP_MIN_T ? 0.62 * JUMP_ACC : JUMP_ACC;
        accX += ux * s; accY += uy * s; accZ += uz * s;
        c.jumpT += DT;
      }
    }
    if (!onGround) {
      if (c.hasJumped && !c.isJumping) c.airT += DT;
      if (jumpPressed && !jumpedNow) {
        var upDotN = ux * c.hnx + uy * c.hny + uz * c.hnz;
        if (c.hullHit && nW < 3 && upDotN < -0.3) {
          // on the roof: pop up and roll back onto the wheels
          if (c.autoFlipT <= 0) {
            c.autoFlipT = 0.4;
            c.autoFlipDir = (lx * c.hnx + ly * c.hny + lz * c.hnz) >= 0 ? -1 : 1;
            c.vx += c.hnx * 200; c.vy += c.hny * 200; c.vz += c.hnz * 200;
          }
        } else if (!c.isJumping && !c.hasDJ && !c.hasFlipped && (!c.hasJumped || c.airT < DJ_MAX_DELAY)) {
          var mag = Math.max(Math.abs(inp.pitch), Math.abs(inp.yaw), Math.abs(inp.roll));
          if (mag >= 0.5) {
            // dodge
            var df = -inp.pitch, ds = clamp(inp.yaw + inp.roll, -1, 1);
            if (Math.abs(df) < 0.1) df = 0;
            if (Math.abs(ds) < 0.1) ds = 0;
            t = Math.sqrt(df * df + ds * ds) || 1; df /= t; ds /= t;
            c.hasFlipped = true; c.isFlipping = true; c.flipT = 0; c.flipF = df; c.flipS = ds;
            var fwdSpeed = c.vx * fx + c.vy * fy + c.vz * fz;
            var ratio = Math.abs(fwdSpeed) / CAR_MAX_SPEED;
            var backwards = Math.abs(fwdSpeed) < 100 ? df < 0 : (df >= 0) !== (fwdSpeed >= 0);
            var ivx = df * FLIP_VEL * (((backwards ? 2.5 : 1) - 1) * ratio + 1);
            var ivy = ds * FLIP_VEL * (0.9 * ratio + 1);
            if (backwards) ivx *= 16 / 15;
            var f2 = Math.sqrt(fx * fx + fy * fy);
            if (f2 > 1e-4) {
              var f2x = fx / f2, f2y = fy / f2;      // right = (f2y, -f2x)
              c.vx += f2x * ivx + f2y * ivy;
              c.vy += f2y * ivx - f2x * ivy;
            }
            ev.push({ t: 'flip', car: idx });
          } else {
            c.hasDJ = true;
            c.vx += ux * JUMP_IMPULSE; c.vy += uy * JUMP_IMPULSE; c.vz += uz * JUMP_IMPULSE;
            ev.push({ t: 'jump', car: idx });
          }
        }
      }
    }

    // ---- dodge torque
    if (c.hasFlipped || c.isFlipping) c.flipT = Math.min(c.flipT + DT, 5);
    if (c.isFlipping) {
      if (c.flipT >= FLIP_TORQUE_T || (onGround && c.flipT >= FLIP_MIN_T)) c.isFlipping = false;
      else {
        var ps = 1;
        if (c.flipF * inp.pitch > 0) ps = 1 - Math.min(1, Math.abs(inp.pitch));   // flip cancel
        aly += FLIP_TQ_PITCH * c.flipF * ps;
        alx += FLIP_TQ_ROLL * c.flipS;
        if (c.flipT >= 0.15 && (c.vz < 0 || c.flipT < 0.21)) c.vz *= 0.65;
      }
    }

    // ---- air control
    var wlx = c.wx * fx + c.wy * fy + c.wz * fz;
    var wly = c.wx * lx + c.wy * ly + c.wz * lz;
    var wlz = c.wx * ux + c.wy * uy + c.wz * uz;
    if (c.autoFlipT > 0) {
      c.autoFlipT -= DT;
      alx += 50 * c.autoFlipDir;
    } else if (!onGround) {
      var pin = inp.pitch, yin = inp.yaw, rin = inp.roll;
      if (c.isFlipping || (c.hasFlipped && c.flipT < FLIP_LOCK_T)) pin = 0;
      alx += AIR_TQ_ROLL * rin - AIR_DAMP_ROLL * wlx;
      aly += -AIR_TQ_PITCH * pin - AIR_DAMP_PITCH * wly * (1 - Math.abs(pin));
      alz += -AIR_TQ_YAW * yin - AIR_DAMP_YAW * wlz * (1 - Math.abs(yin));
      if (nW === 0 && th !== 0) {
        s = th * (th > 0 ? AIR_THROTTLE : AIR_THROTTLE * 0.5);
        accX += fx * s; accY += fy * s; accZ += fz * s;
      }
      // lying on a side: roll back towards the wheels
      if (c.hullHit && nW < 3) {
        var cxn = (uy * c.hnz - uz * c.hny) * fx + (uz * c.hnx - ux * c.hnz) * fy + (ux * c.hny - uy * c.hnx) * fz;
        if (Math.abs(cxn) > 0.15) alx += 9 * (cxn > 0 ? 1 : -1);
      }
    }

    // ---- wheels: suspension and tyres
    var Px = 0, Py = 0, Pz = 0, Lx = 0, Ly = 0, Lz = 0;
    if (nW > 0) {
      var vf = c.vx * fx + c.vy * fy + c.vz * fz, avf = Math.abs(vf);
      var steerAng = curve(STEER_CURVE, avf);
      if (c.hb > 0) steerAng += (curve(SLIDE_STEER_CURVE, avf) - steerAng) * c.hb;
      steerAng *= inp.steer;
      c.steerA = steerAng;
      var cs = Math.cos(steerAng), sn = Math.sin(steerAng);
      var driveAcc = 0, brake = 0;
      var flat = gnz > 0.7;
      if (th !== 0) {
        if (th * vf < 0 && avf > 25) brake = BRAKE_ACC;
        else driveAcc = th * curve(DRIVE_CURVE, avf);
      } else brake = (avf < 25 && flat) ? BRAKE_ACC : COAST_ACC;

      if (!c.isJumping) {
        var full = th !== 0 || avf > 25;
        s = GRAVITY * (0.5 + (full ? 1 - Math.abs(gnz) : 0));
        accX -= gnx * s; accY -= gny * s; accZ -= gnz * s;
      }
      var speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy + c.vz * c.vz);
      var wallSlip = (!flat && th === 0) ? clamp(speed / 300, 0.15, 1) : 1;

      for (i = 0; i < 4; i++) {
        if (!W_ON[i]) continue;
        nx = W_N[i * 3]; ny = W_N[i * 3 + 1]; nz = W_N[i * 3 + 2];
        rx = W_R[i * 3]; ry = W_R[i * 3 + 1]; rz = W_R[i * 3 + 2];
        var vx = c.vx + (c.wy * rz - c.wz * ry), vy = c.vy + (c.wz * rx - c.wx * rz), vz = c.vz + (c.wx * ry - c.wy * rx);
        var jx = 0, jy = 0, jz = 0;
        // suspension
        var comp = SUSP_REST - W_S[i];
        if (comp > 0) {
          var vn = vx * nx + vy * ny + vz * nz;
          var F = SUSP_K * Math.min(comp, SUSP_MAXC) - (vn < 0 ? SUSP_CC : SUSP_CR) * vn;
          if (F > 0) { F *= DT; jx += nx * F; jy += ny * F; jz += nz * F; }
        }
        // tyre directions in the contact plane
        var wfx, wfy, wfz;
        if (i < 2) { wfx = fx * cs - lx * sn; wfy = fy * cs - ly * sn; wfz = fz * cs - lz * sn; }
        else { wfx = fx; wfy = fy; wfz = fz; }
        t = wfx * nx + wfy * ny + wfz * nz;
        wfx -= nx * t; wfy -= ny * t; wfz -= nz * t;
        t = Math.sqrt(wfx * wfx + wfy * wfy + wfz * wfz);
        if (t > 1e-5) {
          wfx /= t; wfy /= t; wfz /= t;
          var ltx = ny * wfz - nz * wfy, lty = nz * wfx - nx * wfz, ltz = nx * wfy - ny * wfx;
          var vlat = vx * ltx + vy * lty + vz * ltz, vlong = vx * wfx + vy * wfy + vz * wfz;
          var alat = Math.abs(vlat), along = Math.abs(vlong);
          var slip = alat > 5 ? alat / (along + alat) : 0;
          var latF = (1 - 0.8 * slip) * wallSlip, longF = 1;
          if (c.hb > 0) { latF *= 1 - 0.9 * c.hb; longF = 1 + (0.4 * slip - 0.5) * c.hb; }
          var jl = -vlat * latF * LAT_GRIP / (INV_M + angK(c, rx, ry, rz, ltx, lty, ltz));
          var jf;
          if (brake > 0) jf = clamp(-vlong, -brake * DT, brake * DT) * CAR_MASS * 0.25 * longF;
          else jf = driveAcc * DT * CAR_MASS * 0.25 * longF;
          jx += ltx * jl + wfx * jf; jy += lty * jl + wfy * jf; jz += ltz * jl + wfz * jf;
        }
        Px += jx; Py += jy; Pz += jz;
        Lx += ry * jz - rz * jy; Ly += rz * jx - rx * jz; Lz += rx * jy - ry * jx;
      }
    } else c.steerA = inp.steer * 0.3;

    // ---- integrate velocities
    c.vx += accX * DT + Px * INV_M; c.vy += accY * DT + Py * INV_M; c.vz += accZ * DT + Pz * INV_M;
    var a = (Lx * fx + Ly * fy + Lz * fz) * INV_IX + alx * DT;
    var b = (Lx * lx + Ly * ly + Lz * lz) * INV_IY + aly * DT;
    var d = (Lx * ux + Ly * uy + Lz * uz) * INV_IZ + alz * DT;
    c.wx += fx * a + lx * b + ux * d; c.wy += fy * a + ly * b + uy * d; c.wz += fz * a + lz * b + uz * d;
    t = c.wx * c.wx + c.wy * c.wy + c.wz * c.wz;
    s = nW >= 2 ? GROUND_MAX_SPIN : CAR_MAX_SPIN;   // wheels may turn the car faster than air control can (ramps at speed)
    if (t > s * s) { t = s / Math.sqrt(t); c.wx *= t; c.wy *= t; c.wz *= t; }
    t = c.vx * c.vx + c.vy * c.vy + c.vz * c.vz;
    if (t > CAR_MAX_SPEED * CAR_MAX_SPEED) { t = CAR_MAX_SPEED / Math.sqrt(t); c.vx *= t; c.vy *= t; c.vz *= t; t = CAR_MAX_SPEED * CAR_MAX_SPEED; }

    // ---- supersonic
    if (c.superSonic && c.superT < 1) c.superSonic = t >= SUPER_KEEP * SUPER_KEEP;
    else c.superSonic = t >= SUPER_ON * SUPER_ON;
    if (c.superSonic) c.superT += DT; else c.superT = 0;

    // ---- integrate pose
    c.px += c.vx * DT; c.py += c.vy * DT; c.pz += c.vz * DT;
    var qx = c.qx, qy = c.qy, qz = c.qz, qw = c.qw, h = 0.5 * DT;
    c.qx += h * (c.wx * qw + c.wy * qz - c.wz * qy);
    c.qy += h * (c.wy * qw + c.wz * qx - c.wx * qz);
    c.qz += h * (c.wz * qw + c.wx * qy - c.wy * qx);
    c.qw += h * (-c.wx * qx - c.wy * qy - c.wz * qz);
    t = 1 / Math.sqrt(c.qx * c.qx + c.qy * c.qy + c.qz * c.qz + c.qw * c.qw);
    c.qx *= t; c.qy *= t; c.qz *= t; c.qw *= t;
    basis(c);

    collideHull(c);
    c.prevJump = inp.jump;
  }

  // hull sample points (hitbox corners, edge midpoints, face centres) against the arena
  var HULL = (function () {
    var a = [];
    for (var x = -1; x <= 1; x++) for (var y = -1; y <= 1; y++) for (var z = -1; z <= 1; z++) {
      if (x === 0 && y === 0 && z === 0) continue;
      a.push(HB_OX + x * HLX, y * HLY, HB_OZ + z * HLZ);
    }
    return a;
  })();
  var HULL_N = HULL.length / 3;

  function collideHull(c) {
    var hit = false;
    if (sdf(c.px, c.py, c.pz) > 100) { c.hullHit = false; return; }
    for (var pass = 0; pass < 2; pass++) {
      var deep = 0, dnx = 0, dny = 0, dnz = 0;
      for (var k = 0; k < HULL_N; k++) {
        var x = HULL[k * 3], y = HULL[k * 3 + 1], z = HULL[k * 3 + 2];
        var rx = c.fx * x + c.lx * y + c.ux * z, ry = c.fy * x + c.ly * y + c.uy * z, rz = c.fz * x + c.lz * y + c.uz * z;
        var d = sdf(c.px + rx, c.py + ry, c.pz + rz);
        if (d >= 0) continue;
        var nx = NX, ny = NY, nz = NZ;
        hit = true;
        var vx = c.vx + (c.wy * rz - c.wz * ry), vy = c.vy + (c.wz * rx - c.wx * rz), vz = c.vz + (c.wx * ry - c.wy * rx);
        var vn = vx * nx + vy * ny + vz * nz;
        if (vn < 0) {
          var K = INV_M + angK(c, rx, ry, rz, nx, ny, nz);
          var jn = -(vn < -200 ? 1.3 : 1) * vn / K;
          applyImpulse(c, nx * jn, ny * jn, nz * jn, rx, ry, rz);
          vx = c.vx + (c.wy * rz - c.wz * ry); vy = c.vy + (c.wz * rx - c.wx * rz); vz = c.vz + (c.wx * ry - c.wy * rx);
          vn = vx * nx + vy * ny + vz * nz;
          vx -= nx * vn; vy -= ny * vn; vz -= nz * vn;
          var tl = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (tl > 1e-3) {
            vx /= tl; vy /= tl; vz /= tl;
            var jt = Math.min(0.3 * jn, tl / (INV_M + angK(c, rx, ry, rz, vx, vy, vz)));
            applyImpulse(c, -vx * jt, -vy * jt, -vz * jt, rx, ry, rz);
          }
        }
        if (-d > deep) { deep = -d; dnx = nx; dny = ny; dnz = nz; }
      }
      if (deep <= 0) break;
      c.px += dnx * deep; c.py += dny * deep; c.pz += dnz * deep;
      c.hnx = dnx; c.hny = dny; c.hnz = dnz;
    }
    c.hullHit = hit;
  }

  // ------------------------------------------------------- ball
  var BALL_HIT_SPEED = 0;   // normal speed of the last world bounce (for sound), 0 if none this step
  var BALL_ON_FLOOR = false;
  function stepBall(b, dt) {
    BALL_HIT_SPEED = 0; BALL_ON_FLOOR = false;
    b.vz -= GRAVITY * dt;
    var k = 1 - BALL_DRAG * dt;
    b.vx *= k; b.vy *= k; b.vz *= k;
    var t = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    if (t > BALL_MAX_SPEED * BALL_MAX_SPEED) { t = BALL_MAX_SPEED / Math.sqrt(t); b.vx *= t; b.vy *= t; b.vz *= t; }
    t = b.wx * b.wx + b.wy * b.wy + b.wz * b.wz;
    if (t > BALL_MAX_SPIN * BALL_MAX_SPIN) { t = BALL_MAX_SPIN / Math.sqrt(t); b.wx *= t; b.wy *= t; b.wz *= t; }
    b.px += b.vx * dt; b.py += b.vy * dt; b.pz += b.vz * dt;
    var d = sdf(b.px, b.py, b.pz) - BALL_R;
    if (d >= 0) return;
    var nx = NX, ny = NY, nz = NZ;
    b.px -= nx * d; b.py -= ny * d; b.pz -= nz * d;
    if (nz > 0.7) BALL_ON_FLOOR = true;
    var vn = b.vx * nx + b.vy * ny + b.vz * nz;
    if (vn >= 0) return;
    // bounce with spin transfer
    var vpx = nx * vn, vpy = ny * vn, vpz = nz * vn;
    var sx = b.vx - vpx + BALL_R * (ny * b.wz - nz * b.wy);
    var sy = b.vy - vpy + BALL_R * (nz * b.wx - nx * b.wz);
    var sz = b.vz - vpz + BALL_R * (nx * b.wy - ny * b.wx);
    var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    var e = vn > -25 ? 0 : BALL_REST;
    if (sl > 1e-6) {
      var f = -Math.min(2 / 7, BALL_MU * (1 + e) * (-vn) / sl);   // full grip, capped by Coulomb friction
      var dx = sx * f, dy = sy * f, dz = sz * f;
      b.vx += dx; b.vy += dy; b.vz += dz;
      var ar = BALL_R * BALL_MASS * BALL_INV_I;
      b.wx += ar * (dy * nz - dz * ny); b.wy += ar * (dz * nx - dx * nz); b.wz += ar * (dx * ny - dy * nx);
    }
    b.vx -= (1 + e) * vpx; b.vy -= (1 + e) * vpy; b.vz -= (1 + e) * vpz;
    BALL_HIT_SPEED = -vn;
  }

  function collideCarBall(w, c, idx, ev) {
    var b = w.ball;
    if (c.ballCd > 0) c.ballCd--;
    var dx = b.px - c.px, dy = b.py - c.py, dz = b.pz - c.pz;
    if (dx * dx + dy * dy + dz * dz > 200 * 200) return;
    var bx = dx * c.fx + dy * c.fy + dz * c.fz - HB_OX;
    var by = dx * c.lx + dy * c.ly + dz * c.lz;
    var bz = dx * c.ux + dy * c.uy + dz * c.uz - HB_OZ;
    var qx = clamp(bx, -HLX, HLX), qy = clamp(by, -HLY, HLY), qz = clamp(bz, -HLZ, HLZ);
    var ex = bx - qx, ey = by - qy, ez = bz - qz;
    var d2 = ex * ex + ey * ey + ez * ez;
    if (d2 >= BALL_R * BALL_R) return;
    var nlx, nly, nlz, depth, t;
    if (d2 > 1e-8) { t = Math.sqrt(d2); nlx = ex / t; nly = ey / t; nlz = ez / t; depth = BALL_R - t; }
    else {
      var px = HLX - Math.abs(bx), py = HLY - Math.abs(by), pz = HLZ - Math.abs(bz);
      nlx = nly = nlz = 0;
      if (pz <= px && pz <= py) { nlz = bz < 0 ? -1 : 1; depth = BALL_R + pz; }
      else if (px <= py) { nlx = bx < 0 ? -1 : 1; depth = BALL_R + px; }
      else { nly = by < 0 ? -1 : 1; depth = BALL_R + py; }
    }
    var nx = c.fx * nlx + c.lx * nly + c.ux * nlz, ny = c.fy * nlx + c.ly * nly + c.uy * nlz, nz = c.fz * nlx + c.lz * nly + c.uz * nlz;
    var cx = qx + HB_OX, cz = qz + HB_OZ;
    var rx = c.fx * cx + c.lx * qy + c.ux * cz, ry = c.fy * cx + c.ly * qy + c.uy * cz, rz = c.fz * cx + c.lz * qy + c.uz * cz;
    var rvx = b.vx - c.vx, rvy = b.vy - c.vy, rvz = b.vz - c.vz;   // before the impulse

    // rigid contact (no restitution, high friction)
    var bxr = -nx * BALL_R, byr = -ny * BALL_R, bzr = -nz * BALL_R;
    var vx = b.vx + (b.wy * bzr - b.wz * byr) - c.vx - (c.wy * rz - c.wz * ry);
    var vy = b.vy + (b.wz * bxr - b.wx * bzr) - c.vy - (c.wz * rx - c.wx * rz);
    var vz = b.vz + (b.wx * byr - b.wy * bxr) - c.vz - (c.wx * ry - c.wy * rx);
    var vn = vx * nx + vy * ny + vz * nz;
    if (vn < 0) {
      var jn = -vn / (1 / BALL_MASS + INV_M + angK(c, rx, ry, rz, nx, ny, nz));
      b.vx += nx * jn / BALL_MASS; b.vy += ny * jn / BALL_MASS; b.vz += nz * jn / BALL_MASS;
      applyImpulse(c, -nx * jn, -ny * jn, -nz * jn, rx, ry, rz);
      vx = b.vx + (b.wy * bzr - b.wz * byr) - c.vx - (c.wy * rz - c.wz * ry);
      vy = b.vy + (b.wz * bxr - b.wx * bzr) - c.vy - (c.wz * rx - c.wx * rz);
      vz = b.vz + (b.wx * byr - b.wy * bxr) - c.vz - (c.wx * ry - c.wy * rx);
      vn = vx * nx + vy * ny + vz * nz;
      vx -= nx * vn; vy -= ny * vn; vz -= nz * vn;
      var tl = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (tl > 1e-3) {
        vx /= tl; vy /= tl; vz /= tl;
        var Kt = 1 / BALL_MASS + BALL_R * BALL_R * BALL_INV_I + INV_M + angK(c, rx, ry, rz, vx, vy, vz);
        var jt = Math.min(2.0 * jn, tl / Kt);
        var ix = -vx * jt, iy = -vy * jt, iz = -vz * jt;   // impulse on the ball
        b.vx += ix / BALL_MASS; b.vy += iy / BALL_MASS; b.vz += iz / BALL_MASS;
        b.wx += (byr * iz - bzr * iy) * BALL_INV_I; b.wy += (bzr * ix - bxr * iz) * BALL_INV_I; b.wz += (bxr * iy - byr * ix) * BALL_INV_I;
        applyImpulse(c, -ix, -iy, -iz, rx, ry, rz);
      }
    }
    // extra "arcade" impulse on a fresh touch - this is what gives hits their punch
    if (c.ballCd === 0) {
      var rs = Math.min(Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz), 4600);
      if (rs > 0) {
        var hx = dx, hy = dy, hz = dz * 0.35;
        t = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1; hx /= t; hy /= t; hz /= t;
        t = (hx * c.fx + hy * c.fy + hz * c.fz) * 0.35;
        hx -= c.fx * t; hy -= c.fy * t; hz -= c.fz * t;
        t = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
        var k = rs * curve(HIT_CURVE, rs) / t;
        b.vx += hx * k; b.vy += hy * k; b.vz += hz * k;
      }
      ev.push({ t: 'touch', car: idx, speed: rs });
    }
    c.ballCd = 2;
    b.px += nx * depth * 0.857; b.py += ny * depth * 0.857; b.pz += nz * depth * 0.857;
    c.px -= nx * depth * 0.143; c.py -= ny * depth * 0.143; c.pz -= nz * depth * 0.143;
  }

  // ------------------------------------------------------- car vs car
  var S_deep = 0, S_nx = 0, S_ny = 0, S_nz = 0, S_cx = 0, S_cy = 0, S_cz = 0, S_cnt = 0;
  function samplesIn(P, Q) {   // which hull points of P are inside Q's hitbox
    S_deep = 0;
    for (var k = 0; k < HULL_N; k++) {
      var x = HULL[k * 3], y = HULL[k * 3 + 1], z = HULL[k * 3 + 2];
      var wx = P.px + P.fx * x + P.lx * y + P.ux * z - Q.px;
      var wy = P.py + P.fy * x + P.ly * y + P.uy * z - Q.py;
      var wz = P.pz + P.fz * x + P.lz * y + P.uz * z - Q.pz;
      var ax = wx * Q.fx + wy * Q.fy + wz * Q.fz - HB_OX;
      var ay = wx * Q.lx + wy * Q.ly + wz * Q.lz;
      var az = wx * Q.ux + wy * Q.uy + wz * Q.uz - HB_OZ;
      var px = HLX - Math.abs(ax), py = HLY - Math.abs(ay), pz = HLZ - Math.abs(az);
      if (px <= 0 || py <= 0 || pz <= 0) continue;
      S_cx += wx + Q.px; S_cy += wy + Q.py; S_cz += wz + Q.pz; S_cnt++;
      var dep, s;
      if (px <= py && px <= pz) { dep = px; if (dep > S_deep) { s = ax < 0 ? -1 : 1; S_deep = dep; S_nx = Q.fx * s; S_ny = Q.fy * s; S_nz = Q.fz * s; } }
      else if (py <= pz) { dep = py; if (dep > S_deep) { s = ay < 0 ? -1 : 1; S_deep = dep; S_nx = Q.lx * s; S_ny = Q.ly * s; S_nz = Q.lz * s; } }
      else { dep = pz; if (dep > S_deep) { s = az < 0 ? -1 : 1; S_deep = dep; S_nx = Q.ux * s; S_ny = Q.uy * s; S_nz = Q.uz * s; } }
    }
  }

  function tryBump(w, A, ia, B, ib, cx, cy, cz, ev) {
    if (A.bumpT > 0) return;
    var dx = B.px - A.px, dy = B.py - A.py, dz = B.pz - A.pz;
    if (A.vx * dx + A.vy * dy + A.vz * dz <= 0) return;
    var sp = Math.sqrt(A.vx * A.vx + A.vy * A.vy + A.vz * A.vz);
    if (sp < 1) return;
    var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    var toward = (A.vx * dx + A.vy * dy + A.vz * dz) / dl;
    var away = (B.vx * A.vx + B.vy * A.vy + B.vz * A.vz) / sp;
    if (toward <= away) return;
    if ((cx - A.px) * A.fx + (cy - A.py) * A.fy + (cz - A.pz) * A.fz <= 55) return;   // must hit with the nose
    A.bumpT = 0.25;
    if (A.superSonic && A.team !== B.team) {
      B.demoT = DEMO_TIME; B.vx = B.vy = B.vz = 0; B.wx = B.wy = B.wz = 0;
      ev.push({ t: 'demo', a: ia, v: ib, x: B.px, y: B.py, z: B.pz });
      return;
    }
    var base = curve(B.onGround ? BUMP_GROUND : BUMP_AIR, toward), up = curve(BUMP_UP, toward);
    B.vx += A.vx / sp * base; B.vy += A.vy / sp * base; B.vz += A.vz / sp * base;
    if (B.onGround) { B.vx += B.ux * up; B.vy += B.uy * up; B.vz += B.uz * up; } else B.vz += up;
    ev.push({ t: 'bump', a: ia, v: ib });
  }

  function collideCars(w, A, ia, B, ib, ev) {
    var dx = A.px - B.px, dy = A.py - B.py, dz = A.pz - B.pz;
    if (dx * dx + dy * dy + dz * dz > 190 * 190) return;
    S_cx = S_cy = S_cz = 0; S_cnt = 0;
    samplesIn(A, B);
    var deep = S_deep, nx = S_nx, ny = S_ny, nz = S_nz;      // pushes A out of B
    samplesIn(B, A);
    if (S_deep > deep) { deep = S_deep; nx = -S_nx; ny = -S_ny; nz = -S_nz; }
    if (S_cnt === 0 || deep <= 0) return;
    var cx = S_cx / S_cnt, cy = S_cy / S_cnt, cz = S_cz / S_cnt;
    var ax = cx - A.px, ay = cy - A.py, az = cz - A.pz, bx = cx - B.px, by = cy - B.py, bz = cz - B.pz;
    var vx = A.vx + (A.wy * az - A.wz * ay) - B.vx - (B.wy * bz - B.wz * by);
    var vy = A.vy + (A.wz * ax - A.wx * az) - B.vy - (B.wz * bx - B.wx * bz);
    var vz = A.vz + (A.wx * ay - A.wy * ax) - B.vz - (B.wx * by - B.wy * bx);
    var vn = vx * nx + vy * ny + vz * nz;
    if (vn < 0) {
      var jn = -1.1 * vn / (2 * INV_M + angK(A, ax, ay, az, nx, ny, nz) + angK(B, bx, by, bz, nx, ny, nz));
      applyImpulse(A, nx * jn, ny * jn, nz * jn, ax, ay, az);
      applyImpulse(B, -nx * jn, -ny * jn, -nz * jn, bx, by, bz);
    }
    A.px += nx * deep * 0.5; A.py += ny * deep * 0.5; A.pz += nz * deep * 0.5;
    B.px -= nx * deep * 0.5; B.py -= ny * deep * 0.5; B.pz -= nz * deep * 0.5;
    tryBump(w, A, ia, B, ib, cx, cy, cz, ev);
    if (B.demoT <= 0) tryBump(w, B, ib, A, ia, cx, cy, cz, ev);
  }

  // ------------------------------------------------------- world step
  function physics(w, ev) {
    var cars = w.cars, n = cars.length, i, j, c;
    for (i = 0; i < n; i++) updateCar(w, cars[i], i, ev);
    w.ballGround = false;
    if (w.ballOn) {
      stepBall(w.ball, DT);
      if (BALL_ON_FLOOR) w.ballGround = true;
      if (BALL_HIT_SPEED > 150) ev.push({ t: 'bounce', speed: BALL_HIT_SPEED });
      for (i = 0; i < n; i++) if (cars[i].demoT <= 0) collideCarBall(w, cars[i], i, ev);
    }
    for (i = 0; i < n; i++) {
      if (cars[i].demoT > 0) continue;
      for (j = i + 1; j < n; j++) if (cars[j].demoT <= 0) collideCars(w, cars[i], i, cars[j], j, ev);
    }
    // boost pads
    var pads = w.pads, k;
    for (k = 0; k < PADS.length; k++) if (pads[k] > 0) pads[k]--;
    for (i = 0; i < n; i++) {
      c = cars[i];
      if (c.demoT > 0 || c.boost >= 100 || c.pz > PAD_H) continue;
      for (k = 0; k < PADS.length; k++) {
        if (pads[k] > 0) continue;
        var p = PADS[k], r = p[2] ? PAD_BIG_R : PAD_SMALL_R;
        var dx = c.px - p[0], dy = c.py - p[1];
        if (dx * dx + dy * dy < r * r) {
          c.boost = p[2] ? 100 : Math.min(100, c.boost + 12);
          pads[k] = p[2] ? PAD_BIG_TICKS : PAD_SMALL_TICKS;
          ev.push({ t: 'pad', car: i, pad: k, big: p[2] });
          if (c.boost >= 100) break;
        }
      }
    }
  }

  function step(w, ev) {
    ev = ev || NOEV;
    w.tick++;
    var i, c, cfg = w.cfg, free = cfg.mode === 'freeplay';
    if (w.phase === PH_END) return;
    if (w.phase === PH_COUNTDOWN) {
      w.phaseT -= DT;
      for (i = 0; i < w.cars.length; i++) w.cars[i].prevJump = w.cars[i]['in'].jump;
      if (w.phaseT <= 0) { w.phase = PH_PLAY; w.phaseT = 0; ev.push({ t: 'go' }); }
      return;
    }
    physics(w, ev);
    if (w.phase === PH_PLAY) {
      if (!free) {
        if (w.overtime) w.clock += DT;
        else if (w.clock > 0) { w.clock -= DT; if (w.clock < 0) w.clock = 0; }
      }
      var b = w.ball;
      if (Math.abs(b.py) > HY + BALL_R) {
        var team = b.py > 0 ? 0 : 1;
        w.score[team]++;
        w.phase = PH_GOAL; w.phaseT = free ? 1.5 : GOAL_TIME; w.ballOn = false;
        ev.push({ t: 'goal', team: team, speed: Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz), x: b.px, y: b.py, z: b.pz });
        for (i = 0; i < w.cars.length; i++) {      // goal blast
          c = w.cars[i];
          var dx = c.px - b.px, dy = c.py - b.py, dz = c.pz - b.pz + 60;
          var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 2200 && d > 1 && c.demoT <= 0) {
            var k = (1 - d / 2200) * 1500 / d;
            c.vx += dx * k; c.vy += dy * k; c.vz += dz * k + (1 - d / 2200) * 500;
            c.wx += dy * k * 0.004; c.wy -= dx * k * 0.004;
          }
        }
      } else if (!free && !w.overtime && w.clock <= 0 && w.ballGround) {
        if (w.score[0] === w.score[1]) startOvertime(w, ev);
        else { w.phase = PH_END; ev.push({ t: 'end' }); }
      }
    } else if (w.phase === PH_GOAL) {
      w.phaseT -= DT;
      if (w.phaseT <= 0) {
        if (free) { resetBall(w.ball); w.ballOn = true; w.phase = PH_PLAY; }
        else if (w.overtime || (w.clock <= 0 && w.score[0] !== w.score[1])) { w.phase = PH_END; ev.push({ t: 'end' }); }
        else if (w.clock <= 0) startOvertime(w, ev);
        else { resetKickoff(w); w.phase = PH_COUNTDOWN; w.phaseT = COUNTDOWN_TIME; ev.push({ t: 'kickoff' }); }
      }
    }
  }
  function startOvertime(w, ev) {
    w.overtime = true; w.clock = 0;
    resetKickoff(w); w.phase = PH_COUNTDOWN; w.phaseT = COUNTDOWN_TIME;
    ev.push({ t: 'overtime' });
  }

  // ------------------------------------------------------- ball prediction (bots, shot/save detection)
  var PB = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  function copyBall(d, s) { d.px = s.px; d.py = s.py; d.pz = s.pz; d.vx = s.vx; d.vy = s.vy; d.vz = s.vz; d.wx = s.wx; d.wy = s.wy; d.wz = s.wz; }
  // fills out[] with {t,x,y,z,vx,vy,vz}; returns the team that would score (-1 if none)
  function predictBall(w, out, seconds, hz) {
    var dt = 1 / hz, n = Math.round(seconds * hz), scorer = -1, count = 0;
    copyBall(PB, w.ball);
    if (w.ballOn) for (var i = 0; i < n; i++) {
      stepBall(PB, dt);
      if (out) {
        var o = out[i] || (out[i] = { t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
        o.t = (i + 1) * dt; o.x = PB.px; o.y = PB.py; o.z = PB.pz; o.vx = PB.vx; o.vy = PB.vy; o.vz = PB.vz;
      }
      count++;
      if (Math.abs(PB.py) > HY + BALL_R) { scorer = PB.py > 0 ? 0 : 1; break; }
    }
    if (out) out.length = count;
    return scorer;
  }

  // ------------------------------------------------------- scoring / stats (authority only)
  function MatchTracker(w) {
    this.w = w;
    this.stats = [];
    for (var i = 0; i < w.cars.length; i++) this.stats.push({ goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0, score: 0 });
    this.touches = [];       // most recent last: {car, team, tick}
    this.heading = -1;       // team currently on course to score
    this.lastShotTick = -9999;
  }
  MatchTracker.prototype.update = function (events, out) {
    var w = this.w, i, e, st;
    for (i = 0; i < events.length; i++) {
      e = events[i];
      if (e.t === 'touch') {
        var car = w.cars[e.car]; st = this.stats[e.car];
        st.touches++; st.score += 2;
        var last = this.touches[this.touches.length - 1];
        if (!last || last.car !== e.car) { this.touches.push({ car: e.car, team: car.team, tick: w.tick }); if (this.touches.length > 6) this.touches.shift(); }
        else last.tick = w.tick;
        var now = predictBall(w, null, 3.5, 60);
        if (now === car.team && w.tick - this.lastShotTick > TICK_RATE) {
          st.shots++; st.score += 10; this.lastShotTick = w.tick;
          out.push({ t: 'shot', car: e.car });
        } else if (this.heading !== -1 && this.heading !== car.team && now !== this.heading) {
          st.saves++; st.score += 50;
          out.push({ t: 'save', car: e.car });
        }
        this.heading = now;
      } else if (e.t === 'goal') {
        var scorer = -1, assist = -1, k, tch;
        for (k = this.touches.length - 1; k >= 0; k--) {
          tch = this.touches[k];
          if (tch.team !== e.team) continue;
          if (scorer === -1) scorer = tch.car;
          else if (tch.car !== scorer && w.tick - tch.tick < 8 * TICK_RATE) { assist = tch.car; break; }
        }
        var own = false;
        if (scorer === -1) { own = true; if (this.touches.length) scorer = this.touches[this.touches.length - 1].car; }
        if (scorer !== -1 && !own) { this.stats[scorer].goals++; this.stats[scorer].score += 100; }
        if (assist !== -1) { this.stats[assist].assists++; this.stats[assist].score += 50; }
        this.touches.length = 0; this.heading = -1;
        w.kickoffSeed = (Math.random() * 256) | 0;
        out.push({ t: 'goal', team: e.team, scorer: scorer, assist: assist, own: own, speed: e.speed, x: e.x, y: e.y, z: e.z, score: [w.score[0], w.score[1]] });
      } else if (e.t === 'demo') {
        this.stats[e.a].demos++; this.stats[e.a].score += 25;
        out.push(e);
      } else if (e.t === 'kickoff' || e.t === 'overtime' || e.t === 'go' || e.t === 'end') {
        if (e.t !== 'go') { this.touches.length = 0; this.heading = -1; }
        out.push(e);
      }
    }
    if (w.phase === PH_PLAY && w.tick % 12 === 0) this.heading = predictBall(w, null, 3.5, 60);
  };

  // ------------------------------------------------------- binary snapshots
  var CAR_F = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'qx', 'qy', 'qz', 'qw', 'wx', 'wy', 'wz', 'boost', 'jumpT', 'airT',
    'flipT', 'flipF', 'flipS', 'hb', 'boostT', 'superT', 'demoT', 'autoFlipT', 'autoFlipDir', 'bumpT'];
  var CAR_BYTES = CAR_F.length * 4 + 2 + 5 + 1;
  var BALL_F = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz'];
  var HEADER_BYTES = 18;
  function snapshotSize(w) { return HEADER_BYTES + 36 + PADS.length * 2 + w.cars.length * CAR_BYTES; }

  function encodeWorld(w, dv, o) {
    var i, k, c, f;
    dv.setUint32(o, w.tick, true); o += 4;
    dv.setUint8(o++, w.phase);
    dv.setUint8(o++, (w.overtime ? 1 : 0) | (w.ballOn ? 2 : 0));
    dv.setFloat32(o, w.phaseT, true); o += 4;
    dv.setFloat32(o, w.clock, true); o += 4;
    dv.setUint8(o++, w.score[0]); dv.setUint8(o++, w.score[1]);
    dv.setUint8(o++, w.kickoffSeed); dv.setUint8(o++, w.cars.length);
    for (k = 0; k < 9; k++) { dv.setFloat32(o, w.ball[BALL_F[k]], true); o += 4; }
    for (k = 0; k < PADS.length; k++) { dv.setUint16(o, w.pads[k], true); o += 2; }
    for (i = 0; i < w.cars.length; i++) {
      c = w.cars[i];
      for (k = 0; k < CAR_F.length; k++) { dv.setFloat32(o, c[CAR_F[k]], true); o += 4; }
      var inp = c['in'];
      f = (c.isJumping ? 1 : 0) | (c.hasJumped ? 2 : 0) | (c.hasDJ ? 4 : 0) | (c.hasFlipped ? 8 : 0) | (c.isFlipping ? 16 : 0) |
        (c.prevJump ? 32 : 0) | (c.boosting ? 64 : 0) | (c.superSonic ? 128 : 0) | (c.hullHit ? 256 : 0) |
        (inp.jump ? 512 : 0) | (inp.boost ? 1024 : 0) | (inp.handbrake ? 2048 : 0);
      dv.setUint16(o, f, true); o += 2;
      dv.setInt8(o++, Math.round(inp.steer * 127)); dv.setInt8(o++, Math.round(inp.throttle * 127));
      dv.setInt8(o++, Math.round(inp.pitch * 127)); dv.setInt8(o++, Math.round(inp.yaw * 127)); dv.setInt8(o++, Math.round(inp.roll * 127));
      dv.setUint8(o++, c.ballCd);
    }
    return o;
  }

  function decodeWorld(w, dv, o) {
    var i, k, c, f;
    w.tick = dv.getUint32(o, true); o += 4;
    w.phase = dv.getUint8(o++);
    f = dv.getUint8(o++); w.overtime = !!(f & 1); w.ballOn = !!(f & 2);
    w.phaseT = dv.getFloat32(o, true); o += 4;
    w.clock = dv.getFloat32(o, true); o += 4;
    w.score[0] = dv.getUint8(o++); w.score[1] = dv.getUint8(o++);
    w.kickoffSeed = dv.getUint8(o++);
    var n = dv.getUint8(o++);
    for (k = 0; k < 9; k++) { w.ball[BALL_F[k]] = dv.getFloat32(o, true); o += 4; }
    for (k = 0; k < PADS.length; k++) { w.pads[k] = dv.getUint16(o, true); o += 2; }
    for (i = 0; i < n; i++) {
      c = w.cars[i];
      if (!c) { o += CAR_BYTES; continue; }
      for (k = 0; k < CAR_F.length; k++) { c[CAR_F[k]] = dv.getFloat32(o, true); o += 4; }
      f = dv.getUint16(o, true); o += 2;
      c.isJumping = !!(f & 1); c.hasJumped = !!(f & 2); c.hasDJ = !!(f & 4); c.hasFlipped = !!(f & 8); c.isFlipping = !!(f & 16);
      c.prevJump = !!(f & 32); c.boosting = !!(f & 64); c.superSonic = !!(f & 128); c.hullHit = !!(f & 256);
      var inp = c['in'];
      inp.jump = !!(f & 512); inp.boost = !!(f & 1024); inp.handbrake = !!(f & 2048);
      inp.steer = dv.getInt8(o++) / 127; inp.throttle = dv.getInt8(o++) / 127;
      inp.pitch = dv.getInt8(o++) / 127; inp.yaw = dv.getInt8(o++) / 127; inp.roll = dv.getInt8(o++) / 127;
      c.ballCd = dv.getUint8(o++);
      var q = 1 / (Math.sqrt(c.qx * c.qx + c.qy * c.qy + c.qz * c.qz + c.qw * c.qw) || 1);
      c.qx *= q; c.qy *= q; c.qz *= q; c.qw *= q;
      basis(c);
    }
    return o;
  }

  // 6-byte wire format for one tick of input
  function encodeInput(inp, dv, o) {
    dv.setInt8(o, Math.round(inp.steer * 127)); dv.setInt8(o + 1, Math.round(inp.throttle * 127));
    dv.setInt8(o + 2, Math.round(inp.pitch * 127)); dv.setInt8(o + 3, Math.round(inp.yaw * 127)); dv.setInt8(o + 4, Math.round(inp.roll * 127));
    dv.setUint8(o + 5, (inp.jump ? 1 : 0) | (inp.boost ? 2 : 0) | (inp.handbrake ? 4 : 0));
  }
  function decodeInput(inp, dv, o) {
    inp.steer = dv.getInt8(o) / 127; inp.throttle = dv.getInt8(o + 1) / 127;
    inp.pitch = dv.getInt8(o + 2) / 127; inp.yaw = dv.getInt8(o + 3) / 127; inp.roll = dv.getInt8(o + 4) / 127;
    var f = dv.getUint8(o + 5); inp.jump = !!(f & 1); inp.boost = !!(f & 2); inp.handbrake = !!(f & 4);
    return inp;
  }

  return {
    TICK_RATE: TICK_RATE, DT: DT,
    HX: HX, HY: HY, HZ: HZ, RC: RC, RF: RF, RT: RT, GW: GW, GH: GH, GD: GD,
    BALL_R: BALL_R, GRAVITY: GRAVITY, CAR_MAX_SPEED: CAR_MAX_SPEED, SUPER_ON: SUPER_ON, REST_Z: REST_Z,
    HLX: HLX, HLY: HLY, HLZ: HLZ, HB_OX: HB_OX, HB_OZ: HB_OZ, WHEELS: WHEELS,
    PADS: PADS, KICKOFF: KICKOFF, PAD_BIG_TICKS: PAD_BIG_TICKS, PAD_SMALL_TICKS: PAD_SMALL_TICKS,
    PH_COUNTDOWN: PH_COUNTDOWN, PH_PLAY: PH_PLAY, PH_GOAL: PH_GOAL, PH_END: PH_END,
    COUNTDOWN_TIME: COUNTDOWN_TIME, GOAL_TIME: GOAL_TIME,
    createWorld: createWorld, addCar: addCar, startMatch: startMatch, step: step,
    resetKickoff: resetKickoff, resetBall: resetBall, placeCar: placeCar, basis: basis,
    makeInput: makeInput, quantizeInput: quantizeInput, copyInput: copyInput,
    sdf: sdf, normal: function () { return [NX, NY, NZ]; },
    predictBall: predictBall, MatchTracker: MatchTracker,
    snapshotSize: snapshotSize, encodeWorld: encodeWorld, decodeWorld: decodeWorld,
    encodeInput: encodeInput, decodeInput: decodeInput, INPUT_BYTES: 6,
    clamp: clamp, curve: curve
  };
});
