#!/usr/bin/env node
/* Give or take away Mist admin powers. Run it next to server.js:
 *   node mist-admin.js add <username>
 *   node mist-admin.js remove <username>
 *   node mist-admin.js list
 * Admins get an "Admin dashboard" button in their Mist account menu (announcements, bans, sign-outs).
 * The running server picks up changes straight away; no restart needed. */
'use strict';
const fs = require('fs');
const path = require('path');

const ADMINS_FILE = path.join(__dirname, 'admins.json');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');

function readAdmins() {
  try { return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')).map(String); } catch (e) { return []; }
}
function writeAdmins(list) {
  const tmp = ADMINS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, ADMINS_FILE);
}
function findUser(name) {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('Could not read ' + DB_FILE + ': ' + e.message); process.exit(1); }
  return (db.users || {})[name.toLowerCase()] || null;
}

const [cmd, nameArg] = process.argv.slice(2);
const admins = readAdmins();

if (cmd === 'list') {
  console.log(admins.length ? 'Admins: ' + admins.join(', ') : 'No admins yet.');
} else if ((cmd === 'add' || cmd === 'remove') && nameArg) {
  const user = findUser(nameArg);
  const lower = nameArg.toLowerCase();
  const rest = admins.filter(n => n.toLowerCase() !== lower);
  if (cmd === 'add') {
    if (!user) { console.error('No Mist account called "' + nameArg + '".'); process.exit(1); }
    writeAdmins(rest.concat(user.name));
    console.log(user.name + ' is now an admin. They can open the Admin dashboard from their account menu in Mist.');
  } else {
    if (rest.length === admins.length) { console.log(nameArg + ' was not an admin.'); process.exit(0); }
    writeAdmins(rest);
    console.log(nameArg + ' is no longer an admin.');
  }
} else {
  console.log('Usage:\n  node mist-admin.js add <username>\n  node mist-admin.js remove <username>\n  node mist-admin.js list');
  process.exit(cmd ? 1 : 0);
}
