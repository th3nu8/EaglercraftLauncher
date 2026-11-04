/* Counter Attack — shared game simulation (runs on the Mist server for online matches and in the
 * browser for offline play). Endless team deathmatch: Red vs Blue, respawns, bots fill empty slots.
 * No dependencies. Units are metres and seconds; y is up. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CASim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- weapons ---------- */
  var WEAPONS = {
    rifle:  { name: 'Rifle',  dmg: 26, head: 3,   rate: 0.1,  mag: 30, reload: 2.2, auto: true,  spread: 0.010, move: 0.035, range: 150, bot: true },
    pistol: { name: 'Pistol', dmg: 34, head: 2.8, rate: 0.17, mag: 12, reload: 1.5, auto: false, spread: 0.008, move: 0.02,  range: 100 },
    sniper: { name: 'Sniper', dmg: 95, head: 2.5, rate: 1.25, mag: 5,  reload: 2.8, auto: false, spread: 0.09,  move: 0.12,  range: 300, scope: true }
  };
  var ORDER = ['rifle', 'pistol', 'sniper'];

  /* ---------- map: "Depot" (red base on -x, blue base on +x, mirrored) ---------- */
  var W = 46, D = 30;             // half sizes of the arena
  var boxes = [];                 // [minx, miny, minz, maxx, maxy, maxz, material]
  function box(x0, z0, x1, z1, h, mat, y0) { boxes.push([Math.min(x0, x1), y0 || 0, Math.min(z0, z1), Math.max(x0, x1), (y0 || 0) + h, Math.max(z0, z1), mat || 0]); }
  function mirror(x0, z0, x1, z1, h, mat, y0) { box(x0, z0, x1, z1, h, mat, y0); box(-x0, z0, -x1, z1, h, mat, y0); }
  // outer walls (material 1 = wall)
  box(-W - 1, -D - 1, W + 1, -D, 6, 1); box(-W - 1, D, W + 1, D + 1, 6, 1);
  box(-W - 1, -D, -W, D, 6, 1); box(W, -D, W + 1, D, 6, 1);
  // centre building (material 2 = concrete) with two crates on top as a perch
  box(-4, -4, 4, 4, 3.4, 2);
  // lane walls: split the middle into north / mid / south lanes
  mirror(-24, 11, -8, 12, 3.2, 2); mirror(-24, -11, -8, -12, 3.2, 2);
  // base fronts (cover walls with gaps)
  mirror(-31, -9, -30, -3, 2.6, 1); mirror(-31, 3, -30, 9, 2.6, 1);
  mirror(-37, 15, -33, 16, 2.6, 1); mirror(-37, -15, -33, -16, 2.6, 1);
  // crates (material 3 = crate, 1.2 m: jumpable)
  mirror(-27, -1, -25, 1, 1.2, 3);
  mirror(-19, 4, -17, 6, 1.2, 3); mirror(-19, -6, -17, -4, 1.2, 3);
  mirror(-14, 19, -12, 21, 1.2, 3); mirror(-14, -21, -12, -19, 1.2, 3);
  mirror(-22, 24, -20, 26, 1.2, 3); mirror(-22, -26, -20, -24, 1.2, 3);
  mirror(-9, 1, -7.5, -1, 1.2, 3);
  box(-1, 16, 1, 18, 1.2, 3); box(-1, -18, 1, -16, 1.2, 3);
  box(-1, 24, 1, 26, 2.4, 3); box(-1, -26, 1, -24, 2.4, 3);
  // tall pillars in the side lanes (material 2)
  mirror(-6, 22, -5, 23, 4, 2); mirror(-6, -23, -5, -22, 4, 2);

  // navigation nodes for bots (x, z) and links between them (checked clear of walls)
  var nodes = [
    [-38, 0], [-34, 11], [-34, -11], [-30.5, 0], [-30.5, 12], [-30.5, -12], [-27, 6], [-27, -6], [-21, 0], [-16, 17], [-16, -17], [-14, 6], [-14, -6],
    [-6, 7.5], [-6, -7.5], [0, 7.5], [0, -7.5], [-7, 20], [-7, -20], [0, 21], [0, -21]
  ];
  var n0 = nodes.length;
  for (var i = 0; i < n0; i++) if (nodes[i][0] !== 0) nodes.push([-nodes[i][0], nodes[i][1]]);
  var links = [];
  var NODE_R = 0.45;
  function segClear(a, b) {
    // samples along the segment, checking a body-sized footprint against boxes
    var dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz), steps = Math.ceil(len / 0.5);
    for (var s = 0; s <= steps; s++) {
      var x = a[0] + dx * s / steps, z = a[1] + dz * s / steps;
      for (var k = 0; k < boxes.length; k++) {
        var B = boxes[k];
        if (B[1] > 0.5) continue;
        if (x > B[0] - NODE_R && x < B[3] + NODE_R && z > B[2] - NODE_R && z < B[5] + NODE_R && B[4] > 0.4) return false;
      }
    }
    return true;
  }
  for (var a = 0; a < nodes.length; a++) for (var b = a + 1; b < nodes.length; b++) {
    var d = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
    if (d < 17 && segClear(nodes[a], nodes[b])) links.push([a, b]);
  }
  var adj = nodes.map(function () { return []; });
  links.forEach(function (l) { adj[l[0]].push(l[1]); adj[l[1]].push(l[0]); });

  var SPAWNS = [[], []];
  [[-40, 0], [-40, 5], [-40, -5], [-36, 3], [-36, -3], [-42, 9], [-42, -9], [-38, 12], [-38, -12], [-43, 0]].forEach(function (p) {
    SPAWNS[0].push([p[0], p[1], -Math.PI / 2]); SPAWNS[1].push([-p[0], p[1], Math.PI / 2]);
  });
  var MAP = { name: 'Depot', w: W, d: D, boxes: boxes, nodes: nodes, links: links, spawns: SPAWNS };

  /* ---------- geometry ---------- */
  var PR = 0.32, PH = 1.8, EYE = 1.62;   // player half-width, height, eye height
  function overlaps(x, y, z, B) { return x + PR > B[0] && x - PR < B[3] && z + PR > B[2] && z - PR < B[5] && y + PH > B[1] && y < B[4]; }
  /* Move a body with axis-separated collision. Returns { x, y, z, vy, ground }. */
  function move(p, dx, dy, dz) {
    var x = p.x, y = p.y, z = p.z, vy = p.vy || 0, ground = false, k, B;
    x += dx;
    for (k = 0; k < boxes.length; k++) { B = boxes[k]; if (overlaps(x, y, z, B)) { if (y >= B[4] - 0.35 && B[4] - y > 0) { /* step up small ledges */ y = B[4]; } else x = dx > 0 ? B[0] - PR - 1e-4 : B[3] + PR + 1e-4; } }
    z += dz;
    for (k = 0; k < boxes.length; k++) { B = boxes[k]; if (overlaps(x, y, z, B)) { if (y >= B[4] - 0.35 && B[4] - y > 0) { y = B[4]; } else z = dz > 0 ? B[2] - PR - 1e-4 : B[5] + PR + 1e-4; } }
    y += dy;
    if (y <= 0) { y = 0; vy = 0; ground = true; }
    for (k = 0; k < boxes.length; k++) { B = boxes[k]; if (overlaps(x, y, z, B)) { if (dy <= 0) { y = B[4]; vy = 0; ground = true; } else { y = B[1] - PH - 1e-4; vy = 0; } } }
    return { x: x, y: y, z: z, vy: vy, ground: ground };
  }
  /* Ray vs axis-aligned box (slab test). Returns distance or -1. */
  function rayBox(o, d, b0, b1) {
    var tmin = -Infinity, tmax = Infinity;
    for (var i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < b0[i] || o[i] > b1[i]) return -1; continue; }
      var t1 = (b0[i] - o[i]) / d[i], t2 = (b1[i] - o[i]) / d[i];
      if (t1 > t2) { var t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax || tmax < 0) return -1;
    }
    return tmin >= 0 ? tmin : 0;
  }
  /* Nearest world hit along a ray (boxes + floor). */
  function rayWorld(o, d, max) {
    var best = max || 1e9;
    if (d[1] < 0) { var tf = -o[1] / d[1]; if (tf >= 0 && tf < best) best = tf; }
    for (var k = 0; k < boxes.length; k++) {
      var B = boxes[k], t = rayBox(o, d, [B[0], B[1], B[2]], [B[3], B[4], B[5]]);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }
  function hitboxes(p) {
    return {
      body: [[p.x - 0.36, p.y, p.z - 0.36], [p.x + 0.36, p.y + 1.42, p.z + 0.36]],
      head: [[p.x - 0.2, p.y + 1.42, p.z - 0.2], [p.x + 0.2, p.y + 1.84, p.z + 0.2]]
    };
  }
  /* Ray vs one player: returns { t, head } or null. */
  function rayPlayer(o, d, p) {
    var hb = hitboxes(p), th = rayBox(o, d, hb.head[0], hb.head[1]), tb = rayBox(o, d, hb.body[0], hb.body[1]);
    if (th >= 0 && (tb < 0 || th <= tb + 0.05)) return { t: th, head: true };
    if (tb >= 0) return { t: tb, head: false };
    return null;
  }
  function dirFrom(yaw, pitch) { var c = Math.cos(pitch); return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c]; }
  function lineOfSight(a, b) {
    var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]);
    d = [d[0] / len, d[1] / len, d[2] / len];
    return rayWorld(a, d, len) >= len - 0.05;
  }

  /* ---------- room ---------- */
  var BOT_NAMES = ['Viper', 'Ghost', 'Rook', 'Blaze', 'Nova', 'Hawk', 'Fang', 'Echo', 'Jinx', 'Rex', 'Kite', 'Onyx', 'Bolt', 'Sable', 'Moss', 'Dash', 'Vex', 'Zed', 'Pike', 'Wren'];
  var RESPAWN = 3, PROTECT = 2, SPEED = 6.2, GRAV = 20, JUMP = 6.8;

  function Room(opts) {
    opts = opts || {};
    this.size = opts.size || 10;            // total players (humans + bots)
    this.botsOn = opts.bots !== false;
    this.players = {}; this.score = [0, 0]; this.feed = []; this.feedId = 0; this.time = 0; this.seq = 0;
    this.rand = opts.rand || Math.random;
    this.botSkill = opts.skill || 1;
    this.events = [];                        // hit / kill events for humans (consumed by snapshot)
  }
  Room.prototype.list = function () { var o = []; for (var k in this.players) o.push(this.players[k]); return o; };
  Room.prototype.humans = function () { return this.list().filter(function (p) { return !p.bot; }); };
  Room.prototype.teamCount = function (t) { return this.list().filter(function (p) { return p.team === t; }).length; };
  Room.prototype.spawnPoint = function (team) {
    var self = this, sp = SPAWNS[team], best = null, bestD = -1;
    for (var i = 0; i < 4; i++) {
      var s = sp[Math.floor(this.rand() * sp.length)], near = 1e9;
      this.list().forEach(function (p) { if (!p.dead && p.team !== team) near = Math.min(near, Math.hypot(p.x - s[0], p.z - s[1])); });
      if (near > bestD) { bestD = near; best = s; }
    }
    return best;
  };
  Room.prototype.place = function (p) {
    var s = this.spawnPoint(p.team);
    p.x = s[0] + (this.rand() - 0.5); p.y = 0; p.z = s[1] + (this.rand() - 0.5); p.vy = 0; p.yaw = s[2]; p.pitch = 0;
    p.hp = 100; p.dead = false; p.protect = this.time + PROTECT; p.spawnSeq = (p.spawnSeq || 0) + 1;
    p.path = null; p.target = null;
  };
  Room.prototype.add = function (id, name, bot, team) {
    if (team !== 0 && team !== 1) {
      var h0 = this.humans().filter(function (p) { return p.team === 0; }).length, h1 = this.humans().filter(function (p) { return p.team === 1; }).length;
      team = bot ? (this.teamCount(0) <= this.teamCount(1) ? 0 : 1) : (h0 < h1 ? 0 : h1 < h0 ? 1 : (this.rand() < 0.5 ? 0 : 1));
    }
    var p = { id: id, name: name, bot: !!bot, team: team, k: 0, d: 0, w: 'rifle', shots: 0, seen: this.time, last: this.time, hitLog: [] };
    this.players[id] = p; this.place(p);
    if (!bot) this.balanceBots();
    return p;
  };
  Room.prototype.remove = function (id) { delete this.players[id]; this.balanceBots(); };
  Room.prototype.balanceBots = function () {
    if (!this.botsOn) return;
    var per = Math.ceil(this.size / 2), self = this;
    for (var t = 0; t < 2; t++) {
      var all = this.list().filter(function (p) { return p.team === t; });
      var bots = all.filter(function (p) { return p.bot; });
      var want = Math.max(0, per - (all.length - bots.length));
      while (bots.length > want) { delete this.players[bots.pop().id]; }
      while (bots.length < want) {
        var used = this.list().map(function (p) { return p.name; }), nm = BOT_NAMES.filter(function (n) { return used.indexOf(n) < 0; });
        var name = nm.length ? nm[Math.floor(this.rand() * nm.length)] : 'Bot' + Math.floor(this.rand() * 99);
        var b = this.add('b' + (++this.seq), name, true, t); bots.push(b);
      }
    }
  };
  Room.prototype.say = function (e) { e.id = ++this.feedId; e.at = this.time; this.feed.push(e); if (this.feed.length > 30) this.feed.shift(); };
  /* Apply damage. Returns true if it killed. */
  Room.prototype.damage = function (attacker, victim, dmg, head, weapon) {
    if (!victim || victim.dead || !attacker || attacker.team === victim.team) return false;
    if (victim.protect > this.time) return false;
    victim.hp -= dmg;
    this.events.push({ type: 'hit', from: attacker.id, to: victim.id, dmg: dmg, head: !!head, kill: victim.hp <= 0, x: attacker.x, z: attacker.z });
    if (victim.hp > 0) return false;
    victim.hp = 0; victim.dead = true; victim.respawn = this.time + RESPAWN; victim.killer = attacker.name;
    attacker.k++; victim.d++; this.score[attacker.team]++;
    this.say({ k: attacker.name, kt: attacker.team, v: victim.name, vt: victim.team, w: weapon || attacker.w, h: !!head });
    return true;
  };
  /* A human's reported state (client-side movement). */
  Room.prototype.humanState = function (id, st) {
    var p = this.players[id]; if (!p || p.bot) return null;
    p.seen = this.time;
    if (!p.dead && st && st.s === p.spawnSeq && isFinite(st.x) && isFinite(st.z)) {
      var x = Math.max(-W + PR, Math.min(W - PR, +st.x)), z = Math.max(-D + PR, Math.min(D - PR, +st.z)), y = Math.max(0, Math.min(8, +st.y || 0));
      p.x = x; p.y = y; p.z = z;
      p.yaw = +st.yaw || 0; p.pitch = Math.max(-1.5, Math.min(1.5, +st.pitch || 0));
      if (WEAPONS[st.w]) p.w = st.w;
      if (st.f > p.shots) p.shots = Math.min(st.f, p.shots + 20);
      p.mv = !!st.mv;
    }
    return p;
  };
  /* Hits a human says they made: [{ t: targetId, h: head }]. Damage is decided here. */
  Room.prototype.humanHits = function (id, hits) {
    var p = this.players[id], self = this; if (!p || p.dead || !Array.isArray(hits)) return;
    var wpn = WEAPONS[p.w] || WEAPONS.rifle;
    p.hitLog = p.hitLog.filter(function (t) { return t > self.time - 1; });
    hits.slice(0, 12).forEach(function (h) {
      var v = self.players[h && h.t];
      if (!v || v.dead || v.team === p.team) return;
      if (p.hitLog.length >= Math.ceil(1 / wpn.rate) + 3) return;          // faster than the gun can fire
      if (Math.hypot(v.x - p.x, v.z - p.z) > wpn.range + 5) return;
      p.hitLog.push(self.time);
      self.damage(p, v, Math.round(wpn.dmg * (h.h ? wpn.head : 1)), h.h, p.w);
    });
  };
  /* ---------- bots ---------- */
  function nearestNode(x, z) { var b = 0, bd = 1e9; for (var i = 0; i < nodes.length; i++) { var d = Math.hypot(nodes[i][0] - x, nodes[i][1] - z); if (d < bd && segClear([x, z], nodes[i])) { bd = d; b = i; } } return b; }
  function pathTo(a, b) {
    var prev = {}, q = [a], seen = {}; seen[a] = 1;
    while (q.length) { var n = q.shift(); if (n === b) break; adj[n].forEach(function (m) { if (!seen[m]) { seen[m] = 1; prev[m] = n; q.push(m); } }); }
    if (!seen[b]) return [b];
    var path = [b]; while (path[0] !== a) path.unshift(prev[path[0]]); return path;
  }
  function angDiff(a, b) { var d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
  Room.prototype.botThink = function (b, dt) {
    var self = this, R = this.rand, enemyX = b.team === 0 ? 1 : -1;
    // look for an enemy every 0.2 s
    b.scan = (b.scan || 0) - dt;
    if (b.scan <= 0) {
      b.scan = 0.2;
      var eye = [b.x, b.y + EYE, b.z], best = null, bd = 55;
      this.list().forEach(function (p) {
        if (p.dead || p.team === b.team) return;
        var d = Math.hypot(p.x - b.x, p.z - b.z); if (d > bd) return;
        // bots see within ~120 degrees, or anyone who just shot them
        var fwd = Math.abs(angDiff(b.yaw, Math.atan2(-(p.x - b.x), -(p.z - b.z))));
        if (fwd > 1.1 && b.hurtBy !== p.id) return;
        if (lineOfSight(eye, [p.x, p.y + 1.3, p.z])) { best = p; bd = d; }
      });
      if (best && (!b.target || b.target !== best.id)) { b.react = this.time + (0.3 + R() * 0.45) / this.botSkill; }
      b.target = best ? best.id : null;
    }
    var t = b.target && this.players[b.target], mvx = 0, mvz = 0;
    if (t && !t.dead) {
      var dx = t.x - b.x, dz = t.z - b.z, dist = Math.hypot(dx, dz);
      var wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(t.y + 1.25 - (b.y + EYE), dist);
      var turn = 7 * dt * this.botSkill;
      var dy = angDiff(b.yaw, wantYaw); b.yaw += Math.max(-turn, Math.min(turn, dy));
      b.pitch += Math.max(-turn, Math.min(turn, wantPitch - b.pitch));
      // strafe and hold a comfortable distance
      b.strafeT = (b.strafeT || 0) - dt; if (b.strafeT <= 0) { b.strafe = R() < 0.5 ? -1 : 1; b.strafeT = 0.5 + R() * 1.1; }
      var sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw), fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
      var fwdAmt = dist > 22 ? 0.8 : dist < 8 ? -0.6 : 0;
      mvx = sx * b.strafe * 0.85 + fx * fwdAmt; mvz = sz * b.strafe * 0.85 + fz * fwdAmt;
      // fire
      b.cool = (b.cool || 0) - dt;
      if (this.time > b.react && Math.abs(dy) < 0.2 && b.cool <= 0) {
        b.burst = (b.burst || 0) + 1;
        b.cool = WEAPONS.rifle.rate * (b.burst > 4 + R() * 4 ? (b.burst = 0, 4 + R() * 5) : 1.15);
        b.shots++;
        var chance = Math.max(0.1, Math.min(0.62, 0.66 - dist * 0.012)) * (t.mv ? 0.8 : 1) * this.botSkill;
        if (R() < chance) this.damage(b, t, Math.round(WEAPONS.rifle.dmg * (R() < 0.12 ? WEAPONS.rifle.head : 1)), false, 'rifle');
      }
    } else {
      // walk the navigation graph toward the enemy half
      if (!b.path || !b.path.length) {
        var goals = [];
        for (var i = 0; i < nodes.length; i++) if (nodes[i][0] * enemyX > 4 || (R() < 0.25 && Math.abs(nodes[i][0]) < 20)) goals.push(i);
        b.path = pathTo(nearestNode(b.x, b.z), goals[Math.floor(R() * goals.length)]);
      }
      var nd = nodes[b.path[0]], ddx = nd[0] - b.x, ddz = nd[1] - b.z, dd = Math.hypot(ddx, ddz);
      if (dd < 1.2) b.path.shift();
      else {
        mvx = ddx / dd; mvz = ddz / dd;
        var wy = Math.atan2(-ddx, -ddz), turn2 = 5 * dt; b.yaw += Math.max(-turn2, Math.min(turn2, angDiff(b.yaw, wy)));
        b.pitch *= 0.9;
      }
    }
    // move with collision; jump if stuck
    var sp = SPEED * 0.92, r = move(b, mvx * sp * dt, (b.vy - GRAV * dt) * dt, mvz * sp * dt);
    var moved = Math.hypot(r.x - b.x, r.z - b.z);
    b.vy = r.ground ? 0 : (b.vy - GRAV * dt);
    if ((mvx || mvz) && moved < sp * dt * 0.3) { b.stuck = (b.stuck || 0) + dt; if (r.ground && b.stuck > 0.4) b.vy = JUMP; if (b.stuck > 1.4) { b.path = null; b.stuck = 0; } } else b.stuck = 0;
    b.x = r.x; b.y = r.y; b.z = r.z; b.mv = moved > 0.01;
  };
  Room.prototype.step = function (dt) {
    dt = Math.min(dt, 0.1); this.time += dt;
    var self = this;
    this.list().forEach(function (p) {
      if (p.dead) { if (self.time >= p.respawn) self.place(p); return; }
      if (p.bot) self.botThink(p, dt);
    });
  };
  /* Drop humans who stopped sending updates. */
  Room.prototype.prune = function (timeout) {
    var self = this, gone = false;
    this.humans().forEach(function (p) { if (self.time - p.seen > timeout) { delete self.players[p.id]; gone = true; } });
    if (gone) this.balanceBots();
  };
  /* What one player needs to draw the match. */
  Room.prototype.snapshot = function (forId, sinceFeed) {
    var me = this.players[forId], self = this;
    var ps = this.list().map(function (p) {
      return { id: p.id, n: p.name, t: p.team, b: p.bot ? 1 : 0, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pi: +p.pitch.toFixed(3),
        w: p.w, f: p.shots, d: p.dead ? 1 : 0, k: p.k, de: p.d, pr: p.protect > self.time ? 1 : 0, mv: p.mv ? 1 : 0, hp: p.id === forId ? Math.max(0, Math.round(p.hp)) : undefined };
    });
    var ev = this.events.filter(function (e) { return e.to === forId || e.from === forId; });
    var out = { time: +this.time.toFixed(2), score: this.score.slice(), players: ps, feed: this.feed.filter(function (f) { return f.id > (sinceFeed || 0); }), events: ev };
    if (me) out.you = { id: me.id, team: me.team, hp: Math.max(0, Math.round(me.hp)), dead: me.dead, respawnIn: me.dead ? Math.max(0, +(me.respawn - this.time).toFixed(1)) : 0,
      killer: me.dead ? me.killer : null, s: me.spawnSeq, spawn: [me.x, me.y, me.z, me.yaw] };
    return out;
  };
  Room.prototype.clearEvents = function (forId) { this.events = this.events.filter(function (e) { return e.to !== forId && e.from !== forId; }); };
  Room.prototype.flushEvents = function () { var t = this.time; this.events = this.events.filter(function (e) { return (e.at = e.at || t) > t - 2; }); };

  return { WEAPONS: WEAPONS, ORDER: ORDER, MAP: MAP, Room: Room, move: move, rayWorld: rayWorld, rayPlayer: rayPlayer, rayBox: rayBox,
    dirFrom: dirFrom, lineOfSight: lineOfSight, hitboxes: hitboxes, PR: PR, PH: PH, EYE: EYE, SPEED: SPEED, GRAV: GRAV, JUMP: JUMP, RESPAWN: RESPAWN };
});
