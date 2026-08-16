'use strict';
/* 无头逻辑测试：mock THREE + DOM，执行真实 buildUSP/buildAR 与 update(t)，
   验证循环无跳变、爆炸位坐标、数值有限性。 */
const fs = require('fs');
const vm = require('vm');

/* ---------- THREE 桩 ---------- */
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Obj3D {
  constructor() {
    this.position = new V3();
    this.rotation = { x: 0, y: 0, z: 0, set: (x, y, z) => { this.x = x; this.y = y; this.z = z; } };
    this.scale = { x: 1, y: 1, z: 1, set: (x, y, z) => { this.x = x; this.y = y; this.z = z; } };
    this.children = [];
  }
  add(c) { this.children.push(c); }
  localToWorld(v) { return v; }
}
class Mesh extends Obj3D { constructor() { super(); } }
class Group extends Obj3D {}
class Sprite extends Obj3D {
  constructor() { super(); this.scale = { x: 1, y: 1, z: 1, set: (x, y, z) => { this.x = x; this.y = y; this.z = z; } }; }
}

const ctx = {
  fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, textBaseline: '',
  fillRect() {}, clearRect() {}, strokeText() {}, fillText() {},
  createRadialGradient() { return { addColorStop() {} }; }
};
function mkEl() {
  return {
    style: {}, hidden: false, textContent: '', innerHTML: '', value: 0, width: 0, height: 0, src: '',
    appendChild() {}, addEventListener() {}, setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {} },
    getContext: () => ctx, children: []
  };
}
const THREE = {
  Math: { PI: Math.PI },
  Vector3: V3, Group, Mesh, Sprite,
  BoxGeometry: class {}, CylinderGeometry: class {}, PlaneGeometry: class {},
  MeshStandardMaterial: class { constructor(o) { Object.assign(this, o); } },
  MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); } },
  SpriteMaterial: class { constructor(o) { Object.assign(this, o); } },
  CanvasTexture: class { constructor(c) { this.image = c; } },
  Clock: class { getDelta() { return 0.016; } },
  AdditiveBlending: 2, NearestFilter: 1003, SRGBColorSpace: 'srgb'
};
const document = { getElementById: () => mkEl(), createElement: () => mkEl(), createElementNS: () => mkEl(), head: mkEl() };

/* ---------- 提取主脚本，导出构建函数 ---------- */
let html = fs.readFileSync('usp-match-lowpoly.html', 'utf-8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let js = scripts[scripts.length - 1];
const tail = "  syncPlayBtns();\n  loadCDN(0);\n})();";
if (!js.includes(tail)) throw new Error('tail marker not found');
js = js.replace(tail, "  globalThis.__X = { buildUSP, buildAR, pulse, smooth, snapVec, TRIS_get: () => TRIS };\n})();");

const sandbox = { THREE, document, console, performance: { now: () => 0 } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'usp-match-lowpoly.html' });
const X = sandbox.__X;

/* ---------- 断言工具 ---------- */
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.log('FAIL:', msg); }
}
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

/* ---------- USP 测试 ---------- */
const usp = X.buildUSP();
assert(usp.tris > 500, 'USP tris positive, got ' + usp.tris);
assert(usp.labels.length === 8, 'USP 8 labels, got ' + usp.labels.length);

const pos = t => {
  const f = usp.update(t);
  return {
    slide: [usp.parts.slide.position.x, usp.parts.slide.position.y, usp.parts.slide.position.z],
    barrel: [usp.parts.barrel.position.x, usp.parts.barrel.position.y, usp.parts.barrel.position.z],
    weight: [usp.parts.weight.position.x, usp.parts.weight.position.y, usp.parts.weight.position.z],
    spring: [usp.parts.spring.position.x, usp.parts.spring.position.y, usp.parts.spring.position.z],
    mag: [usp.parts.mag.position.x, usp.parts.mag.position.y, usp.parts.mag.position.z], f
  };
};

const G = 0.012, S = v => Math.round(v / G) * G;
let p0 = pos(0);
assert(JSON.stringify(p0.slide) === JSON.stringify([0, 0, 0]), 'USP t=0 slide at origin: ' + p0.slide);
assert(JSON.stringify(p0.barrel) === JSON.stringify([0, 0, 0]), 'USP t=0 barrel at origin');
assert(JSON.stringify(p0.mag) === JSON.stringify([S(-0.34), S(-0.95), 0]), 'USP t=0 mag inserted: ' + p0.mag);

let pe = pos(6.2); // 分解视图
assert(JSON.stringify(pe.slide) === JSON.stringify([-0.3, 0, 0]), 'USP exploded slide locked back: ' + pe.slide);
assert(JSON.stringify(pe.barrel) === JSON.stringify([S(1.3), 0, 0]), 'USP exploded barrel fwd: ' + pe.barrel);
assert(JSON.stringify(pe.weight) === JSON.stringify([S(1.85), 0, 0]), 'USP exploded weight fwd: ' + pe.weight);
assert(JSON.stringify(pe.spring) === JSON.stringify([S(1.05), S(-0.16), 0]), 'USP exploded spring: ' + pe.spring);
assert(JSON.stringify(pe.mag) === JSON.stringify([S(-0.34), -2.1, 0]), 'USP exploded mag down: ' + pe.mag);

/* 循环无跳变：t≈total 与 t=0 的部件位置必须一致 */
let pend = pos(usp.total - 1e-6);
let seam = true;
['slide', 'barrel', 'weight', 'spring', 'mag'].forEach(k => {
  if (JSON.stringify(p0[k]) !== JSON.stringify(pend[k])) { seam = false; console.log('  seam diff', k, p0[k], pend[k]); }
});
assert(seam, 'USP loop seam continuous');
assert(pe.f.fWeight === 1 && pe.f.fMag === 1 && pe.f.fSlide === 1, 'USP exploded factors all 1');

/* 中段采样：全部有限 */
for (let i = 0; i <= 100; i++) {
  const p = pos(i / 100 * usp.total);
  for (const k of ['slide', 'barrel', 'weight', 'spring', 'mag'])
    for (const v of p[k]) assert(finite(v), 'USP finite ' + k + ' @' + i);
  assert(finite(p.f.fSlide) && finite(p.f.fBarrel) && finite(p.f.fMag), 'USP factors finite @' + i);
}
/* 分解视图 readout/dim/labels 数据合法 */
const fr = pe.f;
assert(/mm/.test(usp.readout(6.2, fr)), 'USP readout has mm');
assert(/mm/.test(usp.dim(6.2, fr).text), 'USP dim has mm');
usp.labels.forEach(L => {
  if (L.obj) assert(usp.parts[L.obj] instanceof Group || usp.parts[L.obj] instanceof Mesh, 'USP label obj exists: ' + L.obj);
  else assert(L.world instanceof V3, 'USP label world V3');
});

/* ---------- AR 测试 ---------- */
const ar = X.buildAR();
assert(ar.tris > 1000, 'AR tris positive, got ' + ar.tris);
assert(ar.labels.length === 13, 'AR 13 labels, got ' + ar.labels.length);

const apos = t => {
  const f = ar.update(t);
  return {
    pivot: ar.parts.pivot.rotation.z, bcgX: ar.parts.bcg.position.x,
    pinZ: ar.parts.pinRear.position.z, magY: ar.parts.mag.position.y,
    boltA: ar.parts.bolt.rotation.x, f
  };
};
let a0 = apos(0);
assert(a0.pivot === 0 && Math.abs(a0.bcgX - S(-1.01)) < 1e-9 && a0.pinZ === 0, 'AR t=0 assembled: ' + JSON.stringify(a0));
let ae = apos(10.9); // 分解视图
assert(Math.abs(ae.pivot - (-0.42)) < 1e-9, 'AR open angle -0.42: ' + ae.pivot);
assert(Math.abs(ae.bcgX - S(-1.56)) < 0.013, 'AR BCG pulled out: ' + ae.bcgX);
assert(ae.pinZ === 0.42, 'AR rear pin out: ' + ae.pinZ);
assert(Math.abs(ae.magY - (-1.96)) < 0.013, 'AR mag dropped: ' + ae.magY);
assert(Math.abs(ae.boltA - 0.38) < 1e-9, 'AR bolt unlocked 0.38 rad: ' + ae.boltA);

let aEnd = apos(ar.total - 1e-6);
assert(Math.abs(aEnd.pivot) < 1e-7, 'AR pivot seam: ' + aEnd.pivot);
assert(Math.abs(aEnd.bcgX - a0.bcgX) < 0.013, 'AR bcg seam');
assert(Math.abs(aEnd.pinZ - a0.pinZ) < 0.013, 'AR pin seam');
assert(Math.abs(aEnd.magY - a0.magY) < 0.013, 'AR mag seam');
assert(Math.abs(aEnd.boltA) < 1e-9, 'AR bolt seam: ' + aEnd.boltA);

/* 拉机柄循环：峰值 1.9s 处 BCG 后移 0.18 */
let ar_rack = apos(1.9);
assert(Math.abs(ar_rack.bcgX - S(-1.01 - 0.18)) < 0.013, 'AR rack peak bcg: ' + ar_rack.bcgX);
assert(ar_rack.boltA > 0.3, 'AR bolt unlocked during rack: ' + ar_rack.boltA);

for (let i = 0; i <= 160; i++) {
  const p = apos(i / 160 * ar.total);
  assert(finite(p.pivot) && finite(p.bcgX) && finite(p.pinZ) && finite(p.magY) && finite(p.boltA), 'AR finite @' + i);
  assert(p.pivot >= -0.421 && p.pivot <= 0.001, 'AR pivot range @' + i + ': ' + p.pivot);
  assert(p.bcgX >= -1.561 && p.bcgX <= -1.007, 'AR bcg range @' + i + ': ' + p.bcgX);
  assert(p.pinZ >= -0.001 && p.pinZ <= 0.421, 'AR pin range @' + i);
  assert(p.magY >= -1.971 && p.magY <= -1.047, 'AR mag range @' + i + ': ' + p.magY);
  assert(p.boltA >= -1e-9 && p.boltA <= 0.381, 'AR bolt range @' + i);
}
assert(/°/.test(ar.readout(10.9, ae.f)), 'AR readout has degrees');
assert(/mm/.test(ar.dim(10.9, ae.f).text), 'AR dim has mm');
ar.labels.forEach(L => {
  if (L.obj) assert(ar.parts[L.obj], 'AR label obj exists: ' + L.obj);
  else assert(L.world instanceof V3, 'AR label world V3');
});

/* 脉冲函数数学性质 */
for (let i = 0; i <= 1000; i++) {
  const t = i / 1000 * 10;
  const v = X.pulse(t, 1.2, 2.3, 8.9, 9.8);
  assert(finite(v) && v >= -1e-9 && v <= 1 + 1e-9, 'pulse range @' + t);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
