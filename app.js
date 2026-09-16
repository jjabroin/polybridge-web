'use strict';
/* =====================================================================
 * Poly Bridge WEB — 커스텀 다리 빌더 + 강체(Rigid Body) 시뮬레이션
 * - 원본 스프링-질점 브릿지 물리(BaddishCarrot/polybridge4DFRAME20611)를
 *   계승하고, 건설 에디터 + 강체 차량/화물 + 레벨/예산/성공판정으로 확장.
 * - 의존성 없음. GitHub Pages 정적 호스팅 가능 (index.html + style.css + app.js)
 * ===================================================================== */

// ---------- 기본 상수 ----------
const W = 1280, H = 720;
const GRAV = 1500;            // px/s^2
const FIXED_DT = 1 / 60;
const ITER = 18;              //constraint 반복 (트램펄린 억제)
const GRID = 20;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let DPR = 1, view = { s: 1, ox: 0, oy: 0 };

// ---------- 자재 ----------
// 원리 (Poly Bridge 공식 스펙에서 도출한 상대 비율 — wood=1 기준):
//  비용: road 1.1 / wood 1 / steel 2.5 / cable 2 | 강도: road 1.125 / wood 1 / steel 2.5 / cable 2.75(인장전용)
//  무게: steel > road > wood > cable | 길이: road=wood(짧음) < steel(김) < cable(무제한급)
//  충돌: 차량은 ROAD하고만 충돌 (원작 원칙). cable은 어떤 강체와도 충돌하지 않는 순수 인장재.
//  구조 매핑: 거더교=road+하부보강 / 트러스교(Warren·Pratt)=wood·steel 삼각형 /
//            아치교=steel 압축아치 / 현수교=cable+타워 / 사장교=타워+방사형cable
const MATERIALS = {
  road:  { name: '도로', en: 'ROAD',   cost: 3.3, breakT: 0.20, breakC: -0.13, stiff: 1.0,  wpp: 0.030, maxLen: 120, minLen: 15, thick: 11, color: '#3a3f4a', key: '1', collideCar: true },
  wood:  { name: '목재', en: 'WOOD',   cost: 3.0, breakT: 0.20, breakC: -0.13, stiff: 0.7,  wpp: 0.016, maxLen: 120, minLen: 15, thick: 7,  color: '#b07a45', key: '2', collideCar: false },
  steel: { name: '철강', en: 'STEEL',  cost: 7.5, breakT: 0.40, breakC: -0.26, stiff: 1.0,  wpp: 0.045, maxLen: 190, minLen: 15, thick: 8,  color: '#5aa9ff', key: '3', collideCar: false },
  cable: { name: '케이블', en: 'CABLE', cost: 6.0, breakT: 0.44, breakC: -1e9, stiff: 0.55, wpp: 0.006, maxLen: 300, minLen: 15, thick: 3,  color: '#dfe6f2', key: '4', collideCar: false, noCollide: true },
};
const MAT_ORDER = ['road', 'wood', 'steel', 'cable'];

// ---------- 차량 ----------
// 설계 원천: Matter.js 공식 car 예제(MIT)의 검증된 치수 원리를 우리 서스펜션 방식에 이식.
//  - 휠베이스: 섀시 끝에서 안쪽으로 18px (w/2-18) — 바깥 배치로 전복 안정성 확보
//  - 바퀴: 고마찰 타이어, 섀시-바퀴 충돌 그룹 분리(서스펜션으로만 연결)
//  - 액슬: Matter는 강체(stiffness 1)지만 우리 지형(다리 이음매) 대응을 위해 짧고 단단한 서스펜션으로 대체
const CARS = {
  light: { name: '🚗 경차', w: 76, h: 20, wheelR: 15, mass: 10, motor: 800, top: 185, color: '#ff5252' },
  suv:   { name: '🚙 SUV',  w: 90, h: 24, wheelR: 17, mass: 15, motor: 1000, top: 170, color: '#26a69a' },
  truck: { name: '🚚 트럭', w: 112, h: 27, wheelR: 18, mass: 24, motor: 1250, top: 150, color: '#ffa000' },
};
const CAR_ORDER = ['light', 'suv', 'truck'];

// ---------- 레벨 ----------
// anchors: 고정점. island: {x,w,top} 중간 지지섬(선택)
const LEVELS = [
  { name: '1 · 새내기 개울', roadY: 400, left: 340, right: 740, waterY: 580, budget: 14000,
    desc: '처음 만드는 다리! 삼각 트러스로 가볍게 건너보세요.',
    anchors: [[340,400],[740,400],[340,492],[740,492],[270,492],[810,492],[340,308],[740,308]],
    car: 'light' },
  { name: '2 · 넓은 강', roadY: 380, left: 280, right: 880, waterY: 590, budget: 23000,
    desc: '경간 600px! 목재만으론 버겁습니다. 철강을 섞어보세요.',
    anchors: [[280,380],[880,380],[280,472],[880,472],[190,472],[970,472],[280,288],[880,288]],
    car: 'suv' },
  { name: '3 · 깊은 협곡', roadY: 330, left: 360, right: 840, waterY: 645, budget: 24000,
    desc: '아래로 길게! 현수(케이블) 구조가 유리합니다.',
    anchors: [[360,330],[840,330],[360,430],[840,430],[360,530],[840,530],[270,430],[930,430]],
    car: 'suv' },
  { name: '4 · 중간 섬', roadY: 390, left: 260, right: 940, waterY: 600, budget: 19000,
    desc: '가운데 섬을 밟고 가세요. 섬 앵커를 적극 활용!',
    anchors: [[260,390],[940,390],[260,482],[940,482],[530,486],[670,486],[260,298],[940,298]],
    island: { x: 530, w: 140, top: 486 }, car: 'light' },
  { name: '5 · 높은 고가', roadY: 300, left: 240, right: 960, waterY: 620, budget: 38000,
    desc: '경간 720px 최종 관문. 케이블 스테이 + 철강 트러스의 조합!',
    anchors: [[240,300],[960,300],[240,392],[960,392],[150,392],[1050,392],[240,190],[960,190],[150,190],[1050,190]],
    car: 'truck' },
];

// ---------- 상태 ----------
let levelIndex = 0;
let mode = 'build';           // 'build' | 'sim'
let nodes = [];               // {id,x,y,px,py,fx,fy,mass,fixed,anchor}
let beams = [];               // {id,a,b,mat,rest,broken,strain}
let nodeSeq = 1, beamSeq = 1;
let tool = 'build', curMat = 'road';
let car = null, carType = 'light', carMassMul = 1;
let bodies = [];              // 강체 화물: {kind:'ball'|'crate',x,y,vx,vy,a,va,r,w,h,m}
let particles = [];
let buildSnap = null;
let simTime = 0, dispatched = false, result = null;
let maxStrainSeen = 0, brokenCount = 0;
let shake = 0, timeSec = 0, cloudT = 0;
let breakFlash = 0;
let loadMass = 40;
let showGrid = true, showStress = true;
let undoStack = [], redoStack = [];
let mouse = { sx: 0, sy: 0, wx: 0, wy: 0, down: false, rdown: false, startNode: null, cur: null, hoverBeam: null, dragNode: null, moved: false };
let loseTimer = 0, stuckTimer = 0, flipTimer = 0, goalTimer = 0;
let simOverBudget = false;
let flagWave = 0;

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const fmt$ = n => '$' + Math.round(n).toLocaleString('en-US');

// ---------- 오디오 (초경량 신스) ----------
let AC = null;
function audio() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } return AC; }
function beep(freq, dur, type, vol, when) {
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime + (when || 0);
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(vol || 0.12, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
}
function sndBreak() {
  const ac = audio(); if (!ac) return;
  const len = ac.sampleRate * 0.18, buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const s = ac.createBufferSource(); s.buffer = buf;
  const g = ac.createGain(); g.gain.value = 0.25; s.connect(g); g.connect(ac.destination); s.start();
}
function sndWin() { [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.22, 'triangle', 0.14, i * 0.11)); }
function sndFail() { [330, 262, 196].forEach((f, i) => beep(f, 0.25, 'sawtooth', 0.07, i * 0.13)); }
function sndClick() { beep(700, 0.06, 'square', 0.05); }
window.addEventListener('pointerdown', () => audio(), { once: true });

// ---------- 레벨/월드 ----------
function LV() { return LEVELS[levelIndex]; }
function terrainSegs() {
  const L = LV(), segs = [];
  segs.push({ x1: -50, y1: L.roadY, x2: L.left, y2: L.roadY, ground: true });
  segs.push({ x1: L.left, y1: L.roadY, x2: L.left, y2: H + 50 });
  segs.push({ x1: L.right, y1: H + 50, x2: L.right, y2: L.roadY });
  segs.push({ x1: L.right, y1: L.roadY, x2: W + 50, y2: L.roadY, ground: true });
  if (L.island) {
    const ix = L.island.x, iw = L.island.w, it = L.island.top;
    segs.push({ x1: ix, y1: it, x2: ix + iw, y2: it, ground: true });
    segs.push({ x1: ix, y1: it, x2: ix, y2: H + 50 });
    segs.push({ x1: ix + iw, y1: H + 50, x2: ix + iw, y2: it });
  }
  return segs;
}
function inGap(x) { const L = LV(); return x > L.left + 2 && x < L.right - 2 && !(L.island && x > L.island.x && x < L.island.x + L.island.w); }
function goalX() { return LV().right + 60; }

// ---------- 노드/빔 ----------
function addNode(x, y, fixed, anchor) {
  const n = { id: nodeSeq++, x, y, px: x, py: y, fx: 0, fy: 0, mass: 1.2, fixed: !!fixed, anchor: !!anchor, y0: y };
  nodes.push(n); return n;
}
function nodeMass(n) {
  let m = 1.2;
  for (const b of beams) {
    if (b.broken) continue;
    if (b.a === n || b.b === n) m += b.rest * MATERIALS[b.mat].wpp / 2;
  }
  return Math.max(0.6, m);
}
function refreshMasses() { for (const n of nodes) n.mass = nodeMass(n); }
function beamLen(b) { return Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y); }
function beamCost(b) { return beamLen(b) * MATERIALS[b.mat].cost; }
function totalCost() { let s = 0; for (const b of beams) s += beamCost(b); return s; }
function findNodeAt(wx, wy, tol) {
  let best = null, bd = tol;
  for (const n of nodes) { const d = Math.hypot(n.x - wx, n.y - wy); if (d <= bd) { bd = d; best = n; } }
  return best;
}
function snapPoint(wx, wy) {
  // 기존 노드 우선 스냅 (반경 30 — 도로/트러스 확실히 연결)
  const hit = findNodeAt(wx, wy, 30);
  if (hit) return { x: hit.x, y: hit.y, node: hit };
  if (showGrid) return { x: Math.round(wx / GRID) * GRID, y: Math.round(wy / GRID) * GRID, node: null };
  return { x: wx, y: wy, node: null };
}
// 새 노드가 기존 빔 위에 떨어지면 빔을 자동 분할 (Poly Bridge식 — 구조 일체화)
function splitBeamAt(nd) {
  let best = null, bd = 8;
  for (const b of beams) {
    if (b.a === nd || b.b === nd) continue;
    const c = circleSeg(nd.x, nd.y, 0, { x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y });
    const d = Math.hypot(nd.x - c.qx, nd.y - c.qy);
    if (c.t < 0.05 || c.t > 0.95) continue; // 끝점 근처는 분할 대신 스냅으로 처리
    const l1 = Math.hypot(nd.x - b.a.x, nd.y - b.a.y);
    const l2 = Math.hypot(nd.x - b.b.x, nd.y - b.b.y);
    const M = MATERIALS[b.mat];
    if (d < bd && l1 >= M.minLen && l2 >= M.minLen) { bd = d; best = b; }
  }
  if (!best) return false;
  beams = beams.filter(x => x !== best);
  for (const [p, q] of [[best.a, nd], [nd, best.b]]) {
    beams.push({ id: beamSeq++, a: p, b: q, mat: best.mat, rest: Math.hypot(p.x - q.x, p.y - q.y), broken: false, strain: 0 });
  }
  return true;
}
// 근거리에 겹친 자유 노드를 자동 용접 (도로/목재 분리 방지)
function weldNodes(tol) {
  tol = tol || 10;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.fixed || a.anchor) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (b.fixed || b.anchor) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > tol) continue;
      // 병합 시 극단적 단부재가 생기면 건너뜀
      let ok = true;
      for (const bm of beams) {
        const p = bm.a === b ? a : bm.a, q = bm.b === b ? a : bm.b;
        if (p !== q && Math.hypot(p.x - q.x, p.y - q.y) < 6) { ok = false; break; }
      }
      if (!ok) continue;
      for (const bm of beams) {
        if (bm.a === b) bm.a = a;
        if (bm.b === b) bm.b = a;
        bm.rest = Math.hypot(bm.a.x - bm.b.x, bm.a.y - bm.b.y);
      }
      beams = beams.filter(x => x.a !== x.b);
      const seen = new Set();
      beams = beams.filter(x => {
        const k = Math.min(x.a.id, x.b.id) + '|' + Math.max(x.a.id, x.b.id) + '|' + x.mat;
        if (seen.has(k)) return false; seen.add(k); return true;
      });
      nodes.splice(j, 1); j--;
    }
  }
}
function beamExists(a, b, mat) { return beams.some(x => ((x.a === a && x.b === b) || (x.a === b && x.b === a)) && (!mat || x.mat === mat)); }
// 보강도로 (원작 원칙): 같은 구간에 겹친 목재/철강이 있으면 도로 강도 상승 (목재 +33% / 철강 +67%)
function reinfOf(b) {
  if (b.mat !== 'road' || b.broken) return 1;
  let wood = false;
  for (const x of beams) {
    if (x.broken || x.mat === 'road') continue;
    if ((x.a === b.a && x.b === b.b) || (x.a === b.b && x.b === b.a)) {
      if (x.mat === 'steel') return 1.67;
      if (x.mat === 'wood') wood = true;
    }
  }
  return wood ? 1.33 : 1;
}
function pushUndo() {
  undoStack.push(serialize());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}
function serialize() {
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  return JSON.stringify({
    nodes: nodes.map(n => ({ x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10, fixed: n.fixed, anchor: n.anchor })),
    beams: beams.map(b => ({ a: idx.get(b.a.id), b: idx.get(b.b.id), mat: b.mat })),
  });
}
function deserialize(json) {
  const d = JSON.parse(json);
  nodes = []; beams = []; nodeSeq = 1; beamSeq = 1;
  for (const n of d.nodes) { const nd = addNode(n.x, n.y, n.fixed, n.anchor); }
  for (const b of d.beams) {
    if (nodes[b.a] && nodes[b.b] && !beamExists(nodes[b.a], nodes[b.b]))
      beams.push({ id: beamSeq++, a: nodes[b.a], b: nodes[b.b], mat: b.mat, rest: Math.hypot(nodes[b.a].x - nodes[b.b].x, nodes[b.a].y - nodes[b.b].y), broken: false, strain: 0 });
  }
  refreshMasses();
}
function defaultBridge() {
  // 앵커 + 기본 도로 상판 자동 배치
  nodes = []; beams = []; nodeSeq = 1; beamSeq = 1;
  const L = LV();
  const amap = new Map();
  for (const [ax, ay] of L.anchors) {
    const key = ax + ',' + ay;
    if (!amap.has(key)) amap.set(key, addNode(ax, ay, true, true));
  }
  // 도로 상판: left->right 균등 분할 (끝점 보장, 격자 40px 배수 간격)
  // 원리: 도로 윗면(주행면)을 절벽면과 일치시킴 — 빔 충돌면(중심선-19px)과 지형면(15px)의
  //  4px 진입턱을 없애기 위해 중간 노드는 +4px 내림. 끝점은 앵커(roadY) 공유로 하중을 절벽에 직접 전달.
  const segs = Math.max(1, Math.round((L.right - L.left) / 40));
  let prev = null;
  for (let i = 0; i <= segs; i++) {
    const xx = L.left + (L.right - L.left) * i / segs;
    const isEnd = (i === 0 || i === segs);
    const yy = isEnd ? L.roadY : L.roadY + 4;
    let n = isEnd ? amap.get(xx + ',' + L.roadY) : null;
    if (!n) n = addNode(xx, yy, false, false);
    if (prev && !beamExists(prev, n)) beams.push({ id: beamSeq++, a: prev, b: n, mat: 'road', rest: Math.hypot(prev.x - n.x, prev.y - n.y), broken: false, strain: 0 });
    prev = n;
  }
  refreshMasses();
}

// ---------- 영속성 ----------
function saveKey() { return 'pbw_level_' + levelIndex; }
function saveGame(silent) {
  try { localStorage.setItem(saveKey(), serialize()); localStorage.setItem('pbw_level_idx', String(levelIndex)); if (!silent) toast('💾 저장 완료!'); } catch (e) { toast('저장 실패'); }
}
function loadGame(silent) {
  try {
    const s = localStorage.getItem(saveKey());
    if (s) { deserialize(s); if (!silent) toast('📂 불러오기 완료!'); return true; }
    if (!silent) toast('저장된 다리가 없어요');
    return false;
  } catch (e) { return false; }
}

// ---------- 강체 차량 생성 ----------
function spawnCar() {
  const spec = CARS[carType], L = LV();
  const sx = L.left - 130, sy = L.roadY - 60;
  const m = carMassMul;
  car = {
    spec, x: sx, y: sy, vx: 0, vy: 0, a: 0, va: 0,
    m: spec.mass * m, w: spec.w, h: spec.h,
    I: spec.mass * m * (spec.w * spec.w + spec.h * spec.h) / 12,
    wheels: [-1, 1].map(s => ({
      ox: s * (spec.w / 2 - 18), oy: spec.h / 2 + 10,
      x: sx + s * (spec.w / 2 - 18), y: sy + spec.h / 2 + 10,
      vx: 0, vy: 0, r: spec.wheelR, m: 2.2 * m, spin: 0, contact: false,
    })),
    restLen: 14, K: 1400, D: 70, contactT: 0, airT: 0,
  };
  dispatched = true; stuckTimer = 0; flipTimer = 0; goalTimer = 0; loseTimer = 0;
  sndClick();
  toast(spec.name + ' 출발! 🏁');
}
function chassisPoint(lx, ly) {
  const c = Math.cos(car.a), s = Math.sin(car.a);
  return { x: car.x + lx * c - ly * s, y: car.y + lx * s + ly * c };
}

// ---------- 강체 화물 ----------
function spawnBall() {
  const L = LV(), mx = (L.left + L.right) / 2;
  bodies.push({ kind: 'ball', x: mx + (Math.random() * 60 - 30), y: 60, vx: 0, vy: 0, a: 0, va: 0, r: 20, m: loadMass / 8 });
  toast('⚽ ' + loadMass + 'kg 강체 공 투하!');
}
function spawnCrate() {
  const L = LV(), mx = (L.left + L.right) / 2;
  bodies.push({ kind: 'crate', x: mx + (Math.random() * 80 - 40), y: 50, vx: 0, vy: 0, a: 0.2, va: 0, w: 34, h: 34, m: loadMass / 6 });
  toast('📦 ' + loadMass + 'kg 강체 상자 투하!');
}

// ---------- 충돌 유틸 ----------
function circleSeg(cx, cy, r, s) {
  const abx = s.x2 - s.x1, aby = s.y2 - s.y1;
  const L2 = abx * abx + aby * aby || 1;
  let t = ((cx - s.x1) * abx + (cy - s.y1) * aby) / L2;
  t = clamp(t, 0, 1);
  const qx = s.x1 + abx * t, qy = s.y1 + aby * t;
  let dx = cx - qx, dy = cy - qy;
  let d = Math.hypot(dx, dy);
  if (d === 0) { dx = 0; dy = -1; d = 1; }
  return { nx: dx / d, ny: dy / d, pen: r - d, t, qx, qy };
}
function pushBeamNodes(beam, t, ix, iy, posK, velK) {
  const A = beam.a, B = beam.b;
  const wa = 1 - t, wb = t;
  const aFix = A.fixed ? 0 : 1, bFix = B.fixed ? 0 : 1;
  const tot = wa * aFix + wb * bFix || 1;
  if (!A.fixed) { A.x += ix * wa * posK / tot * (aFix ? 1 : 0) * 2; A.px -= ix * wa * velK / tot * FIXED_DT * 60 * 0.02; A.py -= iy * wa * velK / tot * FIXED_DT * 60 * 0.02; }
  if (!B.fixed) { B.x += ix * wb * posK / tot * 2; B.px -= ix * wb * velK / tot * FIXED_DT * 60 * 0.02; B.py -= iy * wb * velK / tot * FIXED_DT * 60 * 0.02; }
  if (!A.fixed) A.y += iy * wa * posK / tot * 2;
  if (!B.fixed) B.y += iy * wb * posK / tot * 2;
}
function collideCircleWorld(x, y, vx, vy, r, mass, out, mode) {
  // 지형 + 빔과 충돌. out: {x,y,vx,vy,contact,beam,t,nx,ny,pen}
  // mode: 'car' = 도로(ROAD)하고만 충돌 (Poly Bridge 원작 원칙 — 트러스/케이블은 통과)
  //       'cargo' = 케이블 제외 전부 충돌 (하중 시험용 공/상자)
  // SLOP: 정지 접촉을 유지해 떨림 없이 하중을 전달 (Z값 경계 호버 방지)
  const SLOP = 2.2;
  let contact = false, hitBeam = null, ht = 0, hnx = 0, hny = -1, bestPen = -1e9;
  const segs = terrainSegs();
  for (const s of segs) {
    const c = circleSeg(x, y, r, s);
    if (c.pen > 0) {
      x += c.nx * c.pen; y += c.ny * c.pen;
      const vn = vx * c.nx + vy * c.ny;
      if (vn < 0) { vx -= c.nx * vn * 1.0; vy -= c.ny * vn * 1.0; vx *= 0.985; }
      contact = true; hnx = c.nx; hny = c.ny;
      if (c.pen > bestPen) bestPen = c.pen;
    } else if (c.pen > -SLOP) {
      // 정지 접촉: 작은 침투 속 제거 + 구름 마찰
      const vn = vx * c.nx + vy * c.ny;
      if (vn < 0 && vn > -80) { vx -= c.nx * vn; vy -= c.ny * vn; }
      vx *= 0.999;
      contact = true; hnx = c.nx; hny = c.ny;
      if (c.pen > bestPen) bestPen = c.pen;
    }
  }
  for (const b of beams) {
    if (b.broken) continue;
    const M = MATERIALS[b.mat];
    if (mode === 'car' && !M.collideCar) continue;  // 차량은 도로만 밟는다
    if (mode !== 'car' && M.noCollide) continue;    // 케이블은 만질 수 없는 이상적 인장재
    const th = M.thick / 2 + r * 0.9;
    const s = { x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y };
    const c = circleSeg(x, y, th, s);
    // 차량은 빔 끝단 캡을 무시 (이음매 턱 발사 방지 — 직선 구간 내부하고만 충돌)
    if (mode === 'car' && (c.t <= 0.002 || c.t >= 0.998)) continue;
    if (c.pen > 0) {
      const px = c.nx * c.pen, py = c.ny * c.pen;
      x += px; y += py;
      const vn = vx * c.nx + vy * c.ny;
      if (vn < 0) { vx -= c.nx * vn; vy -= c.ny * vn; vx *= 0.99; }
      contact = true; hitBeam = b; ht = c.t; hnx = c.nx; hny = c.ny;
      if (c.pen > bestPen) bestPen = c.pen;
      pushBeamNodes(b, c.t, px, py, 0.22, 1.0);
    } else if (c.pen > -SLOP) {
      const vn = vx * c.nx + vy * c.ny;
      if (vn < 0 && vn > -80) { vx -= c.nx * vn; vy -= c.ny * vn; }
      vx *= 0.999;
      contact = true; hitBeam = b; ht = c.t; hnx = c.nx; hny = c.ny;
      if (c.pen > bestPen) bestPen = c.pen;
    }
  }
  if (out) { out.x = x; out.y = y; out.vx = vx; out.vy = vy; out.contact = contact; out.beam = hitBeam; out.t = ht; out.nx = hnx; out.ny = hny; out.pen = bestPen; }
  return out || { x, y, vx, vy, contact, beam: hitBeam, t: ht, nx: hnx, ny: hny, pen: bestPen };
}
// 빔에 지속 하중(무게) 전달 — verlet 노드 힘 누적 (다음 스텝 적분에 반영)
function pushBeamForce(beam, t, fy) {
  if (!beam || beam.broken) return;
  const wa = beam.a.fixed ? 0 : 1 - t, wb = beam.b.fixed ? 0 : t;
  if (wa) beam.a.fy += fy * wa;
  if (wb) beam.b.fy += fy * wb;
}

// ---------- 물리 스텝 ----------
function physStep(dt) {
  simTime += dt;
  // 1) 노드 적분 (Verlet)
  for (const n of nodes) {
    if (n.fixed) { n.px = n.x; n.py = n.y; continue; }
    const vx = (n.x - n.px) * 0.996, vy = (n.y - n.py) * 0.996;
    n.px = n.x; n.py = n.y;
    n.x += vx + (n.fx / n.mass) * dt * dt;
    n.y += vy + (GRAV + n.fy / n.mass) * dt * dt;
    n.fx = 0; n.fy = 0;
  }
  // 2) 차량 서스펜션 힘 → 노드 하중 전달은 충돌에서 처리
  if (car) stepCar(dt);
  // 3) 강체 화물
  for (const b of bodies) stepBody(b, dt);
  // 4) constraint 반복
  for (let it = 0; it < ITER; it++) {
    for (const b of beams) {
      if (b.broken) continue;
      const M = MATERIALS[b.mat];
      let dx = b.b.x - b.a.x, dy = b.b.y - b.a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      if (b.mat === 'cable' && d <= b.rest) continue;   // 케이블은 늘어남만 저항
      const diff = (d - b.rest) / d * M.stiff;
      const wa = b.a.fixed ? 0 : 1 / b.a.mass, wb = b.b.fixed ? 0 : 1 / b.b.mass;
      const tot = wa + wb; if (!tot) continue;
      const ox = dx * diff, oy = dy * diff;
      b.a.x += ox * (wa / tot); b.a.y += oy * (wa / tot);
      b.b.x -= ox * (wb / tot); b.b.y -= oy * (wb / tot);
    }
    // 노드 지형 충돌 (절벽 위)
    for (const n of nodes) {
      if (n.fixed) continue;
      collideNodeTerrain(n);
    }
    // 차량/화물 충돌: 위치 보정은 매 패스, 하중(힘) 전달은 스텝당 1회 (중복 가중 방지)
    if (it % 4 === 0) {
      const couple = (it === 0);
      if (car) collideCar(couple);
      for (const b of bodies) collideBody(b, couple);
    }
  }
  // 5) 파단 판정 + 변형률 기록
  let mx = 0;
  for (const b of beams) {
    if (b.broken) continue;
    const d = beamLen(b);
    const strain = (d - b.rest) / b.rest;
    b.strain = strain;
    const M = MATERIALS[b.mat];
    const bonus = reinfOf(b); // 보강도로 합체 보너스
    const a = Math.abs(strain);
    if (a > mx) mx = a;
    if (strain > M.breakT * bonus || strain < M.breakC * bonus) {
      breakBeam(b);
    }
  }
  if (mx > maxStrainSeen) maxStrainSeen = mx;
  // 도로 처짐 파단 (보 공학 원칙): 받침 없는 데크는 해먹처럼 주저앉으며 파괴.
  // 국소 꺾임이 아니라 '건설 위치 대비 처짐'으로 판단 — 정상 트러스의 탄성 처짐과 맨도로 붕괴를 구분.
  for (const n of nodes) {
    if (n.fixed || n.anchor || n.y0 === undefined) continue;
    const rb = beams.filter(b => !b.broken && b.mat === 'road' && (b.a === n || b.b === n));
    if (!rb.length) continue;
    const loaded = rb.some(b => Math.abs(b.strain) > 0.03);
    if (loaded && (n.y - n.y0) > 28) {
      let victim = rb[0];
      for (const b of rb) if (Math.abs(b.strain) > Math.abs(victim.strain)) victim = b;
      breakBeam(victim);
    }
  }
  if (car) checkCarOutcome(dt);
  // 물 입자/파티클
  updateParticles(dt);
  // 물 감쇠 (노드)
  const L = LV();
  for (const n of nodes) {
    if (n.fixed) continue;
    if (n.y > L.waterY && inGap(n.x)) {
      n.px = lerp(n.px, n.x, 0.06); n.py = lerp(n.py, n.y, 0.06);
      if (Math.random() < 0.02) particles.push({ x: n.x, y: L.waterY, vx: (Math.random() - .5) * 60, vy: -Math.random() * 80, life: .6, t: 0, c: '#4fc3f7', r: 2 + Math.random() * 2 });
    }
  }
}
function collideNodeTerrain(n) {
  const L = LV(), r = 4;
  const onCliff = n.x < L.left || n.x > L.right || (L.island && n.x > L.island.x && n.x < L.island.x + L.island.w);
  if (!onCliff) return;
  let gy = L.roadY;
  if (L.island && n.x > L.island.x && n.x < L.island.x + L.island.w) gy = L.island.top;
  if (n.y > gy - r) {
    n.y = gy - r;
    const vy = n.y - n.py;
    if (vy > 0) n.py = n.y + vy * 0.2;
    n.px = lerp(n.px, n.x, 0.1);
  }
}

// ----- 강체 차량 -----
function stepCar(dt) {
  const c = Math.cos(car.a), s = Math.sin(car.a);
  // 중력
  car.vy += GRAV * dt;
  for (const wh of car.wheels) wh.vy += GRAV * dt;
  // 서스펜션 (섀시 하드포인트 <-> 휠)
  for (const wh of car.wheels) {
    const hx = car.x + wh.ox * c - wh.oy * s, hy = car.y + wh.ox * s + wh.oy * c;
    let dx = wh.x - hx, dy = wh.y - hy;
    let dist = Math.hypot(dx, dy) || 1e-6;
    const nx = dx / dist, ny = dy / dist;
    // 하드포인트 속도 (병진+회전)
    const rx = hx - car.x, ry = hy - car.y;
    const hpx = car.vx - car.va * ry, hpy = car.vy + car.va * rx;
    const rvx = wh.vx - hpx, rvy = wh.vy - hpy;
    const vn = rvx * nx + rvy * ny;
    let F = car.K * (dist - car.restLen) + car.D * vn;
    // 범프 스토퍼: 서스펜션 스트로크 물리 한계 (바퀴 늘어남/박힘 방지)
    if (dist > car.restLen + 14) F += (dist - car.restLen - 14) * 3000;
    if (dist < car.restLen - 10) F -= (car.restLen - 10 - dist) * 3000;
    const fx = nx * F, fy = ny * F;
    // 휠
    wh.vx -= fx / wh.m * dt; wh.vy -= fy / wh.m * dt;
    // 섀시 (힘 + 토크)
    car.vx += fx / car.m * dt; car.vy += fy / car.m * dt;
    car.va += (rx * fy - ry * fx) / car.I * dt;
  }
  // 구동 모터: 접촉 중인 휠이 노면을 뒤로 밀고 차를 앞으로
  for (const wh of car.wheels) {
    if (wh.contact && Math.abs(car.vx) < car.spec.top) {
      const F = car.spec.motor * (1 - car.vx / car.spec.top) * 0.5;
      car.vx += F / car.m * dt;
      wh.vx += F / wh.m * dt * 0.3;
    }
  }
  // 감쇠 + 적분
  car.vx *= 0.999; car.va *= 0.995;
  const vmax = car.spec.top * 1.3;
  if (car.vx > vmax) car.vx = vmax;
  if (car.vx < -vmax) car.vx = -vmax;
  car.x += car.vx * dt; car.y += car.vy * dt; car.a += car.va * dt;
  if (car.a > Math.PI) car.a -= Math.PI * 2;
  if (car.a < -Math.PI) car.a += Math.PI * 2;
  for (const wh of car.wheels) {
    wh.vx *= 0.999;
    wh.x += wh.vx * dt; wh.y += wh.vy * dt;
    wh.spin += (wh.vx / wh.r) * dt + car.vx * 0.002;
    wh.contact = false;
  }
  if (!isFinite(car.x + car.y + car.vx + car.vy + car.a)) { // 발산 방지
    const L = LV(); car.x = L.left - 130; car.y = L.roadY - 60; car.vx = car.vy = car.va = car.a = 0;
  }
}
function collideCar(couple) {
  const tmp = {};
  let anyContact = false;
  for (const wh of car.wheels) {
    collideCircleWorld(wh.x, wh.y, wh.vx, wh.vy, wh.r, wh.m, tmp, 'car');
    const wasAir = !wh.contact;
    wh.x = tmp.x; wh.y = tmp.y; wh.vx = tmp.vx; wh.vy = tmp.vy;
    wh.contact = tmp.contact;
    if (tmp.contact) {
      anyContact = true;
      car.contactT = simTime;
      // 모터 추가 견인
      if (Math.abs(car.vx) < car.spec.top) car.vx += 100 * FIXED_DT;
      wh.spin += car.vx * 0.004;
      wh.vx *= 0.998; // 구름 저항
      // 빔 위에 있으면 차량 무게를 다리에 전달 (지속 하중, 스텝당 1회)
      if (couple && tmp.beam) pushBeamForce(tmp.beam, tmp.t, (wh.m + car.m * 0.25) * GRAV);
    }
    void wasAir;
  }
  // 섀시 4모서리 충돌 (박스 근사)
  const hw = car.w / 2, hh = car.h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  let hits = 0;
  for (const [lx, ly] of corners) {
    const p = chassisPoint(lx, ly);
    collideCircleWorld(p.x, p.y, car.vx, car.vy, 7, car.m / 4, tmp, 'car');
    const dx = tmp.x - p.x, dy = tmp.y - p.y;
    if (dx * dx + dy * dy > 0.01) {
      car.x += dx * 0.7; car.y += dy * 0.7;
      const vn = car.vx * tmp.nx + car.vy * tmp.ny;
      if (vn < 0) { car.vx -= tmp.nx * vn * 1.2; car.vy -= tmp.ny * vn * 1.2; car.va *= 0.8; }
      if (tmp.beam) pushBeamNodes(tmp.beam, tmp.t, dx * 2.2, dy * 2.2, 0.3, 1.2);
      hits++;
      anyContact = true;
      car.contactT = simTime;
    } else if (tmp.contact) {
      anyContact = true;
      car.contactT = simTime;
      if (couple && tmp.beam) pushBeamForce(tmp.beam, tmp.t, car.m * 0.1 * GRAV);
    }
  }
  if (hits >= 2) { car.vx *= 0.97; car.va *= 0.94; }
  if (anyContact) { car.va *= 0.93; car.vx *= 0.999; } // 접지 시 자세 안정화
  if (car.va > 6) car.va = 6;
  if (car.va < -6) car.va = -6;
}
function checkCarOutcome(dt) {
  if (!dispatched || result) return;
  const L = LV();
  const speed = Math.hypot(car.vx, car.vy);
  // 성공: 깃발 통과
  if (car.x > goalX() && Math.abs(car.a) < 0.7 && car.y < L.roadY + 60) {
    goalTimer += dt;
    if (goalTimer > 0.4) return win();
  } else goalTimer = 0;
  // 수몰
  if (car.y > L.waterY + 6 && inGap(car.x)) {
    burst(car.x, L.waterY, '#4fc3f7', 26); sndFail();
    return lose('🌊 수몰!', '자동차가 물에 빠졌습니다. 하중 분산과 강성을 높이세요.');
  }
  if (car.y > H + 150) return lose('💥 추락!', '자동차가 계곡 아래로 떨어졌습니다.');
  // 전복
  if (Math.abs(car.a) > 2.2 && car.contactT > 0 && simTime - car.contactT < 1.2) flipTimer += dt; else flipTimer = 0;
  if (flipTimer > 1.4) return lose('🙃 전복!', '차량이 뒤집혔습니다. 노면이 평탄한지 확인하세요.');
  // 정체
  if (simTime > 4 && speed < 14 && car.x < goalX() - 20) stuckTimer += dt; else stuckTimer = 0;
  if (stuckTimer > 5) return lose('⏱ 정체!', '차량이 멈췄습니다. 다리가 휘었거나 끊어졌나요?');
  if (simTime > 60) return lose('⏱ 시간 초과!', '60초 안에 건너지 못했습니다.');
}
function win() {
  result = 'win';
  const usage = totalCost() / LV().budget;
  let stars = (brokenCount === 0 ? 1 : 0) + (usage < 0.8 ? 1 : 0) + (simTime < 25 ? 1 : 0);
  if (simOverBudget) stars = Math.min(stars, 2);
  sndWin();
  confetti();
  showOverlay(true, '🎉 레벨 클리어!', LV().desc, [
    ['⏱ 시간', simTime.toFixed(1) + 's'],
    ['💰 비용', fmt$(totalCost())],
    ['🧱 파손', brokenCount + '개'],
    ['⭐ 평가', '★'.repeat(Math.max(1, stars)) + '☆'.repeat(3 - Math.max(1, stars))],
  ]);
  try { localStorage.setItem('pbw_clear_' + levelIndex, '1'); } catch (e) {}
}
function lose(title, desc) {
  result = 'lose'; sndFail();
  showOverlay(false, title, desc, [
    ['⏱ 생존', simTime.toFixed(1) + 's'],
    ['🧱 파손', brokenCount + '개'],
    ['📈 최대변형', (maxStrainSeen * 100).toFixed(1) + '%'],
  ]);
}

// ----- 강체 화물 스텝 -----
function stepBody(b, dt) {
  b.vy += GRAV * dt;
  b.vx *= 0.999; b.va *= 0.99;
  b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.va * dt;
}
function collideBody(b, couple) {
  const tmp = {};
  if (b.kind === 'ball') {
    collideCircleWorld(b.x, b.y, b.vx, b.vy, b.r, b.m, tmp, 'cargo');
    b.x = tmp.x; b.y = tmp.y;
    // 반발 약간
    b.vx = tmp.vx * 0.98; b.vy = tmp.vy * (tmp.contact && tmp.vy > 0 ? -0.25 : 1);
    if (tmp.contact && couple && tmp.beam) pushBeamForce(tmp.beam, tmp.t, b.m * GRAV);
    if (tmp.contact && Math.abs(b.vy) > 150) { burst(b.x, b.y + b.r, '#cfd8e6', 6); }
  } else {
    // 상자: 4모서리를 강체 임펄스로
    const hw = b.w / 2, hh = b.h / 2;
    const c = Math.cos(b.a), s = Math.sin(b.a);
    const I = b.m * (b.w * b.w + b.h * b.h) / 12;
    for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      const px = b.x + lx * c - ly * s, py = b.y + lx * s + ly * c;
      // 코너 속도
      const rx = px - b.x, ry = py - b.y;
      const pvx = b.vx - b.va * ry, pvy = b.vy + b.va * rx;
      collideCircleWorld(px, py, pvx, pvy, 3, b.m / 4, tmp, 'cargo');
      const dx = tmp.x - px, dy = tmp.y - py;
      if (dx * dx + dy * dy > 0.01) {
        b.x += dx * 0.6; b.y += dy * 0.6;
        const vn = pvx * tmp.nx + pvy * tmp.ny;
        if (vn < 0) {
          const j = -(1.1) * vn / (1 / b.m + ((rx * tmp.ny - ry * tmp.nx) ** 2) / I);
          b.vx += j * tmp.nx / b.m; b.vy += j * tmp.ny / b.m;
          b.va += (rx * (j * tmp.ny) - ry * (j * tmp.nx)) / I;
          b.vx *= 0.97;
          if (tmp.beam) pushBeamNodes(tmp.beam, tmp.t, dx * 3, dy * 3, 0.3, 1.4);
        } else if (tmp.contact && couple && tmp.beam) {
          pushBeamForce(tmp.beam, tmp.t, (b.m / 4) * GRAV);
        }
      }
    }
  }
  // 물
  const L = LV();
  if (b.y > L.waterY && inGap(b.x)) {
    b.vx *= 0.96; b.vy = b.vy * 0.94 - 30 * FIXED_DT * 10;
    b.va *= 0.95;
    if (Math.random() < 0.1) particles.push({ x: b.x, y: L.waterY, vx: (Math.random() - .5) * 50, vy: -60, life: .5, t: 0, c: '#4fc3f7', r: 2 });
  }
}

// ---------- 파티클 ----------
// 부재 파단 (공통 처리 — 파티클·화면 피드백 포함)
function breakBeam(b) {
  if (b.broken) return;
  b.broken = true; b.strain = 0; brokenCount++;
  burst((b.a.x + b.b.x) / 2, (b.a.y + b.b.y) / 2, MATERIALS[b.mat].color, b.mat === 'road' ? 22 : 14);
  shake = Math.min(14, shake + 5);
  breakFlash = 0.45;
  sndBreak();
}
function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 220;
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: .5 + Math.random() * .5, t: 0, c: color, r: 2 + Math.random() * 3 });
  }
}
function confetti() {
  for (let i = 0; i < 120; i++) {
    particles.push({ x: Math.random() * W, y: -20 - Math.random() * 100, vx: (Math.random() - .5) * 120, vy: 120 + Math.random() * 160, life: 2.5, t: 0, c: ['#ff5252', '#ffd54f', '#69f0ae', '#40c4ff', '#e040fb'][i % 5], r: 3 + Math.random() * 3, conf: true });
  }
}
function updateParticles(dt) {
  for (const p of particles) { p.t += dt; p.vy += (p.conf ? 60 : 500) * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  particles = particles.filter(p => p.t < p.life && p.y < H + 60);
  if (particles.length > 600) particles.splice(0, particles.length - 600);
}

// ---------- 렌더 ----------
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(canvas.clientWidth * DPR);
  canvas.height = Math.floor(canvas.clientHeight * DPR);
  const cw = canvas.clientWidth || window.innerWidth, ch = canvas.clientHeight || window.innerHeight;
  const s = Math.min(cw / W, ch / H);
  view = { s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2 };
}
function w2s(x, y) { return [view.ox + x * view.s, view.oy + y * view.s]; }
function s2w(sx, sy) { return [(sx - view.ox) / view.s, (sy - view.oy) / view.s]; }
window.addEventListener('resize', resize);

function render() {
  const L = LV();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 배경
  const cw = canvas.clientWidth || window.innerWidth, ch = canvas.clientHeight || window.innerHeight;
  const g = ctx.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, '#0b1526'); g.addColorStop(0.55, '#14263f'); g.addColorStop(1, '#0e1a2e');
  ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s);
  if (shake > 0.2) ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);

  drawSky(); drawTerrain(L); drawWater(L);
  if (mode === 'build' && showGrid) drawGrid();
  drawAnchors(); drawBeams(); drawNodes(); drawBodies(); drawCar(); drawFlag(L);
  drawParticles(); drawPreview();
  ctx.restore();
  shake *= 0.88; if (shake < 0.2) shake = 0;
  // 파단 플래시 (빨간 테두리)
  if (breakFlash > 0.02) {
    ctx.strokeStyle = `rgba(244,67,54,${(breakFlash * 0.55).toFixed(3)})`;
    ctx.lineWidth = 26;
    ctx.strokeRect(0, 0, cw, ch);
    breakFlash *= 0.90;
  } else breakFlash = 0;
  flagWave += 0.08;
}
function drawSky() {
  // 태양
  const sg = ctx.createRadialGradient(1080, 110, 10, 1080, 110, 130);
  sg.addColorStop(0, 'rgba(255,236,180,.9)'); sg.addColorStop(1, 'rgba(255,236,180,0)');
  ctx.fillStyle = sg; ctx.fillRect(930, -20, 300, 260);
  ctx.fillStyle = '#ffecb3'; ctx.beginPath(); ctx.arc(1080, 110, 34, 0, 7); ctx.fill();
  // 구름
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  cloudT += 0.0016;
  for (let i = 0; i < 5; i++) {
    const cx = ((i * 340 + cloudT * 4000) % (W + 400)) - 200, cy = 70 + i * 36;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 70, 20, 0, 0, 7); ctx.ellipse(cx + 40, cy + 6, 50, 16, 0, 0, 7); ctx.ellipse(cx - 45, cy + 8, 44, 14, 0, 0, 7);
    ctx.fill();
  }
  // 먼 산
  ctx.fillStyle = '#1b2f4b';
  ctx.beginPath(); ctx.moveTo(0, 420);
  for (let x = 0; x <= W; x += 80) ctx.lineTo(x, 330 + Math.sin(x * 0.008 + 2) * 40 + (x % 160 === 0 ? -30 : 0));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
}
function drawTerrain(L) {
  // 절벽 본체
  ctx.fillStyle = '#2c2118';
  ctx.fillRect(0, L.roadY, L.left, H - L.roadY);
  ctx.fillRect(L.right, L.roadY, W - L.right, H - L.roadY);
  // 절벽 질감
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 97) % W, y = L.roadY + 20 + (i * 53) % (H - L.roadY - 30);
    if (x < L.left || x > L.right) ctx.fillRect(x, y, 26, 5);
  }
  if (L.island) {
    ctx.fillStyle = '#2c2118';
    ctx.fillRect(L.island.x, L.island.top, L.island.w, H - L.island.top);
  }
  // 잔디 윗면
  ctx.fillStyle = '#43a047';
  ctx.fillRect(0, L.roadY - 8, L.left + 2, 10);
  ctx.fillRect(L.right - 2, L.roadY - 8, W - L.right + 2, 10);
  if (L.island) ctx.fillRect(L.island.x, L.island.top - 8, L.island.w, 10);
  ctx.fillStyle = '#66bb6a';
  ctx.fillRect(0, L.roadY - 8, L.left + 2, 3);
  ctx.fillRect(L.right - 2, L.roadY - 8, W - L.right + 2, 3);
  if (L.island) ctx.fillRect(L.island.x, L.island.top - 8, L.island.w, 3);
  // 출발/도착 도로 연장선
  ctx.fillStyle = '#333945';
  ctx.fillRect(0, L.roadY - 14, L.left, 6);
  ctx.fillRect(L.right, L.roadY - 14, W - L.right, 6);
}
function drawWater(L) {
  const t = timeSec;
  const wg = ctx.createLinearGradient(0, L.waterY, 0, H);
  wg.addColorStop(0, 'rgba(41,121,189,.92)'); wg.addColorStop(1, 'rgba(13,43,77,.95)');
  ctx.fillStyle = wg;
  ctx.beginPath(); ctx.moveTo(L.left, H); ctx.lineTo(L.left, L.waterY);
  for (let x = L.left; x <= L.right; x += 16) ctx.lineTo(x, L.waterY + Math.sin(x * 0.05 + t * 2.4) * 5);
  ctx.lineTo(L.right, H); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.beginPath();
  for (let x = L.left; x <= L.right; x += 16) {
    const y = L.waterY + Math.sin(x * 0.05 + t * 2.4) * 5;
    x === L.left ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}
function drawGrid() {
  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += GRID) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y <= H; y += GRID) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.09)';
  ctx.beginPath();
  for (let x = 0; x <= W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y <= H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
}
function drawAnchors() {
  for (const n of nodes) {
    if (!n.anchor) continue;
    ctx.fillStyle = '#78909c';
    ctx.fillRect(n.x - 7.5, n.y - 7.5, 15, 15);
    ctx.fillStyle = '#546e7a';
    ctx.fillRect(n.x - 7.5, n.y + 2.5, 15, 5);
    ctx.fillStyle = '#263238';
    ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, 7); ctx.fill();
    ctx.fillStyle = '#eceff1';
    ctx.beginPath(); ctx.arc(n.x - 1.2, n.y - 1.2, 1.4, 0, 7); ctx.fill();
  }
}
function stressColor(mat, strain, boost) {
  const M = MATERIALS[mat];
  if (!showStress || mode === 'build') return M.color;
  const s = strain || 0, a = Math.abs(s);
  if (a < 0.015) return M.color;
  const lim0 = s > 0 ? M.breakT : Math.abs(M.breakC) > 10 ? M.breakT : Math.abs(M.breakC);
  const lim = lim0 * (boost || 1);
  const k = clamp(a / lim, 0, 1);
  const hex = M.color;
  const br = parseInt(hex.slice(1, 3), 16), bg = parseInt(hex.slice(3, 5), 16), bb = parseInt(hex.slice(5, 7), 16);
  const tr = s > 0 ? 244 : 30, tg = s > 0 ? 67 : 120, tb = s > 0 ? 54 : 255;
  return `rgb(${Math.round(lerp(br, tr, k))},${Math.round(lerp(bg, tg, k))},${Math.round(lerp(bb, tb, k))})`;
}
function drawBeams() {
  ctx.lineCap = 'round';
  for (const b of beams) {
    if (b.broken) continue;
    const M = MATERIALS[b.mat];
    if (b.mat === 'road') {
      const rb = reinfOf(b); // 보강 합체 배율 (빌드모드에서도 표시)
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = M.thick + 3;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.strokeStyle = stressColor('road', b.strain, rb); ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      // 보강 합체 표시: 겹친 목재/철강 색 테두리
      if (rb > 1) {
        let comp = null;
        for (const x of beams) {
          if (x.broken || x.mat === 'road') continue;
          if ((x.a === b.a && x.b === b.b) || (x.a === b.b && x.b === b.a)) { comp = x.mat; if (comp === 'steel') break; }
        }
        if (comp) {
          const dx = b.b.x - b.a.x, dy = b.b.y - b.a.y, d = Math.hypot(dx, dy) || 1;
          const nx = -dy / d * (M.thick / 2 - 1), ny = dx / d * (M.thick / 2 - 1);
          ctx.strokeStyle = MATERIALS[comp].color; ctx.lineWidth = 2.5;
          for (const sgn of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(b.a.x + nx * sgn, b.a.y + ny * sgn);
            ctx.lineTo(b.b.x + nx * sgn, b.b.y + ny * sgn);
            ctx.stroke();
          }
        }
      }
      // 중앙 차선
      ctx.strokeStyle = 'rgba(255,213,79,.85)'; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (b.mat === 'cable') {
      ctx.strokeStyle = stressColor('cable', b.strain); ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = M.thick + 2;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.strokeStyle = stressColor(b.mat, b.strain); ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      if (b.mat === 'wood') {
        ctx.strokeStyle = 'rgba(90,55,20,.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      }
    }
    // 과부하 발광
    if (mode === 'sim' && showStress && Math.abs(b.strain) > 0.05) {
      const M2 = MATERIALS[b.mat];
      const lim0 = b.strain > 0 ? M2.breakT : (Math.abs(M2.breakC) > 10 ? M2.breakT : Math.abs(M2.breakC));
      const lim = lim0 * reinfOf(b);
      if (Math.abs(b.strain) / lim > 0.7) {
        ctx.strokeStyle = b.strain > 0 ? 'rgba(244,67,54,.35)' : 'rgba(33,150,243,.35)';
        ctx.lineWidth = M.thick + 8;
        ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      }
    }
  }
  // 호버 강조 (지우개)
  if (mode === 'build' && tool === 'erase' && mouse.hoverBeam && !mouse.hoverBeam.broken) {
    const b = mouse.hoverBeam;
    ctx.strokeStyle = 'rgba(244,67,54,.8)'; ctx.lineWidth = MATERIALS[b.mat].thick + 6;
    ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
  }
}
function drawNodes() {
  for (const n of nodes) {
    if (n.anchor) continue;
    const isEnd = mouse.cur && mouse.cur.node === n;
    ctx.fillStyle = n.fixed ? '#4caf50' : (isEnd ? '#ffeb3b' : '#e8ecf3');
    ctx.beginPath(); ctx.arc(n.x, n.y, n.fixed ? 6 : 4.5, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}
function drawBodies() {
  for (const b of bodies) {
    ctx.save(); ctx.translate(b.x, b.y);
    if (b.kind === 'ball') {
      const g = ctx.createRadialGradient(-6, -8, 4, 0, 0, b.r + 4);
      g.addColorStop(0, '#ef5350'); g.addColorStop(1, '#8e0000');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, b.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(Math.round(b.m * 8) + 'kg', 0, 4);
    } else {
      ctx.rotate(b.a);
      ctx.fillStyle = '#8d6e63'; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.strokeStyle = '#4e342e'; ctx.lineWidth = 3; ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-b.w / 2, -b.h / 2); ctx.lineTo(b.w / 2, b.h / 2);
      ctx.moveTo(b.w / 2, -b.h / 2); ctx.lineTo(-b.w / 2, b.h / 2); ctx.stroke();
    }
    ctx.restore();
  }
}
function drawCar() {
  if (!car) return;
  // 서스펜션 암 → 코일 스프링 (Matter식 리지드 액슬 대신 스트로크가 보이는 코일)
  const c = Math.cos(car.a), s = Math.sin(car.a);
  for (const wh of car.wheels) {
    const hx = car.x + wh.ox * c - wh.oy * s, hy = car.y + wh.ox * s + wh.oy * c;
    const dx = wh.x - hx, dy = wh.y - hy, d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d, ny = dx / d, coils = 5, amp = 5;
    ctx.strokeStyle = '#1c2333'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(wh.x, wh.y); ctx.stroke();
    ctx.strokeStyle = '#9aa7bd'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= coils * 2; i++) {
      const t = i / (coils * 2);
      const off = (i % 2 === 0) ? 0 : amp;
      const px = hx + dx * t + nx * off, py = hy + dy * t + ny * off;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // 차체 — Matter식 chamfer(둥근 앞뒤) + 캐빈 + 등화류
  ctx.save(); ctx.translate(car.x, car.y); ctx.rotate(car.a);
  const w = car.w, h = car.h;
  const g = ctx.createLinearGradient(0, -h, 0, h);
  g.addColorStop(0, car.spec.color); g.addColorStop(1, 'rgba(0,0,0,.45)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2 - 6, w, h + 6, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 2; ctx.stroke();
  // 캐빈 (사다리꼴 유리)
  ctx.fillStyle = 'rgba(200,235,255,.92)';
  ctx.beginPath();
  ctx.moveTo(-w * 0.30, -h / 2 - 6);
  ctx.lineTo(-w * 0.18, -h / 2 - 19);
  ctx.lineTo(w * 0.22, -h / 2 - 19);
  ctx.lineTo(w * 0.34, -h / 2 - 6);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
  // 도어 라인 + 손잡이
  ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-w * 0.02, -h / 2 - 4); ctx.lineTo(-w * 0.02, h / 2); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(w * 0.03, -h / 2 + 2, 8, 2.5);
  // 범퍼
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(-w / 2 - 1, h / 2 - 5, 6, 5);
  ctx.fillRect(w / 2 - 5, h / 2 - 5, 6, 5);
  // 헤드라이트(앞) + 테일라이트(뒤)
  ctx.fillStyle = '#ffeb3b'; ctx.fillRect(w / 2 - 3, -6, 5, 7);
  ctx.fillStyle = 'rgba(255,235,59,.25)'; ctx.fillRect(w / 2 + 2, -9, 16, 13);
  ctx.fillStyle = '#e53935'; ctx.fillRect(-w / 2 - 2, -6, 5, 7);
  ctx.restore();
  // 바퀴 — 트레드 타이어 + 림 + 스포크
  for (const wh of car.wheels) {
    ctx.save(); ctx.translate(wh.x, wh.y);
    ctx.fillStyle = '#14181f'; ctx.beginPath(); ctx.arc(0, 0, wh.r, 0, 7); ctx.fill();
    ctx.strokeStyle = '#232c38'; ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const a = wh.spin * 0.6 + i * Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * wh.r * 0.86, Math.sin(a) * wh.r * 0.86);
      ctx.lineTo(Math.cos(a) * wh.r * 0.985, Math.sin(a) * wh.r * 0.985);
      ctx.stroke();
    }
    ctx.fillStyle = '#90a4ae'; ctx.beginPath(); ctx.arc(0, 0, wh.r * 0.55, 0, 7); ctx.fill();
    ctx.strokeStyle = '#37474f'; ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const a = wh.spin + i * Math.PI * 2 / 5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * wh.r * 0.9, Math.sin(a) * wh.r * 0.9); ctx.stroke();
    }
    ctx.fillStyle = '#263238'; ctx.beginPath(); ctx.arc(0, 0, wh.r * 0.16, 0, 7); ctx.fill();
    ctx.restore();
  }
}
function drawFlag(L) {
  const gx = goalX(), gy = L.roadY;
  ctx.strokeStyle = '#cfd8dc'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - 90); ctx.stroke();
  const wv = Math.sin(flagWave) * 6;
  ctx.fillStyle = '#4caf50';
  ctx.beginPath(); ctx.moveTo(gx, gy - 90);
  ctx.quadraticCurveTo(gx + 30, gy - 86 + wv, gx + 58, gy - 78 + wv);
  ctx.lineTo(gx, gy - 58); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('GOAL', gx + 27, gy - 66 + wv * 0.5);
  // 출발 깃발
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '12px sans-serif';
  ctx.fillText('START', L.left - 70, gy - 24);
}
function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = 1 - p.t / p.life;
    ctx.fillStyle = p.c;
    ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
  }
  ctx.globalAlpha = 1;
}
function drawPreview() {
  if (mode !== 'build' || tool !== 'build' || !mouse.down || !mouse.startNode || !mouse.cur) return;
  const a = mouse.startNode, b = mouse.cur;
  const len = Math.hypot(a.x - b.x, a.y - b.y);
  const M = MATERIALS[curMat];
  const ok = len >= M.minLen && len <= M.maxLen && !(a.node && b.node && (a.node === b.node || beamExists(a.node, b.node, curMat)));
  ctx.strokeStyle = ok ? 'rgba(105,240,174,.9)' : 'rgba(244,67,54,.9)';
  ctx.lineWidth = M.thick; ctx.setLineDash([8, 5]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = ok ? '#69f0ae' : '#ff8a80'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(len) + 'px · ' + fmt$(len * M.cost), (a.x + b.x) / 2, (a.y + b.y) / 2 - 10);
}

// ---------- HUD ----------
function toast(msg) { $('hint').textContent = msg; clearTimeout(toast._t); toast._t = setTimeout(() => { $('hint').textContent = defaultHint(); }, 2600); }
function defaultHint() {
  return mode === 'build'
    ? '드래그로 다리를 놓으세요 · 우클릭=지우기 · Space=주행 테스트'
    : '🚗 출발(D) 후 차량이 깃발에 닿으면 성공 · Space=건설로 복귀';
}
function updateHUD() {
  const L = LV(), cost = totalCost();
  $('budgetText').textContent = fmt$(cost) + ' / ' + fmt$(L.budget);
  const pct = clamp(cost / L.budget * 100, 0, 100);
  const f = $('budgetFill');
  f.style.width = pct + '%';
  f.style.background = pct < 70 ? 'var(--acc)' : pct <= 100 ? 'var(--warn)' : 'var(--bad)';
  $('maxStrain').textContent = mode === 'sim' ? (maxStrainSeen * 100).toFixed(1) + '%' : '—';
  $('btnBuild').classList.toggle('active', mode === 'build');
  $('btnSim').classList.toggle('hidden', mode !== 'build');
  $('btnStop').classList.toggle('hidden', mode !== 'sim');
  document.querySelectorAll('#palette .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('#materials .mat').forEach(b => b.classList.toggle('active', b.dataset.mat === curMat));
  document.querySelectorAll('#cars .car').forEach(b => b.classList.toggle('active', b.dataset.car === carType));
}
function showOverlay(isWin, title, desc, stats) {
  $('ovTitle').textContent = title;
  $('ovDesc').textContent = desc;
  $('ovStats').innerHTML = stats.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  $('ovNext').style.display = (isWin && levelIndex < LEVELS.length - 1) ? '' : 'none';
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ---------- 모드 전환 ----------
function enterSim() {
  if (mode === 'sim') return;
  // 원작처럼 예산 초과분도 관대하게: 120%까지 테스트 허용 (초과 시 ★ 감점)
  if (totalCost() > LV().budget * 1.2 + 1e-6) { toast('⚠️ 예산 20% 초과! 빔을 줄이거나 싼 자재로 바꾸세요'); sndFail(); return; }
  const overBudget = totalCost() > LV().budget + 1e-6;
  const roadExists = beams.some(b => b.mat === 'road' && !b.broken);
  if (!roadExists) { toast('⚠️ 도로(Road) 상판이 없어요! 1번 자재로 길을 놓으세요'); sndFail(); return; }
  pushUndoSoft();
  buildSnap = serialize();
  mode = 'sim'; result = null; simTime = 0; dispatched = false;
  maxStrainSeen = 0; brokenCount = 0; bodies = []; car = null; particles = [];
  for (const n of nodes) { n.px = n.x; n.py = n.y; n.fx = 0; n.fy = 0; n.y0 = n.y; }
  for (const b of beams) { b.broken = false; b.strain = 0; }
  refreshMasses();
  hideOverlay(); sndClick();
  simOverBudget = overBudget;
  toast(overBudget ? '⚠️ 예산 초과 상태로 테스트 중 (★ 감점)' : '▶ 시뮬레이션! 🚗 출발 버튼을 누르세요 (D)');
  $('hint').textContent = defaultHint();
}
function exitSim() {
  if (mode === 'build') return;
  mode = 'build'; car = null; bodies = []; particles = []; result = null;
  if (buildSnap) deserialize(buildSnap);
  hideOverlay(); sndClick();
  $('hint').textContent = defaultHint();
}
let softPushed = false;
function pushUndoSoft() { softPushed = true; }

// ---------- 레벨 전환 ----------
function setLevel(i, keepBridge) {
  // 이전 레벨 자동 저장
  try { if (nodes.length && beams.length) localStorage.setItem('pbw_level_' + levelIndex, serialize()); } catch (e) {}
  levelIndex = clamp(i, 0, LEVELS.length - 1);
  const sel = $('levelSelect');
  sel.value = String(levelIndex);
  carType = LV().car;
  undoStack = []; redoStack = [];
  mode = 'build'; car = null; bodies = []; particles = []; result = null; buildSnap = null;
  hideOverlay();
  const saved = keepBridge ? localStorage.getItem(saveKey()) : null;
  if (saved) { try { deserialize(saved); } catch (e) { defaultBridge(); } }
  else if (!loadGame(true)) defaultBridge();
  refreshCarList();
  updateHUD();
  toast('📍 ' + LV().name + ' — ' + LV().desc);
}

// ---------- 입력 ----------
function evPos(e) {
  const r = canvas.getBoundingClientRect();
  const sx = (e.clientX - r.left), sy = (e.clientY - r.top);
  const [wx, wy] = s2w(sx, sy);
  return { sx, sy, wx, wy };
}
function distToBeam(wx, wy, b) {
  const s = { x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y };
  const c = circleSeg(wx, wy, 0, s);
  return Math.hypot(wx - c.qx, wy - c.qy);
}
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  audio();
  canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  const p = evPos(e);
  mouse.sx = p.sx; mouse.sy = p.sy; mouse.wx = p.wx; mouse.wy = p.wy;
  mouse.down = true; mouse.moved = false;
  if (e.button === 2) { // 우클릭 지우기
    eraseAt(p.wx, p.wy);
    mouse.rdown = true;
    return;
  }
  if (mode !== 'build') return;
  if (tool === 'build') {
    const sp = snapPoint(p.wx, p.wy);
    mouse.startNode = sp; mouse.cur = sp;
  } else if (tool === 'move') {
    const n = findNodeAt(p.wx, p.wy, 22);
    mouse.dragNode = (n && !n.fixed) ? n : null;
    if (mouse.dragNode) pushUndo();
  } else if (tool === 'erase') {
    eraseAt(p.wx, p.wy);
  }
});
canvas.addEventListener('pointermove', e => {
  const p = evPos(e);
  mouse.sx = p.sx; mouse.sy = p.sy;
  const dx = p.wx - mouse.wx, dy = p.wy - mouse.wy;
  if (Math.abs(dx) + Math.abs(dy) > 1) mouse.moved = true;
  mouse.wx = p.wx; mouse.wy = p.wy;
  if (mode === 'build') {
    if (tool === 'build' && mouse.down && mouse.startNode) mouse.cur = snapPoint(p.wx, p.wy);
    else mouse.cur = snapPoint(p.wx, p.wy);
    if (tool === 'move' && mouse.dragNode && mouse.down) {
      const sp = snapPoint(p.wx, p.wy);
      if (tryMoveNode(mouse.dragNode, clamp(sp.x, 0, W), clamp(sp.y, 0, H))) refreshMasses();
    }
    if (tool === 'erase' && mouse.down) eraseAt(p.wx, p.wy, true);
    mouse.hoverBeam = null;
    let bd = 12;
    for (const b of beams) { const d = distToBeam(p.wx, p.wy, b); if (d < bd) { bd = d; mouse.hoverBeam = b; } }
  }
});
window.addEventListener('pointerup', e => {
  if (e.target !== canvas && e.type === 'pointerup') { /* 팔레트 클릭 등 */ }
  if (!mouse.down && !mouse.rdown) return;
  mouse.down = false; mouse.rdown = false;
  if (mode !== 'build') { mouse.startNode = null; mouse.dragNode = null; return; }
  if (tool === 'build' && mouse.startNode && mouse.cur && e.button !== 2) {
    const a = mouse.startNode, b = mouse.cur;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 4) tryBuild(a, b);
  }
  if (mouse.dragNode) { weldNodes(); refreshMasses(); updateHUD(); }
  mouse.startNode = null; mouse.dragNode = null;
});
// 노드 이동 + 연결 빔 길이 제한 검증 (초과 시 원위치 — 공짜 늘이기 방지)
function tryMoveNode(dn, x, y) {
  const ox = dn.x, oy = dn.y;
  dn.x = x; dn.y = y;
  for (const b of beams) {
    if (b.a !== dn && b.b !== dn) continue;
    const M = MATERIALS[b.mat];
    const l = Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y);
    if (l > M.maxLen + 0.5 || l < M.minLen - 0.5) { dn.x = ox; dn.y = oy; return false; }
  }
  for (const b of beams) {
    if (b.a === dn || b.b === dn) b.rest = Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y);
  }
  return true;
}
function tryBuild(a, b) {
  const M = MATERIALS[curMat];
  const len = Math.hypot(a.x - b.x, a.y - b.y);
  if (len < M.minLen) { toast('너무 짧아요 (≥' + M.minLen + 'px)'); return; }
  if (len > M.maxLen) { toast('너무 길어요! ' + M.name + ' 최대 ' + M.maxLen + 'px'); sndFail(); return; }
  pushUndo();
  let na = a.node, nb = b.node;
  let freshA = false, freshB = false;
  if (!na) { na = addNode(clamp(a.x, 0, W), clamp(a.y, 0, H), false, false); freshA = true; }
  if (!nb) { nb = addNode(clamp(b.x, 0, W), clamp(b.y, 0, H), false, false); freshB = true; }
  if (na === nb) { if (freshA) nodes = nodes.filter(x => x !== na); refreshMasses(); updateHUD(); return; }
  // 새 노드가 기존 빔 위면 분할 → 구조 일체화
  if (freshA) splitBeamAt(na);
  if (freshB) splitBeamAt(nb);
  if (beamExists(na, nb, curMat)) { refreshMasses(); updateHUD(); return; }
  beams.push({ id: beamSeq++, a: na, b: nb, mat: curMat, rest: Math.hypot(na.x - nb.x, na.y - nb.y), broken: false, strain: 0 });
  weldNodes();
  refreshMasses(); updateHUD(); sndClick();
}
function eraseAt(wx, wy, soft) {
  let bd = 14, target = null;
  for (const b of beams) { const d = distToBeam(wx, wy, b); if (d < bd) { bd = d; target = b; } }
  if (target) {
    if (!soft) pushUndo();
    beams = beams.filter(x => x !== target);
    pruneNodes(); refreshMasses(); updateHUD();
    return;
  }
  const n = findNodeAt(wx, wy, 18);
  if (n && !n.fixed && !n.anchor) {
    if (!soft) pushUndo();
    beams = beams.filter(x => x.a !== n && x.b !== n);
    nodes = nodes.filter(x => x !== n);
    refreshMasses(); updateHUD();
  }
}
function pruneNodes() {
  nodes = nodes.filter(n => n.fixed || n.anchor || beams.some(b => b.a === n || b.b === n));
}

// ---------- 키보드 ----------
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (k === ' ') { e.preventDefault(); mode === 'build' ? enterSim() : exitSim(); }
  else if (k === '1' || k === '2' || k === '3' || k === '4') setMat(MAT_ORDER[+k - 1]);
  else if (k === 'b') setTool('build');
  else if (k === 'e') setTool('erase');
  else if (k === 'm') setTool('move');
  else if (k === 'd' && mode === 'sim' && !car) spawnCar();
  else if (k === 'g') { showGrid = !showGrid; $('gridToggle').checked = showGrid; }
  else if (k === 'escape') { $('help').classList.add('hidden'); if (mode === 'sim') exitSim(); }
});
function doUndo() {
  if (!undoStack.length) return;
  redoStack.push(serialize());
  deserialize(undoStack.pop());
  updateHUD(); sndClick();
}
function doRedo() {
  if (!redoStack.length) return;
  undoStack.push(serialize());
  deserialize(redoStack.pop());
  updateHUD(); sndClick();
}

// ---------- UI 구성 ----------
function setMat(m) { curMat = m; tool = 'build'; updateHUD(); sndClick(); }
function setTool(t) { tool = t; updateHUD(); sndClick(); }
function buildPalette() {
  const box = $('materials'); box.innerHTML = '';
  for (const m of MAT_ORDER) {
    const M = MATERIALS[m];
    const b = document.createElement('button');
    b.className = 'mat'; b.dataset.mat = m;
    b.innerHTML = `<span class="sw" style="background:${M.color}"></span>
      <span class="nm">${M.name} <small>$${M.cost}/px · 최대${M.maxLen}px</small></span>
      <span class="key">${M.key}</span>`;
    b.onclick = () => setMat(m);
    box.appendChild(b);
  }
  document.querySelectorAll('#palette .tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
}
function refreshCarList() {
  const box = $('cars'); box.innerHTML = '';
  for (const c of CAR_ORDER) {
    const s = CARS[c];
    const b = document.createElement('button');
    b.className = 'car'; b.dataset.car = c;
    b.innerHTML = `<span>${s.name}</span><small style="color:var(--dim)">${s.mass} · ${s.top}km/h</small>`;
    b.onclick = () => { carType = c; updateHUD(); sndClick(); };
    box.appendChild(b);
  }
}
function bindUI() {
  const sel = $('levelSelect');
  LEVELS.forEach((L, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = L.name + ' · ' + fmt$(L.budget);
    sel.appendChild(o);
  });
  sel.onchange = () => setLevel(+sel.value);
  $('prevLevel').onclick = () => setLevel(levelIndex - 1);
  $('nextLevel').onclick = () => setLevel(levelIndex + 1);
  $('btnBuild').onclick = exitSim;
  $('btnSim').onclick = enterSim;
  $('btnStop').onclick = exitSim;
  $('btnDrive').onclick = () => { if (mode !== 'sim') enterSim(); if (mode === 'sim' && !car) spawnCar(); };
  $('btnBall').onclick = () => { if (mode !== 'sim') enterSim(); if (mode === 'sim') spawnBall(); };
  $('btnCrate').onclick = () => { if (mode !== 'sim') enterSim(); if (mode === 'sim') spawnCrate(); };
  $('btnUndo').onclick = doUndo; $('btnRedo').onclick = doRedo;
  $('btnClear').onclick = () => {
    if (mode !== 'build' || !confirm('앵커를 제외한 다리를 모두 지울까요?')) return;
    pushUndo();
    beams = []; pruneNodes(); refreshMasses(); updateHUD();
  };
  $('gridToggle').onchange = e => showGrid = e.target.checked;
  $('stressToggle').onchange = e => showStress = e.target.checked;
  $('carMass').oninput = e => { carMassMul = +e.target.value; $('carMassVal').textContent = (+e.target.value).toFixed(1) + '×'; };
  $('loadMass').oninput = e => { loadMass = +e.target.value; $('loadMassVal').textContent = e.target.value + 'kg'; };
  $('btnSave').onclick = () => saveGame(false);
  $('btnLoad').onclick = () => { if (loadGame(false)) updateHUD(); };
  $('btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify({ level: levelIndex, data: JSON.parse(serialize()) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'polybridge-level' + (levelIndex + 1) + '.json';
    a.click(); URL.revokeObjectURL(a.href);
    toast('📤 설계도 내보내기 완료!');
  };
  $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result);
        pushUndo();
        deserialize(JSON.stringify(j.data || j));
        updateHUD(); toast('📥 가져오기 완료!');
      } catch (err) { toast('가져오기 실패: JSON 오류'); }
    };
    r.readAsText(f); e.target.value = '';
  };
  $('btnHelp').onclick = () => $('help').classList.remove('hidden');
  $('helpClose').onclick = () => { $('help').classList.add('hidden'); try { localStorage.setItem('pbw_seen', '1'); } catch (e) {} };
  $('ovRetry').onclick = () => { hideOverlay(); exitSim(); enterSim(); };
  $('ovBuild').onclick = () => exitSim();
  $('ovNext').onclick = () => setLevel(levelIndex + 1);
}

// ---------- 메인 루프 ----------
let last = performance.now(), acc = 0, fpsE = 60;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;
  fpsE = lerp(fpsE, 1 / Math.max(dt, 1e-4), 0.05);
  timeSec += dt;
  if (mode === 'sim' && !result) {
    acc += dt;
    let n = 0;
    while (acc >= FIXED_DT && n < 3) { physStep(FIXED_DT); acc -= FIXED_DT; n++; }
    if (n === 3) acc = 0;
  } else if (mode === 'sim' && result) {
    // 결과 후에도 잔해는 계속
    acc += dt;
    let n = 0;
    while (acc >= FIXED_DT && n < 2) {
      simTime += 0; // 시간 고정
      // 가벼운 잔해 스텝 (파단 없음)
      for (const nn of nodes) {
        if (nn.fixed) continue;
        const vx = (nn.x - nn.px) * 0.99, vy = (nn.y - nn.py) * 0.99;
        nn.px = nn.x; nn.py = nn.y; nn.x += vx; nn.y += vy + GRAV * FIXED_DT * FIXED_DT;
      }
      for (let it = 0; it < 6; it++) for (const b of beams) {
        if (b.broken) continue;
        const M = MATERIALS[b.mat];
        const dx = b.b.x - b.a.x, dy = b.b.y - b.a.y, d = Math.hypot(dx, dy) || 1e-6;
        if (b.mat === 'cable' && d <= b.rest) continue;
        const diff = (d - b.rest) / d * M.stiff;
        const wa = b.a.fixed ? 0 : 1, wb = b.b.fixed ? 0 : 1, t = wa + wb;
        if (!t) continue;
        b.a.x += dx * diff * wa / t; b.a.y += dy * diff * wa / t;
        b.b.x -= dx * diff * wb / t; b.b.y -= dy * diff * wb / t;
      }
      updateParticles(FIXED_DT);
      acc -= FIXED_DT; n++;
    }
    if (n === 2) acc = 0;
  }
  render();
  updateHUD();
  if ((frame._c = (frame._c || 0) + 1) % 20 === 0) $('fps').textContent = Math.round(fpsE) + 'fps';
}

// 디버그/스크린샷용 데모: ?demo=1 이면 샘플 트러스를 짓고 자동 주행
function demoBridge() {
  const L = LV();
  const deck = nodes.filter(n => !n.anchor && (n.y - L.roadY) >= -1 && (n.y - L.roadY) <= 6 && n.x >= L.left - 1 && n.x <= L.right + 1).sort((a, b) => a.x - b.x);
  if (!deck.length) return;
  const lows = deck.map(d => addNode(d.x, L.roadY + 75, false, false));
  const mk = (a, b, mat) => beams.push({ id: beamSeq++, a, b, mat, rest: Math.hypot(a.x - b.x, a.y - b.y), broken: false, strain: 0 });
  deck.forEach((d, i) => {
    mk(d, lows[i], 'wood');
    if (i < deck.length - 1) { mk(lows[i], lows[i + 1], 'wood'); mk(deck[i], lows[i + 1], 'wood'); }
  });
  refreshMasses(); updateHUD();
}

// ---------- 부팅 ----------
function boot() {  // roundRect 폴리필 (구형 브라우저/GitHub Pages 안정성)
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(typeof r === 'number' ? r : 4, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }
  buildPalette(); bindUI(); resize();
  let idx = 0;
  try { idx = +(localStorage.getItem('pbw_level_idx') || 0); } catch (e) {}
  setLevel(clamp(idx, 0, LEVELS.length - 1));
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('nohelp') === '1' || params.get('demo') === '1') $('help').classList.add('hidden');
    else if (!localStorage.getItem('pbw_seen')) $('help').classList.remove('hidden');
  } catch (e) {}
  try {
    if (new URLSearchParams(location.search).get('demo') === '1') {
      $('help').classList.add('hidden');
      setTimeout(() => { demoBridge(); enterSim(); }, 400);
      setTimeout(() => { if (mode === 'sim' && !car) spawnCar(); }, 900);
    }
  } catch (e) {}
  requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); });
}
boot();
