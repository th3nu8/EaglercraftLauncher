#!/usr/bin/env node
/* Builds versions/csattack.html (one self-contained file Mist can load) from
 * games/counter-attack/game.html + Three.js (MIT) + the shared simulation in server/. */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
let html = read('games/counter-attack/game.html');
html = html.replace('/*THREE*/', () => safe(read('tools/vendor/three-0.149.0.min.js')))
           .replace('/*SIM*/', () => safe(read('server/counter-attack-sim.js')));
fs.writeFileSync(path.join(root, 'versions/csattack.html'), html);
console.log('versions/csattack.html', (html.length / 1024).toFixed(0) + ' KB');
