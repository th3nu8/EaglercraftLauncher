#!/usr/bin/env node
'use strict';
/*
 * Recover accounts from another Mist data folder.
 *
 *   sudo systemctl stop eaglercraft-saves
 *   node merge-data.js /path/to/OTHER/data /opt/eaglercraft-saves/data
 *   sudo chown -R www-data:www-data /opt/eaglercraft-saves/data
 *   sudo systemctl start eaglercraft-saves
 *
 * Adds every account from OTHER that the target doesn't have (matched by name, any case),
 * with its cloud save, friends, stats, achievements and chats. Accounts that exist in both are left
 * alone. The target's db.json is backed up first. Nothing in OTHER is changed.
 */
const fs = require('fs');
const path = require('path');

const [fromDir, toDir] = process.argv.slice(2).map(p => p && path.resolve(p));
if (!fromDir || !toDir) { console.log('Usage: node merge-data.js <from-data-folder> <to-data-folder>'); process.exit(1); }
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
const from = read(fromDir);
let to; try { to = read(toDir); } catch (e) { to = { users: {}, sessions: {}, saves: {} }; }
for (const k of ['users', 'sessions', 'saves', 'social', 'messages', 'reads', 'stats', 'ach', 'gameAch', 'gstats', 'hookAch']) { from[k] = from[k] || {}; to[k] = to[k] || {}; }
if (fs.existsSync(path.join(toDir, 'server.lock'))) {
  const pid = parseInt(fs.readFileSync(path.join(toDir, 'server.lock'), 'utf8'), 10);
  try { process.kill(pid, 0); console.log(`A server (pid ${pid}) is still using ${toDir}. Stop it first.`); process.exit(1); } catch (e) {}
}

const added = [], skipped = [];
const idMap = {}; // from-uid -> to-uid
for (const [key, u] of Object.entries(from.users)) {
  if (to.users[key]) { skipped.push(u.name); idMap[u.id] = to.users[key].id; continue; }
  to.users[key] = u; idMap[u.id] = u.id; added.push(u.name);
  if (from.saves[u.id]) {
    to.saves[u.id] = from.saves[u.id];
    fs.mkdirSync(path.join(toDir, 'saves'), { recursive: true });
    const src = path.join(fromDir, 'saves', u.id + '.bin');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(toDir, 'saves', u.id + '.bin'));
  }
  if (from.stats[u.id]) to.stats[u.id] = from.stats[u.id];
  if (from.ach[u.id]) to.ach[u.id] = from.ach[u.id];
  if (from.gameAch[u.id]) to.gameAch[u.id] = from.gameAch[u.id];
  if (from.gstats[u.id]) to.gstats[u.id] = from.gstats[u.id];
  if (from.hookAch[u.id]) to.hookAch[u.id] = from.hookAch[u.id];
}
const addedIds = new Set(added.map(n => from.users[n.toLowerCase()].id));
// friends / requests for the added accounts (pointing at accounts that exist in the target)
for (const id of addedIds) {
  const s = from.social[id]; if (!s) continue;
  const map = list => (list || []).map(x => idMap[x]).filter(Boolean);
  to.social[id] = { friends: map(s.friends), incoming: map(s.incoming), outgoing: map(s.outgoing), recent: s.recent || [], lastSeen: s.lastSeen || 0 };
  for (const [field, back] of [['friends', 'friends'], ['incoming', 'outgoing'], ['outgoing', 'incoming']]) {
    for (const other of to.social[id][field]) {
      const o = to.social[other] || (to.social[other] = { friends: [], incoming: [], outgoing: [], recent: [], lastSeen: 0 });
      if (!o[back].includes(id)) o[back].push(id);
    }
  }
}
// chats involving added accounts
to.msgSeq = Math.max(to.msgSeq || 0, 0);
for (const [pair, msgs] of Object.entries(from.messages)) {
  const [a, b] = pair.split(':');
  if (!addedIds.has(a) && !addedIds.has(b)) continue;
  const A = idMap[a], B = idMap[b]; if (!A || !B) continue;
  const key = A < B ? A + ':' + B : B + ':' + A;
  if (to.messages[key]) continue;
  to.messages[key] = msgs.map(m => ({ ...m, id: ++to.msgSeq, from: idMap[m.from] || m.from }));
}

const dbFile = path.join(toDir, 'db.json');
if (fs.existsSync(dbFile)) {
  fs.mkdirSync(path.join(toDir, 'backups'), { recursive: true });
  const bak = path.join(toDir, 'backups', 'before-merge-' + Date.now() + '.json');
  fs.copyFileSync(dbFile, bak); console.log('Backed up target to', bak);
}
fs.writeFileSync(dbFile + '.tmp', JSON.stringify(to)); fs.renameSync(dbFile + '.tmp', dbFile);
console.log(`Added ${added.length} account(s): ${added.join(', ') || '-'}`);
console.log(`Already there (kept as-is): ${skipped.length}${skipped.length ? ' - ' + skipped.join(', ') : ''}`);
console.log(`Total accounts now: ${Object.keys(to.users).length}`);
