// Three.js scene: arena, cars, ball, effects and the chase camera.
// Sim space is z-up in uu; the scene is y-up in metres: (x, y, z) -> (x, z, -y) * 0.01.
import * as THREE from '../vendor/three.module.min.js';

const S = window.OBSim;
const K = 0.01;
export const TEAM_HEX = [0x12b5de, 0xff5533];
export const TEAM_NAME = ['Tide', 'Flare'];
const CHALK = 0xf2f4f1, INK = 0x17122b, BOOST = 0xffc21a;
const P = (x, y, z) => new THREE.Vector3(x * K, z * K, -y * K);

// ------------------------------------------------------------------ textures
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const css = (hex, a = 1) => `rgba(${hex >> 16 & 255},${hex >> 8 & 255},${hex & 255},${a})`;

function floorTexture() {
  return canvasTex(1024, 1280, (g, W, H) => {
    const X = x => (x + S.HX) / (2 * S.HX) * W, Y = y => (1 - (y + S.HY) / (2 * S.HY)) * H, L = d => d / (2 * S.HX) * W;
    for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#10625a' : '#0d544e'; g.fillRect(0, i * H / 16, W, H / 16 + 1); }
    for (const [team, y] of [[0, -S.HY], [1, S.HY]]) {
      const gr = g.createRadialGradient(X(0), Y(y), 0, X(0), Y(y), L(3800));
      gr.addColorStop(0, css(TEAM_HEX[team], 0.34)); gr.addColorStop(0.5, css(TEAM_HEX[team], 0.1)); gr.addColorStop(1, css(TEAM_HEX[team], 0));
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    g.strokeStyle = 'rgba(242,244,241,0.9)'; g.lineWidth = 4; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(X(-S.HX), Y(0)); g.lineTo(X(S.HX), Y(0)); g.stroke();
    g.beginPath(); g.arc(X(0), Y(0), L(1024), 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(242,244,241,0.9)'; g.beginPath(); g.arc(X(0), Y(0), L(60), 0, Math.PI * 2); g.fill();
    for (const s of [-1, 1]) {
      g.strokeRect(X(-1700), Math.min(Y(s * S.HY), Y(s * (S.HY - 1300))), L(3400), L(1300));
      g.strokeRect(X(-1050), Math.min(Y(s * S.HY), Y(s * (S.HY - 520))), L(2100), L(520));
    }
    // boundary where the wall ramp begins
    const r = L(S.RC - S.RF), x0 = X(-S.HX + S.RF), y0 = Y(S.HY - S.RF), w = L(2 * (S.HX - S.RF)), h = L(2 * (S.HY - S.RF));
    g.lineWidth = 3; g.strokeStyle = 'rgba(242,244,241,0.55)';
    g.beginPath(); g.moveTo(x0 + r, y0); g.arcTo(x0 + w, y0, x0 + w, y0 + h, r); g.arcTo(x0 + w, y0 + h, x0, y0 + h, r); g.arcTo(x0, y0 + h, x0, y0, r); g.arcTo(x0, y0, x0 + w, y0, r); g.closePath(); g.stroke();
  });
}
function gridTexture(line, fill) {
  const t = canvasTex(128, 128, (g, W, H) => {
    g.clearRect(0, 0, W, H);
    g.fillStyle = `rgba(255,255,255,${fill})`; g.fillRect(0, 0, W, H);
    g.fillStyle = `rgba(255,255,255,${line})`; g.fillRect(0, 0, W, 4); g.fillRect(0, 0, 4, H);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function dotTexture() {
  return canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}
function shadowTexture() {
  return canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 8, 32, 32, 32);
    gr.addColorStop(0, 'rgba(6,4,15,1)'); gr.addColorStop(0.6, 'rgba(6,4,15,0.75)'); gr.addColorStop(1, 'rgba(6,4,15,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}
function ballTexture() {
  return canvasTex(512, 256, (g, W, H) => {
    g.fillStyle = '#f2f4f1'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 8; i++) {           // lens-shaped panels so spin is easy to read
      g.fillStyle = i % 2 ? '#d3d9d6' : '#f2f4f1';
      g.fillRect(i * W / 8, 0, W / 8, H);
    }
    g.fillStyle = '#ffc21a'; g.fillRect(0, H * 0.44, W, H * 0.12);
    g.strokeStyle = '#17122b'; g.lineWidth = 5;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * W / 8, 0); g.lineTo(i * W / 8, H); g.stroke(); }
    g.beginPath(); g.moveTo(0, H * 0.44); g.lineTo(W, H * 0.44); g.moveTo(0, H * 0.56); g.lineTo(W, H * 0.56); g.stroke();
    g.fillStyle = '#17122b';
    for (let i = 0; i < 8; i++) { g.beginPath(); g.arc((i + 0.5) * W / 8, i % 2 ? H * 0.25 : H * 0.75, 11, 0, Math.PI * 2); g.fill(); }
  });
}

// ------------------------------------------------------------------ arena geometry
// outer wall outline, counter-clockwise seen from above, with inward normals
function perimeter() {
  const { HX, HY, RC, GW } = S, cx = HX - RC, cy = HY - RC, N = 14, pts = [];
  const add = (x, y, nx, ny) => pts.push({ x, y, nx, ny });
  const arc = (ox, oy, a0) => { for (let i = 0; i <= N; i++) { const a = a0 + i / N * Math.PI / 2; add(ox + RC * Math.cos(a), oy + RC * Math.sin(a), -Math.cos(a), -Math.sin(a)); } };
  add(HX, -cy * 0.33, -1, 0); add(HX, cy * 0.33, -1, 0);
  arc(cx, cy, 0);
  add(GW, HY, 0, -1); add(-GW, HY, 0, -1);
  arc(-cx, cy, Math.PI / 2);
  add(-HX, cy * 0.33, 1, 0); add(-HX, -cy * 0.33, 1, 0);
  arc(-cx, -cy, Math.PI);
  add(-GW, -HY, 0, 1); add(GW, -HY, 0, 1);
  arc(cx, -cy, Math.PI * 1.5);
  let s = 0;
  for (let i = 0; i < pts.length; i++) { pts[i].s = s; const n = pts[(i + 1) % pts.length]; s += Math.hypot(n.x - pts[i].x, n.y - pts[i].y); }
  return pts;
}

function buildWalls(grid) {
  const { RF, RT, HZ, GH, GW, HY } = S, M = 7;
  const full = [], mouth = [[0, GH]];
  for (let i = 0; i <= M; i++) { const a = i / M * Math.PI / 2; full.push([RF * (1 - Math.sin(a)), RF * (1 - Math.cos(a))]); }
  const top = [];
  for (let i = 0; i <= M; i++) { const a = i / M * Math.PI / 2; top.push([RT * (1 - Math.cos(a)), HZ - RT + RT * Math.sin(a)]); }
  full.push(...top); mouth.push(...top);
  const pos = [], uv = [], col = [];
  const violet = new THREE.Color(0x7a5cc4), tc = [new THREE.Color(TEAM_HEX[0]), new THREE.Color(TEAM_HEX[1])], tmp = new THREE.Color();
  const vert = (p, d, z, u, v) => {
    const x = p.x + p.nx * d, y = p.y + p.ny * d;
    pos.push(x * K, z * K, -y * K); uv.push(u, v);
    const t = Math.min(1, Math.pow(Math.abs(y) / HY, 1.6));
    tmp.copy(violet).lerp(tc[y < 0 ? 0 : 1], t * 0.9);
    const a = z > HZ - 1 ? 0.3 : 0.95 - 0.55 * Math.min(1, z / 1100);
    col.push(tmp.r, tmp.g, tmp.b, a);
  };
  const per = perimeter(), n = per.length;
  for (let i = 0; i < n; i++) {
    const a = per[i], b = per[(i + 1) % n];
    const isMouth = Math.abs(a.y) === HY && Math.abs(b.y) === HY && Math.abs(a.x) <= GW + 1 && Math.abs(b.x) <= GW + 1;
    const prof = isMouth ? mouth : full;
    const ua = a.s / 512, ub = (a.s + Math.hypot(b.x - a.x, b.y - a.y)) / 512;
    let v = 0;
    for (let j = 0; j < prof.length - 1; j++) {
      const p0 = prof[j], p1 = prof[j + 1];
      const v1 = v + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 512;
      // quad A(a,j) B(b,j) C(b,j+1) D(a,j+1); inward-facing triangles are A,C,B and A,D,C
      vert(a, p0[0], p0[1], ua, v); vert(b, p1[0], p1[1], ub, v1); vert(b, p0[0], p0[1], ub, v);
      vert(a, p0[0], p0[1], ua, v); vert(a, p1[0], p1[1], ua, v1); vert(b, p1[0], p1[1], ub, v1);
      v = v1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: grid, vertexColors: true, transparent: true, depthWrite: false }));
  m.renderOrder = 2;
  return m;
}

function flatShape(inset) {
  const sh = new THREE.Shape();
  perimeter().forEach((p, i) => { const x = p.x + p.nx * inset, y = p.y + p.ny * inset; if (i) sh.lineTo(x, y); else sh.moveTo(x, y); });
  sh.closePath();
  return sh;
}

// quad from four sim-space corners
function quad(a, b, c, d, mat, ru = 1, rv = 1) {
  const g = new THREE.BufferGeometry();
  const v = [a, b, c, a, c, d].flatMap(p => [p[0] * K, p[2] * K, -p[1] * K]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, ru, 0, ru, rv, 0, 0, ru, rv, 0, rv], 2));
  return new THREE.Mesh(g, mat);
}

// convex 8-corner solid: corners 0-3 bottom ring, 4-7 top ring (same order)
function hull8(c, mat) {
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  const v = [];
  for (const i of idx) v.push(c[i][0] * K, c[i][2] * K, -c[i][1] * K);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
// box-ish solid from x range, half-widths and heights at the rear and front
function slab(x0, x1, w0, w1, zb0, zb1, zt0, zt1, mat) {
  return hull8([[x0, w0, zb0], [x1, w1, zb1], [x1, -w1, zb1], [x0, -w0, zb0], [x0, w0, zt0], [x1, w1, zt1], [x1, -w1, zt1], [x0, -w0, zt0]], mat);
}

// thin strut between two sim-space points (roll cages, braces)
function bar(a, b, t, mat) {
  const pa = P(a[0], a[1], a[2]), pb = P(b[0], b[1], b[2]);
  const m = new THREE.Mesh(new THREE.BoxGeometry(t * K, t * K, pa.distanceTo(pb)), mat);
  m.position.copy(pa).add(pb).multiplyScalar(0.5); m.lookAt(pb);
  return m;
}
// one side's block: x range, y range (outer, inner), z bottom and top at the rear and front
function sideBlock(x0, x1, yo, yi, zb, zt0, zt1, s, mat) {
  return hull8([[x0, s * yo, zb], [x1, s * yo, zb], [x1, s * yi, zb], [x0, s * yi, zb], [x0, s * yo, zt0], [x1, s * yo, zt1], [x1, s * yi, zt1], [x0, s * yi, zt0]], mat);
}

// Car looks. Every body shares the same hitbox and handling; only the shell differs.
export const BODIES = ['Kite', 'Anvil', 'Comet', 'Loaf', 'Dune'];
export const TRIMS = [['Chalk', 0xf2f4f1], ['Gold', 0xffc21a], ['Lime', 0xa6e22e], ['Pink', 0xff5fa8], ['Violet', 0x9b6bff], ['Mint', 0x5df2c2], ['Graphite', 0x2b2740], ['Silver', 0xb9c2cc]];
const WHEEL_SPECS = [
  [[51.25, 37, 13.5, 13], [51.25, -37, 13.5, 13], [-33.75, 38, 15.5, 13], [-33.75, -38, 15.5, 13]],
  [[50, 38, 15.5, 14], [50, -38, 15.5, 14], [-34, 39, 16.5, 14], [-34, -39, 16.5, 14]],
  [[51.25, 35, 13.5, 14], [51.25, -35, 13.5, 14], [-33.75, 36, 16, 18], [-33.75, -36, 16, 18]],
  [[50, 38, 13, 12], [50, -38, 13, 12], [-34, 38.5, 13, 12], [-34, -38.5, 13, 12]],
  [[52, 36, 14.5, 13], [52, -36, 14.5, 13], [-34, 41, 18, 16], [-34, -41, 18, 16]]
];
const SHELLS = [
  // Kite: wedge coupe with a wing
  (g, m) => {
    g.add(slab(-46, 73, 40, 33, -7, -7, 15, 5, m.paint));            // body, hood slopes forward
    g.add(slab(-48, 76, 41, 34, -9, -9, -5, -5, m.dark));            // floor / bumpers
    g.add(slab(-30, 26, 31, 29, 14, 9, 14.2, 9.2, m.dark));
    g.add(hull8([[-30, 30, 14], [26, 28, 9.5], [26, -28, 9.5], [-30, -30, 14], [-22, 23, 34], [6, 23, 32], [6, -23, 32], [-22, -23, 34]], m.glass)); // cabin
    g.add(slab(-22, 6, 15, 15, 34, 32, 35, 33, m.paint));            // roof panel
    g.add(slab(27, 73.5, 9, 7, 9.6, 5.3, 10.4, 6.1, m.trim));        // hood stripe
    g.add(slab(-46.5, -30, 9, 9, 15.2, 14.2, 16, 15, m.trim));       // tail stripe
    g.add(slab(-52, -38, 40, 40, 35, 35, 37.5, 38.5, m.dark));       // wing
    for (const s of [-1, 1]) g.add(sideBlock(-47, -42, 29, 25, 14, 36, 36, s, m.dark));
  },
  // Anvil: square pickup with an open bed
  (g, m) => {
    g.add(slab(-50, 76, 42, 41, -9, -9, -5, -5, m.dark));
    g.add(slab(-48, 74, 41, 40, -6, -6, 13, 13, m.paint));           // lower body
    g.add(slab(28, 74, 39, 37, 13, 13, 20, 17, m.paint));            // hood
    g.add(hull8([[-10, 37, 13], [30, 37, 13], [30, -37, 13], [-10, -37, 13], [-6, 32, 37], [22, 32, 37], [22, -32, 37], [-6, -32, 37]], m.glass)); // cab
    g.add(slab(-7, 23, 32.5, 32.5, 37, 37, 39.5, 39.5, m.paint));    // roof
    for (const s of [-1, 1]) g.add(sideBlock(-48, -10, 41, 34, 13, 23, 23, s, m.paint));   // bed rails
    g.add(slab(-51, -46, 41, 41, 13, 13, 23, 23, m.paint));          // tailgate
    g.add(slab(-48, -12, 34, 34, 12.5, 12.5, 14, 14, m.dark));       // bed floor
    g.add(slab(74, 80, 38, 38, -7, -7, 9, 9, m.dark));               // bull bar
    g.add(slab(30, 73, 9, 8, 20.3, 17.3, 21, 18, m.trim));           // hood stripe
    g.add(slab(-51.6, -50.6, 30, 30, 15, 15, 21, 21, m.trim));       // tailgate badge
  },
  // Comet: low single-seater with wings front and back
  (g, m) => {
    g.add(slab(-46, 30, 24, 15, -8, -8, -5, -5, m.dark));
    g.add(slab(-44, 22, 24, 15, -6, -5, 11, 7, m.paint));            // tub
    g.add(slab(22, 80, 15, 6, -5, -3, 7, 0, m.paint));               // nose
    for (const s of [-1, 1]) {
      g.add(sideBlock(-42, 12, 40, 22, -6, 7, 3, s, m.paint));       // side pods
      g.add(sideBlock(-55, -46, 30, 27, 8, 31, 31, s, m.dark));      // wing struts
    }
    g.add(hull8([[-20, 12, 10], [12, 9, 7.5], [12, -9, 7.5], [-20, -12, 10], [-16, 9, 22], [0, 8, 20], [0, -8, 20], [-16, -9, 22]], m.glass)); // canopy
    g.add(slab(-40, -20, 9, 10, 10, 10, 27, 22, m.paint));           // engine cover
    g.add(slab(64, 82, 40, 40, -8, -8, -5, -4.5, m.trim));           // front wing
    g.add(slab(-58, -42, 40, 40, 31, 31, 33.5, 35, m.trim));         // rear wing
    g.add(slab(24, 78, 2.5, 1.5, 7.2, 0.2, 8, 1, m.trim));           // nose stripe
  },
  // Loaf: tall van with glass all round
  (g, m) => {
    g.add(slab(-52, 76, 41, 39, -9, -9, -5, -5, m.dark));
    g.add(slab(-50, 73, 40, 38, -6, -6, 14, 14, m.paint));           // lower body
    g.add(hull8([[-49, 39, 14], [70, 37, 14], [70, -37, 14], [-49, -39, 14], [-46, 34, 39], [54, 33, 39], [54, -33, 39], [-46, -34, 39]], m.glass));
    g.add(slab(-47, 55, 34.5, 33.5, 39, 39, 42, 41, m.paint));       // roof
    g.add(slab(-50.6, 73.6, 40.6, 38.6, 10.5, 10.5, 14.6, 14.6, m.trim)); // belt line
    for (const s of [-1, 1]) {
      g.add(hull8([[8, s * 38.5, 14], [14, s * 38.4, 14], [14, s * 36, 14], [8, s * 36, 14], [8, s * 34.5, 39], [14, s * 34.4, 39], [14, s * 32, 39], [8, s * 32, 39]], m.paint)); // door pillar
      g.add(sideBlock(70, 74.5, 31, 20, 2, 9, 9, s, m.trim));        // lamps
    }
    g.add(slab(-44, -6, 26, 26, 42, 42, 44, 44, m.dark));            // roof rack
  },
  // Dune: open buggy with a roll cage and big rear tyres
  (g, m) => {
    g.add(slab(-44, 62, 28, 20, -8, -8, -5, -5, m.dark));
    g.add(slab(-42, 60, 28, 20, -6, -5, 8, 5, m.paint));             // tub
    g.add(slab(60, 76, 20, 13, -5, -3, 5, 0, m.paint));              // nose
    g.add(slab(-48, -24, 22, 22, 8, 8, 21, 17, m.dark));             // engine
    g.add(slab(-10, 4, 12, 12, 8, 8, 20, 18, m.dark));               // seat
    for (const s of [-1, 1]) {
      g.add(sideBlock(-54, -14, 45, 29, 9, 13, 13, s, m.paint));     // rear fenders
      g.add(bar([18, s * 24, 6], [6, s * 20, 37], 3, m.dark));
      g.add(bar([-26, s * 26, 8], [-22, s * 20, 37], 3, m.dark));
      g.add(bar([6, s * 20, 37], [-22, s * 20, 37], 3, m.dark));
      g.add(bar([-22, s * 20, 37], [-50, s * 20, 14], 3, m.dark));
    }
    g.add(bar([6, 20, 37], [6, -20, 37], 3.6, m.trim));              // light bar
    g.add(bar([-22, 20, 37], [-22, -20, 37], 3, m.dark));
    g.add(slab(62, 75, 3, 2, 5.2, 0.2, 6, 1, m.trim));               // nose stripe
  }
];

function buildCar(team, look) {
  const body = look && SHELLS[look[0]] ? look[0] : 0, trimHex = (look && TRIMS[look[1]] ? TRIMS[look[1]] : TRIMS[0])[1];
  const g = new THREE.Group();
  const m = {
    paint: new THREE.MeshStandardMaterial({ color: TEAM_HEX[team], emissive: TEAM_HEX[team], emissiveIntensity: 0.3, roughness: 0.42, metalness: 0.1, flatShading: true, side: THREE.DoubleSide }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1b1730, roughness: 0.7, flatShading: true, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ color: trimHex, emissive: trimHex, emissiveIntensity: 0.12, roughness: 0.5, flatShading: true, side: THREE.DoubleSide }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0c0a18, roughness: 0.12, metalness: 0.7, flatShading: true, side: THREE.DoubleSide })
  };
  // the shell sits in its own group so it can lean on its springs while the wheels stay planted
  const shell = new THREE.Group(); g.add(shell);
  SHELLS[body](shell, m);
  // crisp dark outline on the shell's hard edges
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x0d0a1a, transparent: true, opacity: 0.55 });
  shell.children.slice().forEach(o => {
    if (!o.isMesh) return;
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), edgeMat);
    e.position.copy(o.position); e.quaternion.copy(o.quaternion); e.scale.copy(o.scale); shell.add(e);
  });
  // lights: headlights always on, tail lights glow harder when braking or reversing
  const front = WHEEL_SPECS[body][0][0] + 22, rear = WHEEL_SPECS[body][2][0] - 14;
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.55 });
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(2.2 * K, 4 * K, 9 * K), headMat); hl.position.copy(P(front, s * 24, 5)); shell.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(2.2 * K, 4 * K, 10 * K), tailMat); tl.position.copy(P(rear - 2, s * 27, 9)); shell.add(tl);
  }
  // wheels: tyre, coloured rim and spokes
  const wheels = [];
  const tyre = new THREE.MeshStandardMaterial({ color: 0x14121f, roughness: 0.9, flatShading: true });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.35, metalness: 0.6, flatShading: true });
  for (const [x, y, r, wd] of WHEEL_SPECS[body]) {
    const piv = new THREE.Group();
    piv.position.copy(P(x, y, -S.REST_Z + r));
    const spin = new THREE.Group();
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r * K, r * K, wd * K, 16), tyre); w.rotation.x = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62 * K, r * 0.62 * K, (wd + 0.5) * K, 12), rimMat); rim.rotation.x = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.22 * K, r * 0.22 * K, (wd + 1.2) * K, 6), m.trim); hub.rotation.x = Math.PI / 2;
    spin.add(w, rim, hub);
    for (let k = 0; k < 5; k++) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(r * 1.1 * K, 2.2 * K, (wd + 0.9) * K), m.dark);
      sp.rotation.z = k * Math.PI / 5; spin.add(sp);
    }
    piv.add(spin); g.add(piv);
    wheels.push({ piv, spin, r });
  }
  // boost flame
  const flame = new THREE.Mesh(new THREE.ConeGeometry(9 * K, 70 * K, 8, 1, true), new THREE.MeshBasicMaterial({ color: BOOST, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  flame.rotation.z = Math.PI / 2; flame.position.copy(P(-84, 0, 4)); flame.visible = false;
  g.add(flame);
  g.userData = { wheels, flame, shell, tailMat, lean: 0, dip: 0 };
  return g;
}
function disposeCar(g) {
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
}

// ------------------------------------------------------------------ particles
class Particles {
  constructor(n) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.col = new Float32Array(n * 3); this.base = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.grav = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mesh = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.62, map: dotTexture(), vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    for (let k = 0; k < n; k++) this.pos[k * 3 + 1] = -100;
  }
  emit(x, y, z, vx, vy, vz, life, r, g, b, grav = 0) {
    const k = this.i; this.i = (k + 1) % this.n;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.base[k * 3] = r; this.base[k * 3 + 1] = g; this.base[k * 3 + 2] = b;
    this.life[k] = life; this.max[k] = life; this.grav[k] = grav;
  }
  update(dt) {
    const { pos, vel, col, base, life, max, grav } = this;
    for (let k = 0; k < this.n; k++) {
      if (life[k] <= 0) continue;
      life[k] -= dt;
      const j = k * 3;
      if (life[k] <= 0) { col[j] = col[j + 1] = col[j + 2] = 0; pos[j + 1] = -100; continue; }
      vel[j + 1] -= grav[k] * dt;
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      if (pos[j + 1] < 0.05 && grav[k] > 0) { pos[j + 1] = 0.05; vel[j + 1] *= -0.4; }
      const f = life[k] / max[k];
      col[j] = base[j] * f; col[j + 1] = base[j + 1] * f; col[j + 2] = base[j + 2] * f;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ renderer
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.quality = 'high';
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(72, 1, 0.3, 1200);
    this.cars = []; this.tmpV = new THREE.Vector3(); this.tmpQ = new THREE.Quaternion();
    this.dir = [0, 1, 0]; this.orbit = 0.6; this.kick = 0; this.look = [0, 0, 150]; this.flashT = 0;
    this.camPos = [0, -3000, 800]; this.shake = 0;
    this.srCar = null; this.srKey = ''; this.srSpin = 0; this.viewShift = 0;
    this.buildWorld();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setQuality(q) { this.quality = q; this.resize(); }
  resize() {
    const w = innerWidth, h = innerHeight;
    this.r.setPixelRatio(Math.min(devicePixelRatio || 1, this.quality === 'high' ? 2 : 1));
    this.r.setSize(w, h, false);
    this.cam.aspect = w / h; this.cam.clearViewOffset(); this.viewShift = 0; this.cam.updateProjectionMatrix();
    this.w = w; this.h = h;
  }

  buildWorld() {
    const sc = this.scene;
    // sky
    const sg = new THREE.SphereGeometry(900, 32, 20), sp = sg.attributes.position, cols = [];
    const top = new THREE.Color(0x231a52), mid = new THREE.Color(0xa53f82), hor = new THREE.Color(0xff9a6b), low = new THREE.Color(0x1c1638), c = new THREE.Color();
    for (let i = 0; i < sp.count; i++) {
      const hgt = sp.getY(i) / 900;
      if (hgt < 0) c.copy(hor).lerp(low, Math.min(1, -hgt * 9));
      else if (hgt < 0.2) c.copy(hor).lerp(mid, hgt / 0.2);
      else c.copy(mid).lerp(top, Math.min(1, (hgt - 0.2) / 0.45));
      cols.push(c.r, c.g, c.b);
    }
    sg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.sky = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.sky.renderOrder = -2; sc.add(this.sky);
    const dot = dotTexture();
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffb489, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.sun.scale.set(300, 300, 1); this.sun.renderOrder = -1; sc.add(this.sun);

    sc.add(new THREE.HemisphereLight(0xffe1cf, 0x2d4a66, 1.5));
    const sunL = new THREE.DirectionalLight(0xfff0de, 1.9); sunL.position.set(30, 60, -80); sc.add(sunL);

    // ground outside the arena and a ring of stands for depth
    const out = new THREE.Mesh(new THREE.CircleGeometry(900, 48), new THREE.MeshBasicMaterial({ color: 0x1c1638 }));
    out.rotation.x = -Math.PI / 2; out.position.y = -0.08; sc.add(out);
    const standMat = [new THREE.MeshBasicMaterial({ color: 0x2b2156 }), new THREE.MeshBasicMaterial({ color: 0x332863 })];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const lights = [];
    for (let i = 0; i < 34; i++) {
      const a = i / 34 * Math.PI * 2, rx = (S.HX + 5200) * K, ry = (S.HY + 5200) * K;
      const hgt = 14 + rnd() * 26, wdt = 34 + rnd() * 14;
      const b = new THREE.Mesh(new THREE.BoxGeometry(wdt, hgt, 14), standMat[i % 2]);
      b.position.set(Math.cos(a) * rx, hgt / 2, Math.sin(a) * ry); b.lookAt(0, hgt / 2, 0); sc.add(b);
      for (let k = 0; k < 12; k++) lights.push(b.position.x + (rnd() - 0.5) * wdt * 0.8 - Math.cos(a) * 7.5, 1.5 + rnd() * (hgt - 2), b.position.z + (rnd() - 0.5) * wdt * 0.8 - Math.sin(a) * 7.5);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
    sc.add(new THREE.Points(lg, new THREE.PointsMaterial({ size: 1.3, map: dot, color: 0xffc98f, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(1.6, 46, 1.6), standMat[0]);
      tower.position.copy(P(sx * (S.HX + 3600), sy * (S.HY + 3000), 2300)); sc.add(tower);
      const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffe6c8, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
      lamp.scale.set(22, 22, 1); lamp.position.copy(P(sx * (S.HX + 3600), sy * (S.HY + 3000), 4650)); sc.add(lamp);
    }

    // pitch
    const ft = floorTexture(); ft.anisotropy = this.r.capabilities.getMaxAnisotropy();
    const fg = new THREE.ShapeGeometry(flatShape(0), 6), fuv = fg.attributes.uv;
    for (let i = 0; i < fuv.count; i++) fuv.setXY(i, (fuv.getX(i) + S.HX) / (2 * S.HX), (fuv.getY(i) + S.HY) / (2 * S.HY));
    fg.rotateX(-Math.PI / 2); fg.scale(K, K, K);
    sc.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ map: ft })));
    const grid = gridTexture(0.95, 0.2);
    sc.add(buildWalls(grid));
    const cg = new THREE.ShapeGeometry(flatShape(S.RT), 6), cuv = cg.attributes.uv;
    for (let i = 0; i < cuv.count; i++) cuv.setXY(i, cuv.getX(i) / 512, cuv.getY(i) / 512);
    cg.rotateX(Math.PI / 2); cg.scale(K, K, K); cg.translate(0, S.HZ * K, 0);
    const ceil = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ map: grid, color: 0x8f76d6, transparent: true, opacity: 0.3, depthWrite: false })); ceil.renderOrder = 2; sc.add(ceil);

    // goals
    const { GW, GH, GD, HY } = S;
    for (const team of [0, 1]) {
      const s = team === 0 ? -1 : 1, y0 = s * HY, y1 = s * (HY + GD);
      const tcol = new THREE.Color(TEAM_HEX[team]);
      const floorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x0d544e).lerp(tcol, 0.45), side: THREE.DoubleSide });
      const net = gridTexture(0.9, 0.12);
      const netMat = new THREE.MeshBasicMaterial({ map: net, color: new THREE.Color(CHALK).lerp(tcol, 0.35), transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
      const add = (m, order) => { m.renderOrder = order; sc.add(m); };
      add(quad([-GW, y0, 0.6], [GW, y0, 0.6], [GW, y1, 0.6], [-GW, y1, 0.6], floorMat), 0);
      add(quad([-GW, y1, 0], [GW, y1, 0], [GW, y1, GH], [-GW, y1, GH], netMat, 14, 5), 3);
      add(quad([-GW, y0, 0], [-GW, y1, 0], [-GW, y1, GH], [-GW, y0, GH], netMat, 7, 5), 3);
      add(quad([GW, y0, 0], [GW, y1, 0], [GW, y1, GH], [GW, y0, GH], netMat, 7, 5), 3);
      add(quad([-GW, y0, GH], [GW, y0, GH], [GW, y1, GH], [-GW, y1, GH], netMat, 14, 7), 3);
      const frame = new THREE.MeshBasicMaterial({ color: TEAM_HEX[team] });
      for (const x of [-GW - 9, GW + 9]) { const post = new THREE.Mesh(new THREE.BoxGeometry(18 * K, GH * K, 18 * K), frame); post.position.copy(P(x, y0, GH / 2)); sc.add(post); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry((GW * 2 + 36) * K, 18 * K, 18 * K), frame); bar.position.copy(P(0, y0, GH + 9)); sc.add(bar);
    }

    // boost pads
    this.pads = [];
    const padMat = new THREE.MeshBasicMaterial({ color: BOOST, transparent: true });
    S.PADS.forEach(([x, y, big]) => {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry((big ? 95 : 48) * K, (big ? 110 : 56) * K, 0.05, 20), padMat.clone());
      disc.position.copy(P(x, y, 3)); sc.add(disc);
      let orb = null;
      if (big) { orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), new THREE.MeshBasicMaterial({ color: BOOST })); orb.position.copy(P(x, y, 90)); sc.add(orb); }
      this.pads.push({ disc, orb });
    });

    // ball
    const bt = ballTexture();
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(S.BALL_R * K, 32, 20), new THREE.MeshStandardMaterial({ map: bt, emissiveMap: bt, emissive: 0xffffff, emissiveIntensity: 0.32, roughness: 0.4 }));
    sc.add(this.ball);
    const shTex = shadowTexture();
    const shMat = () => new THREE.MeshBasicMaterial({ map: shTex, transparent: true, opacity: 0.5, depthWrite: false });
    this.ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(S.BALL_R * 2.5 * K, S.BALL_R * 2.5 * K), shMat()); this.ballShadow.rotation.x = -Math.PI / 2; this.ballShadow.renderOrder = 1; sc.add(this.ballShadow);
    this.ballRing = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.0, 36), new THREE.MeshBasicMaterial({ color: CHALK, transparent: true, opacity: 0.7, depthWrite: false })); this.ballRing.rotation.x = -Math.PI / 2; this.ballRing.renderOrder = 1; sc.add(this.ballRing);
    this.shadowMat = shMat;

    this.fx = new Particles(1400); sc.add(this.fx.mesh);
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: CHALK, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.flash.visible = false; this.flash.renderOrder = 6; sc.add(this.flash);
  }

  setPlayers(players) {
    for (const c of this.cars) { this.scene.remove(c.mesh); this.scene.remove(c.shadow); disposeCar(c.mesh); c.shadow.geometry.dispose(); c.shadow.material.dispose(); }
    this.cars = players.map(p => {
      const mesh = buildCar(p.team, p.look); this.scene.add(mesh);
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 1.25), this.shadowMat()); shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 1; this.scene.add(shadow);
      return { mesh, shadow, team: p.team, spin: 0 };
    });
  }

  // ---- garage: one car on the centre spot, everything else hidden. sr = { team, look, shift } or null
  showroom(sr) {
    const key = sr ? sr.team + ':' + sr.look[0] + ':' + sr.look[1] : '';
    if (key === this.srKey) return;
    this.srKey = key;
    if (this.srCar) { this.scene.remove(this.srCar); disposeCar(this.srCar); this.srCar = null; }
    if (!this.srShadow) {
      this.srShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 1.25), this.shadowMat()); this.srShadow.rotation.x = -Math.PI / 2;
      this.srShadow.position.set(0.14, 0.03, 0); this.srShadow.renderOrder = 1; this.scene.add(this.srShadow);
    }
    this.srShadow.visible = !!sr;
    if (sr) { this.srCar = buildCar(sr.team, sr.look); this.srCar.position.copy(P(0, 0, S.REST_Z)); this.scene.add(this.srCar); }
  }
  // which way to look for something that is off screen: unit vector in screen space (y down)
  pointer(x, y, z, out) {
    const v = this.tmpV.set(x * K, z * K, -y * K).applyMatrix4(this.cam.matrixWorldInverse), l = Math.hypot(v.x, v.y) || 1;
    out.dx = v.x / l; out.dy = -v.y / l;
    return out;
  }

  // ---- one-off effects (positions in sim space)
  burst(x, y, z, hex, n, speed, life, grav = 0) {
    const c = new THREE.Color(hex), p = P(x, y, z);
    if (this.quality !== 'high') n = Math.ceil(n * 0.5);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), v = speed * (0.25 + Math.random() * 0.75);
      this.fx.emit(p.x, p.y, p.z, s * Math.cos(a) * v, Math.abs(u) * v * 0.9 + 1, s * Math.sin(a) * v, life * (0.5 + Math.random() * 0.5), c.r, c.g, c.b, grav);
    }
  }
  goalBlast(x, y, z, team) {
    this.burst(x, y, z, TEAM_HEX[team], 420, 42, 1.9, 9);
    this.burst(x, y, z, CHALK, 120, 24, 1.2, 9);
    this.flash.position.copy(P(x, y, z)); this.flash.material.color.setHex(TEAM_HEX[team]); this.flashT = 0.7; this.flash.visible = true;
    this.shake = 0.5;
  }
  demoBlast(x, y, z) { this.burst(x, y, z, 0xffa040, 150, 22, 1.0, 12); this.burst(x, y, z, CHALK, 40, 12, 0.6, 12); }
  hitSpark(x, y, z, strength) { this.burst(x, y, z, CHALK, Math.round(6 + strength * 22), 5 + strength * 14, 0.35, 0); }

  project(x, y, z, out) {
    const v = this.tmpV.set(x * K, z * K, -y * K).project(this.cam);
    out.x = (v.x * 0.5 + 0.5) * this.w; out.y = (-v.y * 0.5 + 0.5) * this.h; out.ok = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    return out;
  }

  // ---- per frame
  frame(session, dt, opts) {
    const w = session.world, ents = session.ents, fx = this.fx, hi = this.quality === 'high';
    const sr = opts.showroom || null;
    this.showroom(sr);
    for (let i = 0; i < this.cars.length && i < w.cars.length; i++) {
      const c = w.cars[i], o = ents[i].out, v = this.cars[i], m = v.mesh;
      const alive = c.demoT <= 0 && !sr;
      m.visible = alive; v.shadow.visible = alive;
      if (!alive) continue;
      m.position.set(o[0] * K, o[2] * K, -o[1] * K);
      m.quaternion.set(o[3], o[5], -o[4], o[6]);
      const ud = m.userData, fwd = c.vx * c.fx + c.vy * c.fy + c.vz * c.fz;
      v.spin -= fwd * dt / 14;
      for (let k = 0; k < 4; k++) { ud.wheels[k].spin.rotation.z = v.spin; if (k < 2) ud.wheels[k].piv.rotation.y = -c.steerA; }
      // body roll into turns and nose dip when braking, on the ground only
      const grounded = c.onGround, sp = Math.min(1, Math.abs(fwd) / 1400);
      const leanT = grounded ? -c.steerA * sp * 0.9 * Math.sign(fwd || 1) : 0;
      const braking = grounded && ((fwd > 150 && c['in'].throttle < -0.1) || (fwd < -150 && c['in'].throttle > 0.1));
      const dipT = braking ? 0.05 : (grounded && c.boosting ? -0.03 : 0);
      const lk = 1 - Math.exp(-dt * 9);
      ud.lean += (leanT * 0.12 - ud.lean) * lk; ud.dip += (dipT - ud.dip) * lk;
      ud.shell.rotation.set(ud.lean, 0, -ud.dip);
      ud.tailMat.opacity = braking || fwd < -150 ? 1 : 0.55;
      ud.flame.visible = c.boosting;
      if (c.boosting) ud.flame.scale.set(0.8 + Math.random() * 0.5, 0.8 + Math.random() * 0.6, 0.8 + Math.random() * 0.5);
      // shadow
      const hgt = Math.max(0, o[2] - S.REST_Z);
      v.shadow.position.set((o[0] + c.fx * 14) * K, 0.03, -(o[1] + c.fy * 14) * K);
      v.shadow.rotation.z = Math.atan2(c.fy, c.fx);
      v.shadow.material.opacity = 0.62 * Math.max(0, 1 - hgt / 1400);
      const sh = 1 + hgt / 900; v.shadow.scale.set(sh, sh, 1);
      // exhaust
      if (c.boosting || c.superSonic) {
        const rx = o[0] - c.fx * 62 + c.ux * 4, ry = o[1] - c.fy * 62 + c.uy * 4, rz = o[2] - c.fz * 62 + c.uz * 4;
        const n = c.boosting ? (hi ? 3 : 1) : 0;
        for (let k = 0; k < n; k++) {
          const j = 160, vx = (c.vx * 0.35 - c.fx * 620 + (Math.random() - 0.5) * j) * K, vy = (c.vy * 0.35 - c.fy * 620 + (Math.random() - 0.5) * j) * K, vz = (c.vz * 0.35 - c.fz * 620 + (Math.random() - 0.5) * j) * K;
          fx.emit(rx * K, rz * K, -ry * K, vx, vz, -vy, 0.22 + Math.random() * 0.2, 1.0, 0.62 + Math.random() * 0.2, 0.12);
        }
        if (c.superSonic && c.onGround !== false) {
          const tc = v.team === 0 ? [0.1, 0.75, 0.95] : [1.0, 0.35, 0.2];
          for (const sgn of [-1, 1]) fx.emit((rx + c.lx * 34 * sgn) * K, (rz + c.lz * 34 * sgn - 8) * K, -(ry + c.ly * 34 * sgn) * K, 0, 0.2, 0, 0.5, tc[0], tc[1], tc[2]);
        }
      }
    }
    // ball
    const b = session.ballEnt.out, bw = w.ball;
    const ballOn = w.ballOn && !sr;
    this.ball.visible = ballOn;
    this.ballShadow.visible = this.ballRing.visible = ballOn;
    if (ballOn) {
      this.ball.position.set(b[0] * K, b[2] * K, -b[1] * K);
      const ax = bw.wx, ay = bw.wz, az = -bw.wy, ang = Math.hypot(ax, ay, az) * dt;
      if (ang > 1e-6) { this.tmpV.set(ax, ay, az).normalize(); this.tmpQ.setFromAxisAngle(this.tmpV, ang); this.ball.quaternion.premultiply(this.tmpQ); }
      const hgt = Math.max(0, b[2] - S.BALL_R);
      this.ballShadow.position.set(b[0] * K, 0.035, -b[1] * K);
      this.ballShadow.material.opacity = 0.66 * Math.max(0.2, 1 - hgt / 1600);
      const s = 1 + hgt / 1100; this.ballShadow.scale.set(s, s, 1);
      this.ballRing.position.set(b[0] * K, 0.04, -b[1] * K);
      this.ballRing.material.opacity = Math.min(0.75, hgt / 500);
    }
    // pads
    const t = performance.now() / 1000;
    for (let k = 0; k < this.pads.length; k++) {
      const on = w.pads[k] === 0, p = this.pads[k];
      p.disc.material.opacity = on ? 0.95 : 0.16;
      if (p.orb) { p.orb.visible = on; p.orb.rotation.y = t * 1.6; p.orb.position.y = 0.9 + Math.sin(t * 2.4 + k) * 0.12; }
    }
    if (this.flashT > 0) {
      this.flashT -= dt; const f = Math.max(0, this.flashT / 0.7), s = 4 + (1 - f) * 46;
      this.flash.scale.set(s, s, s); this.flash.material.opacity = f * 0.55; if (this.flashT <= 0) this.flash.visible = false;
    }
    fx.update(dt);
    this.camera(session, dt, opts);
    this.sky.position.copy(this.cam.position);
    this.sun.position.set(this.cam.position.x + 250, this.cam.position.y + 62, this.cam.position.z - 820);
    this.r.render(this.scene, this.cam);
  }

  camera(session, dt, opts) {
    const w = session.world, me = session.me, cs = opts.cam, cam = this.cam;
    const b = session.ballEnt.out;
    let px, py, pz, dx, dy, dz, sup = 0, carAt = null;
    const sr = opts.showroom, shift = sr ? Math.round(sr.shift || 0) : 0;
    if (shift !== this.viewShift) {       // slide the picture sideways so the garage car sits clear of the menu
      this.viewShift = shift;
      if (shift) cam.setViewOffset(this.w, this.h, -shift, 0, this.w, this.h); else cam.clearViewOffset();
    }
    if (sr) {
      this.srSpin += dt * 0.5;
      px = Math.cos(this.srSpin) * 400; py = Math.sin(this.srSpin) * 400; pz = 150;
      dx = -px; dy = -py; dz = 22 - pz;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      this.dir[0] = dx; this.dir[1] = dy; this.dir[2] = dz;
    } else if (me < 0 || !w.cars[me]) {
      // spectator orbit for the menu backdrop
      this.orbit += dt * 0.055;
      const k = 1 - Math.exp(-dt * 1.4);
      this.look[0] += (b[0] * 0.5 - this.look[0]) * k; this.look[1] += (b[1] * 0.5 - this.look[1]) * k; this.look[2] += (150 + b[2] * 0.3 - this.look[2]) * k;
      px = Math.cos(this.orbit) * 5200 + 1300; py = Math.sin(this.orbit) * 6300; pz = 1150;
      dx = this.look[0] - px; dy = this.look[1] - py; dz = this.look[2] - pz;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      this.dir[0] = dx; this.dir[1] = dy; this.dir[2] = dz;
    } else {
      const c = w.cars[me], o = session.ents[me].out;
      if (c.demoT > 0) return;       // hold the last view while demolished
      const ang = cs.angle * Math.PI / 180;
      let yaw, pitch, rate = 5 + cs.stiff * 0.16;
      const fx = c.fx, fy = c.fy, fz = c.fz;
      const curYaw = Math.atan2(this.dir[1], this.dir[0]);
      if (opts.ballCam && w.ballOn) {
        const ex = b[0] - o[0], ey = b[1] - o[1], ez = b[2] - (o[2] + cs.height), hd = Math.hypot(ex, ey);
        yaw = hd > 140 ? Math.atan2(ey, ex) : curYaw;
        pitch = Math.max(-0.3, Math.min(1.3, Math.atan2(ez, Math.max(hd, 200)) * 0.82)) + ang * 0.7;
        rate *= 1.5;
      } else {
        const hv = Math.hypot(c.vx, c.vy);
        if (c.onGround && hv > 250 && c.gnz > 0.8) yaw = Math.atan2(fy * 0.6 + c.vy / hv * 0.4, fx * 0.6 + c.vx / hv * 0.4);
        else yaw = Math.abs(fz) < 0.96 ? Math.atan2(fy, fx) : curYaw;
        pitch = Math.asin(Math.max(-1, Math.min(1, fz))) * 0.55 + ang;
      }
      const cp = Math.cos(pitch), tx = cp * Math.cos(yaw), ty = cp * Math.sin(yaw), tz = Math.sin(pitch);
      const k = 1 - Math.exp(-dt * rate), d = this.dir;
      d[0] += (tx - d[0]) * k; d[1] += (ty - d[1]) * k; d[2] += (tz - d[2]) * k;
      const l = Math.hypot(d[0], d[1], d[2]) || 1; d[0] /= l; d[1] /= l; d[2] /= l;
      dx = d[0]; dy = d[1]; dz = d[2];
      // In ball cam the view tilts up and down to follow the ball, but the camera itself stays behind and a little
      // above the car (tilting the camera's position with the view would drop it under the car when the ball is high).
      let qx = dx, qy = dy, qz = dz;
      if (opts.ballCam && w.ballOn) {
        const pp = Math.max(-0.25, Math.min(0.22, Math.asin(Math.max(-1, Math.min(1, dz))))), hl = Math.hypot(dx, dy) || 1;
        qx = dx / hl * Math.cos(pp); qy = dy / hl * Math.cos(pp); qz = Math.sin(pp);
      }
      px = o[0] - qx * cs.dist; py = o[1] - qy * cs.dist; pz = o[2] + cs.height - qz * cs.dist;
      if (pz < 24) pz = 24;
      // keep the camera inside the arena shell
      for (let it = 0; it < 2; it++) { const sd = S.sdf(px, py, pz); if (sd < 45) { const nn = S.normal(); px += nn[0] * (45 - sd); py += nn[1] * (45 - sd); pz += nn[2] * (45 - sd); } }
      sup = c.superSonic ? 1 : 0;
      carAt = o;
    }
    this.kick += (sup - this.kick) * Math.min(1, dt * 3);
    if (this.shake > 0) { this.shake -= dt; const a = this.shake * 14; px += (Math.random() - 0.5) * a; py += (Math.random() - 0.5) * a; pz += (Math.random() - 0.5) * a; }
    const hf = (sr ? 58 : (me < 0 ? 62 : cs.fov)) * Math.PI / 180;
    const vf = 2 * Math.atan(Math.tan(hf / 2) / Math.max(cam.aspect, 1.25)) * 180 / Math.PI + this.kick * 4;
    if (Math.abs(cam.fov - vf) > 0.01) { cam.fov = vf; cam.updateProjectionMatrix(); }
    // Your own car must always be on screen: if the view points too far away from it (a high ball in ball cam, the
    // camera squeezed against a wall), turn the view back towards the car just enough to keep it inside the frame.
    if (carAt) {
      let vx = carAt[0] - px, vy = carAt[1] - py, vz = carAt[2] - pz;
      const vl = Math.hypot(vx, vy, vz);
      if (vl > 1) {
        vx /= vl; vy /= vl; vz /= vl;
        const vHalf = vf * Math.PI / 360, hHalf = Math.atan(Math.tan(vHalf) * cam.aspect);
        const lim = Math.max(0.12, Math.min(vHalf, hHalf) * 0.8 - Math.atan(75 / vl));   // leave room for the car's size
        const cosA = dx * vx + dy * vy + dz * vz;
        if (cosA < Math.cos(lim)) {
          let ox = dx - vx * cosA, oy = dy - vy * cosA, oz = dz - vz * cosA;
          const ol = Math.hypot(ox, oy, oz) || 1; ox /= ol; oy /= ol; oz /= ol;
          const cl = Math.cos(lim), sl = Math.sin(lim);
          dx = vx * cl + ox * sl; dy = vy * cl + oy * sl; dz = vz * cl + oz * sl;
        }
      }
    }
    cam.position.set(px * K, pz * K, -py * K);
    this.tmpV.set((px + dx * 100) * K, (pz + dz * 100) * K, -(py + dy * 100) * K);
    cam.up.set(0, 1, 0); cam.lookAt(this.tmpV);
  }
}
