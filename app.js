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
const ITER = 30;              // constraint 반복 (정적 처짐·트램펄린 억제)
const GRID = 20;
const BARREL_FRAC = 0.62; // 유압 칼라(러그점) 위치 — 몸통 쪽 고정

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let DPR = 1;
// 카메라: view = 화면 맞춤 기준, cam = 중심/배율 (줌아웃 전체보기 ↔ 줌인 정밀 작업)
let view = { s: 1, cw: 1280, ch: 720 };
let cam = { cx: W / 2, cy: H / 2, z: 1 };
function fitCamera() { cam.cx = W / 2; cam.cy = H / 2; cam.z = 1; clampCam(); updateZoomUI(); }
function clampCam() {
  cam.z = clamp(cam.z, 0.45, 3);
  const b = camBounds();
  cam.cx = clamp(cam.cx, b.x0, b.x1);
  cam.cy = clamp(cam.cy, b.y0, b.y1);
}
function camBounds() {
  const vw = view.cw / (view.s * cam.z), vh = view.ch / (view.s * cam.z);
  const mx = Math.max(200, (W - vw) / 2 + 200), my = Math.max(150, (H - vh) / 2 + 150);
  return { x0: W / 2 - mx, x1: W / 2 + mx, y0: H / 2 - my, y1: H / 2 + my };
}
function effS() { return view.s * cam.z; }
function w2s(x, y) { const s = effS(); return [view.cw / 2 + (x - cam.cx) * s, view.ch / 2 + (y - cam.cy) * s]; }
function s2w(sx, sy) { const s = effS(); return [cam.cx + (sx - view.cw / 2) / s, cam.cy + (sy - view.ch / 2) / s]; }
function zoomAt(sx, sy, f) {
  const [wx, wy] = s2w(sx, sy);
  cam.z = clamp(cam.z * f, 0.45, 3);
  const s = effS();
  cam.cx = wx - (sx - view.cw / 2) / s;
  cam.cy = wy - (sy - view.ch / 2) / s;
  clampCam(); updateZoomUI();
}
function updateZoomUI() {
  const sl = $('zoomSlider'), lb = $('zoomLabel');
  if (sl) sl.value = Math.round(cam.z * 100);
  if (lb) lb.textContent = Math.round(cam.z * 100) + '%';
  const b = camBounds();
  const px = $('panX'), py = $('panY');
  if (px) px.value = Math.round((cam.cx - b.x0) / (b.x1 - b.x0) * 1000);
  if (py) py.value = Math.round((cam.cy - b.y0) / (b.y1 - b.y0) * 1000);
}
function panSliderTo() {
  const b = camBounds();
  const px = $('panX'), py = $('panY');
  if (px && px.value !== undefined && px.value !== '') cam.cx = b.x0 + (+px.value / 1000) * (b.x1 - b.x0);
  if (py && py.value !== undefined && py.value !== '') cam.cy = b.y0 + (+py.value / 1000) * (b.y1 - b.y0);
  clampCam(); updateZoomUI();
}

// ---------- 자재 ----------
// 원리 (Poly Bridge 공식 스펙에서 도출한 상대 비율 — wood=1 기준):
//  비용: road 1.1 / wood 1 / steel 2.5 / cable 2 | 강도: road 1.125 / wood 1 / steel 2.5 / cable 2.75(인장전용)
//  무게: steel > road > wood > cable | 길이: road=wood(짧음) < steel(김) < cable(무제한급)
//  buckLen: 이 길이 초과 압축재는 오일러 좌굴로 한계 저하 (한계 ∝ 1/L²)
//  yieldR: 항복비 — 초과 시 영구 변형(소성). 콘크리트 취성(0.95) / 목재(0.7) / 강재 연성(0.5)
//  tensionOnly: 인장 전용 (로프·케이블 — 압축엔 힘 0, 축 늘어짐)
//  자재 원천 (Reddit r/PolyBridge 실측 인장pg비 + 공식 매뉴얼): wood 20.4 / road 22.9 / spring 24.5 /
//    rope 30.6 / rroad 38.2 / steel·유압(비작동) 51 / cable 56 / 유압(작동) 254.8
//  ※ 기존 4종 한계는 검증된 밸런스 유지, 신규 자재는 역할(저가 인장/유연/피스톤)으로 배치
const MATERIALS = {
  road:  { name: '도로', en: 'ROAD',   cost: 3.3, breakT: 0.20, breakC: -0.13, stiff: 1.0,  wpp: 0.030, maxLen: 120, minLen: 15, thick: 11, color: '#3a3f4a', key: '1', collideCar: true, buckLen: 60, yieldR: 0.95 },
  wood:  { name: '목재', en: 'WOOD',   cost: 3.0, breakT: 0.024, breakC: -0.020, stiff: 0.8,  wpp: 0.016, maxLen: 120, minLen: 15, thick: 7,  color: '#b07a45', key: '2', collideCar: false, buckLen: 80, yieldR: 0.7 },
  steel: { name: '철강', en: 'STEEL',  cost: 7.5, breakT: 0.40, breakC: -0.26, stiff: 1.0,  wpp: 0.045, maxLen: 190, minLen: 15, thick: 8,  color: '#5aa9ff', key: '3', collideCar: false, buckLen: 110, yieldR: 0.5 },
  cable: { name: '케이블', en: 'CABLE', cost: 6.0, breakT: 0.44, breakC: -1e9, stiff: 0.55, wpp: 0.006, maxLen: 300, minLen: 15, thick: 3,  color: '#dfe6f2', key: '4', collideCar: false, noCollide: true, tensionOnly: true, buckLen: 0, yieldR: 0.8 },
  rope:  { name: '로프', en: 'ROPE',   cost: 3.7, breakT: 0.06, breakC: -1e9, stiff: 0.5,  wpp: 0.004, maxLen: 350, minLen: 15, thick: 2,  color: '#a1887f', key: '5', collideCar: false, noCollide: true, tensionOnly: true, buckLen: 0, yieldR: 0.8 },
  rroad: { name: '강화도로', en: 'ROAD+', cost: 5.5, breakT: 0.33, breakC: -0.20, stiff: 1.0,  wpp: 0.038, maxLen: 120, minLen: 15, thick: 12, color: '#41454f', key: '6', collideCar: true, buckLen: 60, yieldR: 0.9 },
  spring:{ name: '스프링', en: 'SPRING', cost: 4.5, breakT: 0.30, breakC: -0.30, stiff: 0.15, wpp: 0.010, maxLen: 200, minLen: 15, thick: 4,  color: '#9ccc65', key: '7', collideCar: false, buckLen: 0, yieldR: 0.9 },
  hyd:   { name: '유압', en: 'HYD',     cost: 12.5, breakT: 0.30, breakC: -0.18, stiff: 1.0,  wpp: 0.050, maxLen: 190, minLen: 15, thick: 9,  color: '#ff8f00', key: '8', collideCar: false, buckLen: 70, yieldR: 0.85 },
};
const MAT_ORDER = ['road', 'wood', 'steel', 'cable', 'rope', 'rroad', 'spring', 'hyd'];

// ---------- 차량 ----------
// 설계 원천: Matter.js 공식 car 예제(MIT)의 검증된 치수 원리를 우리 서스펜션 방식에 이식.
//  - 휠베이스: 섀시 끝에서 안쪽으로 18px (w/2-18) — 바깥 배치로 전복 안정성 확보
//  - 바퀴: 고마찰 타이어, 섀시-바퀴 충돌 그룹 분리(서스펜션으로만 연결)
//  - 액슬: Matter는 강체(stiffness 1)지만 우리 지형(다리 이음매) 대응을 위해 짧고 단단한 서스펜션으로 대체
const CARS = {
  light: { name: '🚗 경차', w: 76, h: 20, wheelR: 15, mass: 10, motor: 800, top: 135, color: '#ff5252' },
  suv:   { name: '🚙 SUV',  w: 90, h: 24, wheelR: 17, mass: 15, motor: 1000, top: 125, color: '#26a69a' },
  truck: { name: '🚚 트럭', w: 112, h: 27, wheelR: 18, mass: 24, motor: 1250, top: 112, color: '#ffa000' },
  sport: { name: '🏎️ 스포츠카', w: 78, h: 18, wheelR: 14, mass: 9, motor: 1100, top: 200, accel: 2.4, color: '#ab47bc' },
};
const CAR_ORDER = ['light', 'suv', 'truck', 'sport'];

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
  { name: '∞ 자유 모드', roadY: 360, left: 200, right: 1080, waterY: 600, budget: Infinity, free: true,
    desc: '예산 무제한 샌드박스! 온갖 다리를 마음껏 실험해보세요.',
    anchors: [[200,360],[1080,360],[200,452],[1080,452],[200,544],[1080,544],[110,452],[1170,452],[200,268],[1080,268],[110,268],[1170,268],[110,360],[1170,360]],
    car: 'light' },
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
let stuckX = 0, stuckT = 0;
let debris = [];       // 파단 잔해 (시뮬 전용)
let hydPhase = 1.0;    // 유압 위상 (1.0 중립 ↔ 1.5 신장 / 0.5 수축)
let simOverBudget = false;
let simCost = 0; // 주행 시작 시점 비용 고정 (시뮬 중 기하학 변동에 흔들리지 않음)
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
  // 절벽 모서리 모따기 (둥근 교대): 처짐으로 낮아진 차체가 수직 벽에 박히지 않고 비탈을 타고 오름
  segs.push({ x1: L.left, y1: L.roadY, x2: L.left + 18, y2: L.roadY + 5 });
  segs.push({ x1: L.right, y1: L.roadY, x2: L.right - 18, y2: L.roadY + 5 });
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
  const n = { id: nodeSeq++, x, y, px: x, py: y, fx: 0, fy: 0, mass: 1.2, fixed: !!fixed, anchor: !!anchor, y0: y, lug: null };
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
function refreshMasses() { for (const n of nodes) n.mass = nodeMass(n); seatLugs(); syncSpringMids(); }
// 유압 러그 조회 (해당 빔의 칼라점)
function hydLug(b) {
  for (const n of nodes) {
    const L = n.lug;
    if (L && ((L.a === b.a && L.b === b.b) || (L.a === b.b && L.b === b.a))) return n;
  }
  return null;
}
function lugPoint(L) {
  const dx = L.b.x - L.a.x, dy = L.b.y - L.a.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const t = Math.min(L.len, d * 0.95) / d;
  return { x: L.a.x + dx * t, y: L.a.y + dy * t, f: t };
}
function seatLugs() {
  for (const n of nodes) {
    if (!n.lug) continue;
    const L = n.lug;
    if (L.a === L.b || !nodes.includes(L.a) || !nodes.includes(L.b)) { n.lug = null; continue; }
    const p = lugPoint(L);
    n.x = p.x; n.y = p.y; n.px = p.x; n.py = p.y;
  }
}
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
    if (b.mat === 'hyd') continue; // 유압은 분할하지 않음 (3점식 통째 유지)
    const c = circleSeg(nd.x, nd.y, 0, { x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y });
    const d = Math.hypot(nd.x - c.qx, nd.y - c.qy);
    if (c.t < 0.05 || c.t > 0.95) continue; // 끝점 근처는 분할 대신 스냅으로 처리
    const l1 = Math.hypot(nd.x - b.a.x, nd.y - b.a.y);
    const l2 = Math.hypot(nd.x - b.b.x, nd.y - b.b.y);
    const M = MATERIALS[b.mat];
    if (d < bd && l1 >= M.minLen && l2 >= M.minLen) { bd = d; best = b; }
  }
  if (!best) return false;
  const BM = MATERIALS[best.mat];
  // 철강은 분할하지 않고 러그점으로 부착 (생성 단위 보존 — A/B 별개 객체 유지, 핀 조인트 회전 가능)
  if (best.mat === 'steel') {
    nd.lug = { a: best.a, b: best.b, len: Math.hypot(nd.x - best.a.x, nd.y - best.a.y) };
    return true;
  }
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
      // 유압 러그 참조도 생존 노드로 추적
      for (const n2 of nodes) {
        if (n2.lug) {
          if (n2.lug.a === b) n2.lug.a = a;
          if (n2.lug.b === b) n2.lug.b = a;
          if (n2.lug.a === n2.lug.b) n2.lug = null;
        }
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
// 연결 검사: 앵커에서 도달 가능한 노드 집합 (BFS). 닿지 않는 구조물은 붕괴 확정.
function computeGrounded() {
  const seen = new Set(nodes.filter(n => n.anchor || n.fixed));
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const b of beams) { if (b.broken) continue; add(b.a, b.b); add(b.b, b.a); }
  const q = [...seen];
  while (q.length) {
    const n = q.pop();
    for (const m of (adj.get(n) || [])) if (!seen.has(m)) { seen.add(m); q.push(m); }
  }
  return seen;
}
// 받침 있는 도로는 휨·처짐으로 안 끊어짐 — 밑의 목재·철강이 먼저 끊기고 나서야 따라 끊김 (원작 원칙).
function roadSupported(b) {
  if (b.a.fixed || b.a.anchor || b.b.fixed || b.b.anchor) return true;
  for (const x of beams) {
    if (x.broken || x === b) continue;
    if (x.mat === 'road' || x.mat === 'rroad' || x.mat === 'cable' || x.mat === 'rope') continue;
    if (x.a === b.a || x.b === b.a || x.a === b.b || x.b === b.b) return true;
  }
  return false;
}
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
    nodes: nodes.map(n => ({ x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10, fixed: n.fixed, anchor: n.anchor,
      lug: n.lug ? { a: idx.get(n.lug.a.id), b: idx.get(n.lug.b.id), len: Math.round(n.lug.len * 10) / 10 } : undefined })),
    beams: beams.map(b => ({ a: idx.get(b.a.id), b: idx.get(b.b.id), mat: b.mat })),
  });
}
function deserialize(json) {
  const d = JSON.parse(json);
  nodes = []; beams = []; nodeSeq = 1; beamSeq = 1;
  for (const n of d.nodes) { const nd = addNode(n.x, n.y, n.fixed, n.anchor); }
  for (const b of d.beams) {
    if (nodes[b.a] && nodes[b.b] && !beamExists(nodes[b.a], nodes[b.b], b.mat))
      beams.push({ id: beamSeq++, a: nodes[b.a], b: nodes[b.b], mat: b.mat, rest: Math.hypot(nodes[b.a].x - nodes[b.b].x, nodes[b.a].y - nodes[b.b].y), broken: false, strain: 0 });
  }
  // 러그 복원 (유압 칼라점)
  d.nodes.forEach((n, i) => {
    if (n.lug && nodes[n.lug.a] && nodes[n.lug.b] && nodes[i]) {
      nodes[i].lug = { a: nodes[n.lug.a], b: nodes[n.lug.b], len: n.lug.len };
    }
  });
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
  // 원리: 끝점은 앵커 공유로 하중을 절벽에 직접 전달. 주행면 일치는 충돌 반경 쪽에서 맞춤.
  const segs = Math.max(1, Math.round((L.right - L.left) / 40));
  let prev = null;
  for (let i = 0; i <= segs; i++) {
    const xx = L.left + (L.right - L.left) * i / segs;
    const key = xx + ',' + L.roadY;
    let n = amap.get(key);
    if (!n) n = addNode(xx, L.roadY, false, false);
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
      ox: s * (spec.w / 2 - 18), oy: spec.h / 2 + 8,
      x: sx + s * (spec.w / 2 - 18), y: sy + spec.h / 2 + 8,
      vx: 0, vy: 0, r: spec.wheelR, m: 2.2 * m, spin: 0, contact: false, ct: -9,
    })),
    // 짧고 단단한 서스펜션 (리지드 액슬에 근접 — 출렁임·데드존 없음)
    // D는 sqrt 스케일 (명시적 오일러 안정 한계 D·dt/m < 2 준수)
    restLen: 6, K: 4000 * spec.mass * m / 10, D: 140 * Math.sqrt(spec.mass * m / 10), contactT: 0, airT: 0,
  };
  dispatched = true; stuckTimer = 0; flipTimer = 0; goalTimer = 0; loseTimer = 0;
  stuckX = sx; stuckT = simTime;
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
  // 작용-반작용: 바퀴가 밀려난 반대 방향으로 빔을 민다 (빔이 차를 들어올리면 안 됨)
  pushBeamNodes2(beam.a, beam.b, t, ix, iy, posK, velK);
}
function pushBeamNodes2(P, Q, t, ix, iy, posK, velK) {
  // 노드/가상점 공용 위치 보정 (질량 가중, 고정 무시)
  const wP = P.fixed ? 0 : 1 / (P.mass || P.m || 1);
  const wQ = Q.fixed ? 0 : 1 / (Q.mass || Q.m || 1);
  const wa = 1 - t, wb = t;
  const tot = wa * (P.fixed ? 0 : 1) + wb * (Q.fixed ? 0 : 1) || 1;
  if (!P.fixed) { P.x -= ix * wa * posK / tot * 2; P.px += ix * wa * velK / tot * FIXED_DT * 60 * 0.02; P.py += iy * wa * velK / tot * FIXED_DT * 60 * 0.02; }
  if (!Q.fixed) { Q.x -= ix * wb * posK / tot * 2; Q.px += ix * wb * velK / tot * FIXED_DT * 60 * 0.02; Q.py += iy * wb * velK / tot * FIXED_DT * 60 * 0.02; }
  if (!P.fixed) P.y -= iy * wa * posK / tot * 2;
  if (!Q.fixed) Q.y -= iy * wb * posK / tot * 2;
}
// 스프링 가상 중점: 휘어짐 자유도 (Hooke 축 + 휨 복원 + 댐핑). 저장 안 됨(유도됨).
function springMidMass(b) { return Math.max(0.5, MATERIALS.spring.wpp * b.rest * 0.5); }
function ensureSpringMid(b, reset) {
  if (!b.mid) b.mid = { x: 0, y: 0, px: 0, py: 0, fx: 0, fy: 0, m: 1, mass: 1 };
  if (reset) {
    b.mid.x = (b.a.x + b.b.x) / 2; b.mid.y = (b.a.y + b.b.y) / 2;
    b.mid.px = b.mid.x; b.mid.py = b.mid.y; b.mid.fx = 0; b.mid.fy = 0;
  }
  b.mid.m = springMidMass(b); b.mid.mass = b.mid.m;
}
function syncSpringMids() { for (const b of beams) if (b.mat === 'spring' && !b.broken) ensureSpringMid(b, true); }
function springLink(P, Q, L, k) {
  // Hooke 축 스프링 (verlet 위치 투영)
  const dx = Q.x - P.x, dy = Q.y - P.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const diff = (d - L) / d * k;
  const wP = P.fixed ? 0 : 1 / (P.mass || P.m || 1);
  const wQ = Q.fixed ? 0 : 1 / (Q.mass || Q.m || 1);
  const tot = wP + wQ; if (!tot) return;
  P.x += dx * diff * (wP / tot); P.y += dy * diff * (wP / tot);
  Q.x -= dx * diff * (wQ / tot); Q.y -= dy * diff * (wQ / tot);
}
function stepSpringMids(dt) {
  for (const b of beams) {
    if (b.broken || b.mat !== 'spring') continue;
    ensureSpringMid(b, false);
    const m = b.mid;
    const vx = (m.x - m.px) * 0.97, vy = (m.y - m.py) * 0.97; // 댐핑
    m.px = m.x; m.py = m.y;
    m.x += vx + (m.fx / m.m) * dt * dt;
    m.y += vy + (GRAV + m.fy / m.m) * dt * dt;
    m.fx = 0; m.fy = 0;
  }
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
      // 정지 접촉: 작은 침투 속 제거 + 구름 마찰 (미세 진동은 무시 — 채터링 방지)
      const vn = vx * c.nx + vy * c.ny;
      if (vn < -5 && vn > -80) { vx -= c.nx * vn; vy -= c.ny * vn; }
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
    // 차량 바퀴는 도로 윗면(시각적 표면)에 맞춤: 두께 절반+반지름-3.5 → 절벽면과 1px 내로 일치 (진입턱 제거).
    // 타이어가 3.5px 묻히는 건 서스펜션 스쿼트로 보임. 섀시·화물은 정확한 접촉 유지.
    const isWheel = (mode === 'car' && r > 10);
    const th = M.thick / 2 + r * (isWheel && b.mat === 'road' ? 1 : 0.9) - (isWheel && b.mat === 'road' ? 3.5 : 0);
    // 스프링은 휘어진 두 토막과 각각 충돌 (실제 접촉면)
    const parts = (b.mat === 'spring' && b.mid) ?
      [{ x1: b.a.x, y1: b.a.y, x2: b.mid.x, y2: b.mid.y, P: b.a, Q: b.mid, off: 0 },
       { x1: b.mid.x, y1: b.mid.y, x2: b.b.x, y2: b.b.y, P: b.mid, Q: b.b, off: 0.5 }] :
      [{ x1: b.a.x, y1: b.a.y, x2: b.b.x, y2: b.b.y, P: b.a, Q: b.b, off: 0, full: true }];
    let bc = null;
    for (const sg of parts) {
      const s = { x1: sg.x1, y1: sg.y1, x2: sg.x2, y2: sg.y2 };
      let c = circleSeg(x, y, th, s);
      // 고정단 캡 축소: 교대에 묻힌 도로 끝단은 주행선 아래로 가라앉혀 볼라드 방지
      if (mode === 'car' && b.mat === 'road' && sg.full && (c.t <= 0.03 || c.t >= 0.97)) {
        const en = c.t <= 0.03 ? b.a : b.b;
        if (en.fixed) c = circleSeg(x, y, M.thick / 2 + r - 8, s);
      }
      if (!bc || c.pen > bc.pen) bc = { pen: c.pen, t: c.t, nx: c.nx, ny: c.ny, P: sg.P, Q: sg.Q, off: sg.off || 0, full: !!sg.full };
    }
    const bt = bc.full ? bc.t : (bc.off + bc.t * 0.5);
    if (bc.pen > 0) {
      const px = bc.nx * bc.pen, py = bc.ny * bc.pen;
      x += px; y += py;
      const vn = vx * bc.nx + vy * bc.ny;
      if (vn < 0) { vx -= bc.nx * vn; vy -= bc.ny * vn; vx *= 0.99; }
      contact = true; hitBeam = b; ht = bt; hnx = bc.nx; hny = bc.ny;
      if (bc.pen > bestPen) bestPen = bc.pen;
      pushBeamNodes2(bc.P, bc.Q, bc.t, px, py, 0.22, 1.0);
    } else if (bc.pen > -SLOP) {
      const vn = vx * bc.nx + vy * bc.ny;
      if (vn < -5 && vn > -80) { vx -= bc.nx * vn; vy -= bc.ny * vn; }
      vx *= 0.999;
      contact = true; hitBeam = b; ht = bt; hnx = bc.nx; hny = bc.ny;
      if (bc.pen > bestPen) bestPen = bc.pen;
    }
  }
  if (out) { out.x = x; out.y = y; out.vx = vx; out.vy = vy; out.contact = contact; out.beam = hitBeam; out.t = ht; out.nx = hnx; out.ny = hny; out.pen = bestPen; }
  return out || { x, y, vx, vy, contact, beam: hitBeam, t: ht, nx: hnx, ny: hny, pen: bestPen };
}
// 빔에 지속 하중(무게) 전달 — verlet 노드 힘 누적 (다음 스텝 적분에 반영)
// 하중 분산 전달: 타이어 접촉 패치처럼 가장 가까운 빔 2개에 나눔.
// 하중이 노드→노드로 뚝뚝 끊기며 다리를 두드리는 덜컹거림을 없앤다.
function spreadLoad(x, y, F, roadOnly) {
  const R = 44;
  let found = [];
  for (let i = 0; i < beams.length; i++) {
    const b = beams[i];
    if (b.broken) continue;
    if (roadOnly && b.mat !== 'road') continue;
    if (!roadOnly && MATERIALS[b.mat].noCollide) continue;
    const abx = b.b.x - b.a.x, aby = b.b.y - b.a.y;
    const L2 = abx * abx + aby * aby || 1;
    let t = ((x - b.a.x) * abx + (y - b.a.y) * aby) / L2;
    t = clamp(t, 0, 1);
    const d = Math.hypot(x - (b.a.x + abx * t), y - (b.a.y + aby * t));
    if (d > R) continue;
    found.push({ b, t, w: R - d });
  }
  if (!found.length) return;
  found.sort((p, q) => q.w - p.w);
  found = found.slice(0, 3);
  const tot = found.reduce((s, e) => s + e.w, 0) || 1;
  for (const e of found) {
    pushBeamForce(e.b, e.t, F * e.w / tot);
    e.b.load = (e.b.load || 0) + F * e.w / tot; // 휨모멘트용 횡하중 누적
    if (e.b.mat === 'spring' && e.b.mid) e.b.mid.fy += F * e.w / tot * 0.35; // 처짐 심화
  }
}
function pushBeamForce(beam, t, fy) {
  if (!beam || beam.broken) return;
  const wa = beam.a.fixed ? 0 : 1 - t, wb = beam.b.fixed ? 0 : t;
  if (wa) beam.a.fy += fy * wa;
  if (wb) beam.b.fy += fy * wb;
}

// ---------- 물리 스텝 ----------
function physStep(dt) {
  simTime += dt;
  for (const b of beams) b.load = 0; // 횡하중 누적 초기화 (휨모멘트용)
  // 유압 작동: 목표 길이로 애니메이션 (원작 ±50% 위상).
  // 수축 한계는 칼라 위치 정확히 (팁이 칼라에 닿고 멈춤 — 그 이상 수축 안 됨).
  if (hydPhase !== 1.0) {
    for (const b of beams) {
      if (b.mat !== 'hyd' || b.broken || !b.rest0) continue;
      let tgt;
      if (hydPhase > 1) tgt = b.rest0 * hydPhase;
      else {
        const ln = hydLug(b);
        tgt = ln ? ln.lug.len : b.rest0 * hydPhase;
      }
      const dd = tgt - b.rest, step = 90 * dt * Math.sign(dd);
      b.rest = Math.abs(step) >= Math.abs(dd) ? tgt : b.rest + step;
    }
  }
  // 러그 하중 전달: 칼라점에 걸린 힘을 양끝으로 분배 (지레비)
  for (const n of nodes) {
    if (!n.lug || (!n.fx && !n.fy)) continue;
    const L = n.lug;
    if (!nodes.includes(L.a) || !nodes.includes(L.b)) { n.lug = null; continue; }
    const d = Math.hypot(L.b.x - L.a.x, L.b.y - L.a.y) || 1e-6;
    const f = clamp(Math.min(L.len, d * 0.95) / d, 0, 1);
    if (!L.a.fixed) { L.a.fx += n.fx * (1 - f); L.a.fy += n.fy * (1 - f); }
    if (!L.b.fixed) { L.b.fx += n.fx * f; L.b.fy += n.fy * f; }
    n.fx = 0; n.fy = 0;
  }
  // 1) 노드 적분 (Verlet) — 러그는 위치 지정식이므로 적분 제외
  for (const n of nodes) {    if (n.fixed) { n.px = n.x; n.py = n.y; continue; }
    if (n.lug) { n.px = n.x; n.py = n.y; n.fx = 0; n.fy = 0; continue; }
    const vx = (n.x - n.px) * 0.99, vy = (n.y - n.py) * 0.99;
    n.px = n.x; n.py = n.y;
    n.x += vx + (n.fx / n.mass) * dt * dt;
    n.y += vy + (GRAV + n.fy / n.mass) * dt * dt;
    n.fx = 0; n.fy = 0;
  }
  // 2) 스프링 가상중점 적분 (Hooke/휨/댐핑) + 차량 서스펜션
  stepSpringMids(dt);
  if (car) stepCar(dt);
  // 3) 강체 화물
  for (const b of bodies) stepBody(b, dt);
  // 4) constraint 반복
  for (let it = 0; it < ITER; it++) {
    for (const b of beams) {
      if (b.broken) continue;
      if (b.mat === 'spring') continue; // 아래 서브세그먼트 처리
      const M = MATERIALS[b.mat];
      let dx = b.b.x - b.a.x, dy = b.b.y - b.a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      if (M.tensionOnly && d <= b.rest) continue;   // 인장 전용 (로프·케이블은 늘어남만 저항)
      const diff = (d - b.rest) / d * M.stiff * (1 - 0.65 * (b.dmg || 0));
      const wa = b.a.fixed ? 0 : 1 / b.a.mass, wb = b.b.fixed ? 0 : 1 / b.b.mass;
      const tot = wa + wb; if (!tot) continue;
      const ox = dx * diff, oy = dy * diff;
      b.a.x += ox * (wa / tot); b.a.y += oy * (wa / tot);
      b.b.x -= ox * (wb / tot); b.b.y -= oy * (wb / tot);
    }
    // 스프링 서브세그먼트: Hooke 축 2연 + 휨 복원 (중점을 현으로 복귀)
    for (const b of beams) {
      if (b.broken || b.mat !== 'spring') continue;
      ensureSpringMid(b, false);
      const m = b.mid, M = MATERIALS.spring;
      const st = M.stiff * (1 - 0.65 * (b.dmg || 0));
      springLink(b.a, m, b.rest / 2, st);
      springLink(m, b.b, b.rest / 2, st);
      const mx = (b.a.x + b.b.x) / 2, my = (b.a.y + b.b.y) / 2;
      m.x += (mx - m.x) * 0.015; m.y += (my - m.y) * 0.015;
    }
    // 노드 지형 충돌 (절벽 위)
    for (const n of nodes) {
      if (n.fixed) continue;
      collideNodeTerrain(n);
    }
    // 차량/화물 충돌: 위치 보정은 2회, 하중(힘) 전달은 스텝당 1회 (중복 가중·채터링 방지)
    if (it === 0 || it === 15) {
      const couple = (it === 0);
      if (car) collideCar(couple);
      for (const b of bodies) collideBody(b, couple);
    }
    // 유압 러그 시팅: 칼라점을 몸통 위치에 고정 (꺾임 원천 차단 — 통짜 유지)
    for (const n of nodes) {
      if (!n.lug || n.fixed) continue;
      const L = n.lug;
      if (!nodes.includes(L.a) || !nodes.includes(L.b)) { n.lug = null; continue; }
      const p = lugPoint(L);
      n.x = p.x; n.y = p.y; n.px = p.x; n.py = p.y;
    }
  }
  // 4b) 화물-차량 양방향 충돌 (CCD + 충격량 교환 — 스텝당 1회)
  if (car) for (const b of bodies) if (b.kind === 'ball') collideBallCar(b);
  // 5) 파단 판정 + 변형률 기록
  let mx = 0;
  for (const b of beams) {
    if (b.broken) continue;
    // 스프링은 호 길이(휘어짐 포함)로 변형률 측정
    const d = (b.mat === 'spring' && b.mid) ?
      (Math.hypot(b.mid.x - b.a.x, b.mid.y - b.a.y) + Math.hypot(b.b.x - b.mid.x, b.b.y - b.mid.y)) : beamLen(b);
    const strain = (d - b.rest) / b.rest;
    b.strain = strain;
    const M = MATERIALS[b.mat];
    const bonus = reinfOf(b); // 보강도로 합체 보너스
    const { limT, limC } = beamLimits(b, strain);
    const a = Math.abs(strain);
    if (a > mx) mx = a;
    // 점진 파괴 (무너짐): 항복 초과분이 데미지로 누적 → 강성 저하 → 파단. 극한만 즉시 파단.
    const ylim = Math.abs(strain > 0 ? limT : limC);
    const over = (a - ylim * M.yieldR) / ylim;
    if (a > ylim * 2.5) {
      breakBeam(b, 'snap'); continue;
    }
    if (over > 0) {
      b.dmg = Math.min(1.2, (b.dmg || 0) + over * over * 6 * dt);
      if (b.dmg >= 1) { breakBeam(b, 'fatigue'); continue; }
    }
    // 소성 (영구 변형): 항복 초과분만큼 rest가 영구히 변함 — 붕괴 전 징조(처짐)로 보임.
    // rest가 늘면 변형률이 완화되어 자기 제한됨 (진행하면 파단, 버티면 안정화).
    const yT = limT * M.yieldR, yC = limC * M.yieldR;
    if (strain > yT || strain < yC) {
      b.yielded = true;
      const r0 = b.rest0 || b.rest;
      const over = strain > 0 ? (strain - yT) : (strain - yC);
      const cap = strain > 0 ? 0.08 : -0.05;
      const cur = (b.rest - r0) / r0;
      if ((cap > 0 && cur < cap) || (cap < 0 && cur > cap)) {
        b.rest += over * b.rest * 0.1;
        const now = (b.rest - r0) / r0;
        if (cap > 0 && now > cap) b.rest = r0 * (1 + cap);
        if (cap < 0 && now < cap) b.rest = r0 * (1 + cap);
      }
    }
    // 휨모멘트 파단 (보 이론 M∝wL²): 긴 도로는 짧은 구간으로 나누거나 받쳐야 한다.
    // 40px+경차 ≈ 0.8M / 80px+경차 ≈ 4.8M / 120px+경차 ≈ 14M → 한계 12M (강화도로 1.67배)
    // 점진 누적이라 휨이 먼저 보이고 나서 부러짐 (팡 아님).
    // 단, 받침 있는 도로는 면제 (밑 구조가 먼저 끊김 — 도로 단독 파단 금지).
    if ((b.mat === 'road' || b.mat === 'rroad') && !roadSupported(b)) {
      const wTrans = (b.load || 0) + M.wpp * b.rest * GRAV;
      const moment = wTrans * b.rest * b.rest / 8;
      const cap = 12e6 * (b.mat === 'rroad' ? 1.67 : bonus);
      const rel = moment / cap - 1;
      if (rel > 2) { breakBeam(b, 'snap'); continue; }
      if (rel > 0) {
        b.dmg = Math.min(1.2, (b.dmg || 0) + rel * rel * 30 * dt);
        if (b.dmg >= 1) { breakBeam(b, 'fatigue'); continue; }
      }
    }
  }
  if (mx > maxStrainSeen) maxStrainSeen = mx;
  // 도로 처짐 파단 (보 공학 원칙): 받침 없는 데크는 해먹처럼 주저앉으며 파괴.
  // 국소 꺾임이 아니라 '건설 위치 대비 처짐'으로 판단 — 정상 트러스의 탄성 처짐과 맨도로 붕괴를 구분.
  // 한계는 경간의 5% (긴 레벨일수록 허용 처짐 증가). 점진 누적이라 처지다가 끊어짐.
  const sagLim = (LV().right - LV().left) / 20;
  for (const n of nodes) {
    if (n.fixed || n.anchor || n.y0 === undefined) continue;
    // 받침 없는 도로만 대상 (받침 있으면 밑 구조가 먼저 — 도로 단독 파단 금지)
    const rb = beams.filter(b => !b.broken && (b.mat === 'road' || b.mat === 'rroad') && (b.a === n || b.b === n) && !roadSupported(b));
    if (!rb.length) continue;
    const loaded = rb.some(b => Math.abs(b.strain) > 0.01);
    const sag = n.y - n.y0;
    if (loaded && sag > sagLim * 2) {
      let victim = rb[0];
      for (const b of rb) if (Math.abs(b.strain) > Math.abs(victim.strain)) victim = b;
      breakBeam(victim, 'snap');
    } else if (loaded && sag > sagLim) {
      let victim = rb[0];
      for (const b of rb) if (Math.abs(b.strain) > Math.abs(victim.strain)) victim = b;
      const rel = sag / sagLim - 1;
      victim.dmg = Math.min(1.2, (victim.dmg || 0) + rel * rel * 8 * dt);
      if (victim.dmg >= 1) breakBeam(victim, 'fatigue');
    }
  }
  if (car) checkCarOutcome(dt);
  stepDebris(dt);
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
    if (dist > car.restLen + 7) F += (dist - car.restLen - 7) * 3000;
    if (dist < car.restLen - 5) F -= (car.restLen - 5 - dist) * 3000;
    const fx = nx * F, fy = ny * F;
    // 휠
    wh.vx -= fx / wh.m * dt; wh.vy -= fy / wh.m * dt;
    // 섀시 (힘 + 토크)
    car.vx += fx / car.m * dt; car.vy += fy / car.m * dt;
    car.va += (rx * fy - ry * fx) / car.I * dt;
  }
  // 구동 모터 (질량 비례 — 무거운 차도 동일 가속)
  // 힐 어시스트: 기어오름·처짐 구간에서 저속이면 최대 2.5배 출력 (탈출용, 고속에선 정상).
  // 차체 전진 방향으로 구동 (오르막 감속·내리막 가속이 자연 발생).
  const grip = 1 + clamp((60 - car.vx) / 60, 0, 1) * 1.5;
  const drive = 650 * car.m * (car.spec.accel || 1) * clamp(1 - car.vx / car.spec.top, 0, 1) * grip;
  const fxm = Math.cos(car.a), fym = Math.sin(car.a);
  for (const wh of car.wheels) {
    // 접촉 유예: 미세 바운스로 접촉이 깜빡여도 0.12초간 구동 유지 (고속 덜컹거림 방지)
    if (simTime - (wh.ct === undefined ? -9 : wh.ct) < 0.12) {
      car.vx += drive * 0.5 / car.m * dt * fxm;
      car.vy += drive * 0.5 / car.m * dt * fym;
      wh.vx += drive * 0.5 / wh.m * dt * 0.15 * fxm;
      wh.vy += drive * 0.5 / wh.m * dt * 0.15 * fym;
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
    // 바퀴 속도 거버너 (강한 충격 후 수치 발산 방지 — 정상 주행 영역 밖에서만 동작)
    if (wh.vx > 800) wh.vx = 800; else if (wh.vx < -800) wh.vx = -800;
    if (wh.vy > 800) wh.vy = 800; else if (wh.vy < -800) wh.vy = -800;
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
      wh.ct = simTime;
      anyContact = true;
      car.contactT = simTime;
      wh.spin += car.vx * 0.004;
      wh.vx *= 0.998; // 구름 저항
      // 바퀴 하중을 노면에 분산 전달 (접촉 패치 — 스텝당 1회, 덜컹거림 방지)
      if (couple) spreadLoad(wh.x, wh.y, (wh.m + car.m * 0.25) * GRAV, true);
    }
    void wasAir;
  }
  // 섀시 4모서리 충돌 (박스 근사) — 3px 이상 깊이 박힐 때만 반응 (스침 무시)
  const hw = car.w / 2, hh = car.h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  let hits = 0;
  for (const [lx, ly] of corners) {
    const p = chassisPoint(lx, ly);
    collideCircleWorld(p.x, p.y, car.vx, car.vy, 7, car.m / 4, tmp, 'car');
    const dx = tmp.x - p.x, dy = tmp.y - p.y;
    if (dx * dx + dy * dy > 9) {
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
  if (hits >= 2) { car.vx *= 0.985; car.va *= 0.94; }
  // 접지 자세: 노면 경사를 따라가는 물리적 복원 토크 (바퀴 높이차 → 차체 회전).
  // 양쪽 접지 시 노면 기울기 목표, 한쪽만 닿으면 약한 수평 복원, 공중은 자유 회전.
  if (anyContact) {
    const wR = car.wheels[0], wF = car.wheels[1];
    let target = 0, w = 0.3;
    if (wR.contact && wF.contact) {
      target = Math.atan2(wF.y - wR.y, wF.x - wR.x); w = 1;
    } else if (wR.contact || wF.contact) {
      target = 0; w = 0.4;
    }
    let da = target - car.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    car.va += da * 12 * FIXED_DT * w;
    car.va *= 0.90; car.vx *= 0.999;
  }
  if (car.va > 6) car.va = 6;
  if (car.va < -6) car.va = -6;
}
// 강체-차량 접촉 충격량: 점(px,py)이 속도(pv)로 반지름 r·질량 mObj로 차에 부딪힘.
// 차(바퀴+섀시)에 반대 충격량을 즉시 적용하고, 물체 측 충격량 {jx,jy} 반환.
// 법선은 차→물체 방향. 빠른 물체도 놓치지 않게 호출 측에서 서브스텝.
function carContactImpulse(px, py, pvx, pvy, r, mObj) {
  if (!car) return null;
  const e = 0.25;
  let best = null;
  for (const wh of car.wheels) { // 1) 바퀴 (원-원)
    const dx = px - wh.x, dy = py - wh.y;
    const rr = r + wh.r;
    const d = Math.hypot(dx, dy);
    if (d < rr) {
      const pen = rr - d;
      const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : -1;
      if (!best || pen > best.pen) best = { kind: 0, wh, pen, nx, ny };
    }
  }
  { // 2) 섀시 OBB
    const c = Math.cos(car.a), s = Math.sin(car.a);
    const dx = px - car.x, dy = py - car.y;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const qx = clamp(lx, -car.w / 2, car.w / 2), qy = clamp(ly, -car.h / 2, car.h / 2);
    const wx = car.x + qx * c - qy * s, wy = car.y + qx * s + qy * c;
    const nx = px - wx, ny = py - wy;
    const d = Math.hypot(nx, ny);
    if (d < r) {
      const pen = r - d;
      let nnx, nny;
      if (d > 1e-6) { nnx = nx / d; nny = ny / d; }
      else {
        const dxs = car.w / 2 - Math.abs(lx), dys = car.h / 2 - Math.abs(ly);
        if (dxs < dys) { const sx = lx >= 0 ? 1 : -1; nnx = sx * c; nny = sx * s; }
        else { const sy = ly >= 0 ? 1 : -1; nnx = -sy * s; nny = sy * c; }
      }
      if (!best || pen > best.pen) best = { kind: 1, pen, nx: nnx, ny: nny, wx, wy };
    }
  }
  if (!best) return null;
  if (best.kind === 0) {
    const wh = best.wh;
    const mEff = wh.m + car.m * 0.25;
    const vn = (pvx - wh.vx) * best.nx + (pvy - wh.vy) * best.ny;
    if (vn >= 0) return null;
    let j = -(1 + e) * vn / (1 / mObj + 1 / mEff);
    j = clamp(j, -40000, 40000); // 수치 안정 가드 (정상 충격의 수 배)
    if (!isFinite(j)) return null;
    const jx = best.nx * j, jy = best.ny * j;
    wh.vx += jx / mEff; wh.vy += jy / mEff;
    const shx = jx * 0.25, shy = jy * 0.25;
    car.vx += shx / car.m; car.vy += shy / car.m;
    const rwx = wh.x - car.x, rwy = wh.y - car.y;
    car.va += (rwx * shy - rwy * shx) / car.I;
    return { jx: -jx, jy: -jy, nx: best.nx, ny: best.ny, pen: best.pen, vn };
  }
  const rx = best.wx - car.x, ry = best.wy - car.y;
  const hpx = car.vx - car.va * ry, hpy = car.vy + car.va * rx;
  const vn = (pvx - hpx) * best.nx + (pvy - hpy) * best.ny;
  if (vn >= 0) return null;
  const rn = rx * best.ny - ry * best.nx;
  let j = -(1 + e) * vn / (1 / mObj + 1 / car.m + (rn * rn) / car.I);
  j = clamp(j, -40000, 40000); // 수치 안정 가드
  if (!isFinite(j)) return null;
  const jx = best.nx * j, jy = best.ny * j;
  car.vx += jx / car.m; car.vy += jy / car.m;
  car.va += (rx * jy - ry * jx) / car.I;
  return { jx: -jx, jy: -jy, nx: best.nx, ny: best.ny, pen: best.pen, vn };
}
// 공 vs 차량 (서브스텝 CCD + 양방향 충격량 — 빠른 공도 관통 없음)
function collideBallCar(b) {
  const speed = Math.hypot(b.vx - car.vx, b.vy - car.vy);
  const n = Math.min(8, Math.max(1, Math.ceil(speed * FIXED_DT / ((b.r + 10) * 0.4))));
  const sdt = FIXED_DT / n;
  for (let k = 0; k < n; k++) {
    b.x += b.vx * sdt; b.y += b.vy * sdt;
    const hit = carContactImpulse(b.x, b.y, b.vx, b.vy, b.r, b.m);
    if (hit) {
      b.x += hit.nx * hit.pen; b.y += hit.ny * hit.pen;
      b.vx += hit.jx / b.m; b.vy += hit.jy / b.m;
      if (-hit.vn > 300) shake = Math.min(14, shake + 2);
    }
  }
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
  // 정체 (속도 기준)
  if (simTime > 4 && speed < 14 && car.x < goalX() - 20) stuckTimer += dt; else stuckTimer = 0;
  if (stuckTimer > 5) return lose('⏱ 정체!', '차량이 멈췄습니다. 다리가 휘었거나 끊어졌나요?');
  // 갇힘 (위치 기준 — 진동하며 제자리인 경우도 감지)
  if (simTime - stuckT > 3) {
    if (Math.abs(car.x - stuckX) < 25) return lose('⏱ 정체!', '차량이 끼었습니다. 노면 단차나 처짐을 확인하세요.');
    stuckX = car.x; stuckT = simTime;
  }
  if (simTime > 60) return lose('⏱ 시간 초과!', '60초 안에 건너지 못했습니다.');
}
function win() {
  result = 'win';
  const usage = LV().free ? 0 : simCost / LV().budget;
  let stars = (brokenCount === 0 ? 1 : 0) + (usage < 0.8 ? 1 : 0) + (simTime < 25 ? 1 : 0);
  if (simOverBudget) stars = Math.min(stars, 2);
  sndWin();
  confetti();
  showOverlay(true, '🎉 레벨 클리어!', LV().desc, [
    ['⏱ 시간', simTime.toFixed(1) + 's'],
    ['💰 비용', fmt$(simCost)],
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
  if (b.kind === 'ball') {
    // 고속 터널링 방지 CCD: 이동거리 기준 서브스텝으로 빔·지형과 충돌 (놓침 없음)
    const speed = Math.hypot(b.vx, b.vy);
    const n = Math.min(10, Math.max(1, Math.ceil(speed * dt / (b.r * 0.4))));
    const sdt = dt / n;
    const tmp = {};
    for (let k = 0; k < n; k++) {
      b.vy += GRAV * sdt;
      b.x += b.vx * sdt; b.y += b.vy * sdt;
      collideCircleWorld(b.x, b.y, b.vx, b.vy, b.r, b.m, tmp, 'cargo');
      b.x = tmp.x; b.y = tmp.y;
      b.vx = tmp.vx * 0.98; b.vy = tmp.vy * (tmp.contact && tmp.vy > 0 ? -0.25 : 1);
      if (k === n - 1) {
        if (tmp.contact) spreadLoad(b.x, b.y, b.m * GRAV, false);
        if (tmp.contact && Math.abs(b.vy) > 150) burst(b.x, b.y + b.r, '#cfd8e6', 6);
      }
    }
    b.vx *= 0.999;
    ballWater(b);
    return;
  }
  b.vy += GRAV * dt;
  b.vx *= 0.999; b.va *= 0.99;
  b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.va * dt;
}
function ballWater(b) {
  const L = LV();
  if (b.y > L.waterY && inGap(b.x)) {
    b.vx *= 0.96; b.vy = b.vy * 0.94 - 30 * FIXED_DT * 10;
    b.va *= 0.95;
    if (Math.random() < 0.1) particles.push({ x: b.x, y: L.waterY, vx: (Math.random() - .5) * 50, vy: -60, life: .5, t: 0, c: '#4fc3f7', r: 2 });
  }
}
function collideBody(b, couple) {
  const tmp = {};
  if (b.kind === 'ball') return; // 공은 stepBody 서브스텝 CCD에서 처리
  {
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
      // 상자 모서리 vs 자동차 (양방향 충격 — 스텝당 1회)
      if (car && couple) {
        const hit = carContactImpulse(px, py, pvx, pvy, 4, b.m);
        if (hit) {
          b.x += hit.nx * hit.pen * 0.6; b.y += hit.ny * hit.pen * 0.6;
          b.vx += hit.jx / b.m; b.vy += hit.jy / b.m;
          b.va += (rx * hit.jy - ry * hit.jx) / I;
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
// 부재 한계 (보강 보너스 + 오일러 좌굴 반영 — 세장한 압축재는 조기 좌굴)
function beamLimits(b, strain) {
  const M = MATERIALS[b.mat];
  const bonus = reinfOf(b);
  let limT = M.breakT * bonus, limC = M.breakC * bonus;
  if (strain < 0 && M.breakC > -10 && M.buckLen) {
    limC *= Math.min(1, (M.buckLen / b.rest) ** 2);
  }
  return { limT, limC };
}
function breakBeam(b, cause) {
  if (b.broken) return;
  b.broken = true; b.strain = 0; brokenCount++;
  spawnDebris(b);
  burst((b.a.x + b.b.x) / 2, (b.a.y + b.b.y) / 2, MATERIALS[b.mat].color,
    (b.mat === 'road' || b.mat === 'rroad' ? 4 : 0) + (cause === 'snap' ? 18 : 10));
  shake = Math.min(14, shake + (cause === 'snap' ? 5 : 3));
  breakFlash = 0.45;
  sndBreak();
}
// 파단 잔해: 끊어진 빔의 양쪽 반토막이 각 노드에 매달려 흔들림 + 무게로 연쇄 붕괴 유발
function spawnDebris(b) {
  if (debris.length > 60) debris.splice(0, debris.length - 60);
  const mx = (b.a.x + b.b.x) / 2, my = (b.a.y + b.b.y) / 2;
  for (const N of [b.a, b.b]) {
    const dx = mx - N.x, dy = my - N.y, dd = Math.hypot(dx, dy) || 1;
    const L = Math.max(4, dd / 2), ux = dx / dd, uy = dy / dd;
    const mkP = (k) => ({ x: N.x + ux * L * k, y: N.y + uy * L * k, px: N.x + ux * L * k, py: N.y + uy * L * k });
    debris.push({
      pin: N, p1: mkP(1), p2: mkP(2), l1: L, l2: L, mat: b.mat,
      m: MATERIALS[b.mat].wpp * b.rest * 0.25,
    });
  }
}
function stepDebris(dt) {
  const L = LV();
  for (const d of debris) {
    for (const p of [d.p1, d.p2]) {
      const vx = (p.x - p.px) * 0.99, vy = (p.y - p.py) * 0.99;
      p.px = p.x; p.py = p.y; p.x += vx; p.y += vy + GRAV * dt * dt;
      if (p.y > L.waterY) { p.px = (p.px + p.x) / 2; p.py = (p.py + p.y) / 2; }
    }
    for (let k = 0; k < 4; k++) {
      for (const [A, Bp, Ll, pin] of [[d.pin, d.p1, d.l1, true], [d.p1, d.p2, d.l2, false]]) {
        const ddx = Bp.x - A.x, ddy = Bp.y - A.y;
        const dist = Math.hypot(ddx, ddy) || 1e-6;
        const diff = (dist - Ll) / dist;
        if (pin) { Bp.x -= ddx * diff; Bp.y -= ddy * diff; }
        else { const ox = ddx * diff * 0.5, oy = ddy * diff * 0.5; A.x += ox; A.y += oy; Bp.x -= ox; Bp.y -= oy; }
      }
    }
    if (!d.pin.fixed) d.pin.fy += d.m * GRAV;
  }
}
function drawDebris() {
  ctx.lineCap = 'round';
  for (const d of debris) {
    const M = MATERIALS[d.mat] || MATERIALS.wood;
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = M.thick * 0.8 + 2;
    ctx.beginPath(); ctx.moveTo(d.pin.x, d.pin.y); ctx.lineTo(d.p1.x, d.p1.y); ctx.lineTo(d.p2.x, d.p2.y); ctx.stroke();
    ctx.strokeStyle = M.color;
    ctx.lineWidth = M.thick * 0.8;
    ctx.beginPath(); ctx.moveTo(d.pin.x, d.pin.y); ctx.lineTo(d.p1.x, d.p1.y); ctx.lineTo(d.p2.x, d.p2.y); ctx.stroke();
  }
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
  view = { s, cw, ch };
  clampCam();
}
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
  const es = effS();
  ctx.translate(view.cw / 2, view.ch / 2); ctx.scale(es, es); ctx.translate(-cam.cx, -cam.cy);
  if (shake > 0.2) ctx.translate((Math.random() - .5) * shake / es, (Math.random() - .5) * shake / es);

  drawSky(); drawTerrain(L); drawWater(L);
  if (mode === 'build' && showGrid) drawGrid();
  drawAnchors(); drawBeams(); drawDebris(); drawNodes(); drawBodies(); drawCar(); drawFlag(L);
  drawParticles(); drawPreview();
  if (mode === 'build') drawUngrounded();
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
  // 구름 (넓은 화면 커버)
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  cloudT += 0.0016;
  for (let i = 0; i < 8; i++) {
    const cx = ((i * 700 + cloudT * 4000) % (W + 3000)) - 1500, cy = 60 + (i % 5) * 36;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 70, 20, 0, 0, 7); ctx.ellipse(cx + 40, cy + 6, 50, 16, 0, 0, 7); ctx.ellipse(cx - 45, cy + 8, 44, 14, 0, 0, 7);
    ctx.fill();
  }
  // 먼 산 (줌아웃까지 커버)
  ctx.fillStyle = '#1b2f4b';
  ctx.beginPath(); ctx.moveTo(-3000, 420);
  for (let x = -3000; x <= W + 3000; x += 80) ctx.lineTo(x, 330 + Math.sin(x * 0.008 + 2) * 40 + (Math.abs(x) % 160 === 0 ? -30 : 0));
  ctx.lineTo(W + 3000, H + 3000); ctx.lineTo(-3000, H + 3000); ctx.fill();
}
function drawTerrain(L) {
  // 절벽 본체 (줌아웃까지 이어짐 — 빈칸 없음)
  ctx.fillStyle = '#2c2118';
  ctx.fillRect(-3000, L.roadY, L.left + 3000, H + 3000 - L.roadY);
  ctx.fillRect(L.right, L.roadY, W + 3000 - L.right, H + 3000 - L.roadY);
  // 절벽 질감
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let i = 0; i < 80; i++) {
    const x = -1500 + (i * 97) % (W + 3000), y = L.roadY + 20 + (i * 53) % Math.max(60, (H - L.roadY - 30));
    if (x < L.left || x > L.right) ctx.fillRect(x, y, 26, 5);
  }
  if (L.island) {
    ctx.fillStyle = '#2c2118';
    ctx.fillRect(L.island.x, L.island.top, L.island.w, H + 3000 - L.island.top);
  }
  // 절벽 모서리 모따기 콘크리트 (둥근 교대)
  ctx.fillStyle = '#78909c';
  ctx.beginPath();
  ctx.moveTo(L.left, L.roadY); ctx.lineTo(L.left + 18, L.roadY); ctx.lineTo(L.left + 18, L.roadY + 5);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(L.right, L.roadY); ctx.lineTo(L.right - 18, L.roadY); ctx.lineTo(L.right - 18, L.roadY + 5);
  ctx.closePath(); ctx.fill();
  // 잔디 윗면
  ctx.fillStyle = '#43a047';
  ctx.fillRect(0, L.roadY - 8, L.left + 2, 10);
  ctx.fillRect(L.right - 2, L.roadY - 8, W - L.right + 2, 10);
  if (L.island) ctx.fillRect(L.island.x, L.island.top - 8, L.island.w, 10);
  ctx.fillStyle = '#66bb6a';
  ctx.fillRect(0, L.roadY - 8, L.left + 2, 3);
  ctx.fillRect(L.right - 2, L.roadY - 8, W - L.right + 2, 3);
  if (L.island) ctx.fillRect(L.island.x, L.island.top - 8, L.island.w, 3);
  // 출발/도착 도로 연장선 (도로 윗면과 일치)
  ctx.fillStyle = '#333945';
  ctx.fillRect(0, L.roadY - 6, L.left, 6);
  ctx.fillRect(L.right, L.roadY - 6, W - L.right, 6);
}
function drawWater(L) {
  const t = timeSec;
  const wg = ctx.createLinearGradient(0, L.waterY, 0, H);
  wg.addColorStop(0, 'rgba(41,121,189,.92)'); wg.addColorStop(1, 'rgba(13,43,77,.95)');
  ctx.fillStyle = wg;
  ctx.beginPath(); ctx.moveTo(L.left, H + 3000); ctx.lineTo(L.left, L.waterY);
  for (let x = L.left; x <= L.right; x += 16) ctx.lineTo(x, L.waterY + Math.sin(x * 0.05 + t * 2.4) * 5);
  ctx.lineTo(L.right, H + 3000); ctx.fill();
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
function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
// 빔 최종 색 (응력 + 항복 틴트 — 소성한 부재는 노랗게)
function beamColor(b) {
  const boost = b.mat === 'road' ? reinfOf(b) : 1;
  let col = stressColor(b.mat, b.strain, boost);
  if (b.yielded && mode === 'sim') {
    let r, g, bl;
    if (col[0] === '#') [r, g, bl] = hexRgb(col);
    else [r, g, bl] = col.slice(4, -1).split(',').map(Number);
    r = Math.round(r + (255 - r) * 0.45); g = Math.round(g + (213 - g) * 0.45); bl = Math.round(bl + (79 - bl) * 0.45);
    col = `rgb(${r},${g},${bl})`;
  }
  return col;
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
// 유압 위상 토글 (원작 Hydraulic Controller 간소판: 전체 동시 신장/수축)
function toggleHyd() {
  if (mode !== 'sim') return;
  hydPhase = hydPhase === 1.5 ? 0.5 : 1.5;
  updateHydUI(); sndClick();
  toast(hydPhase === 1.5 ? '🔧 유압 신장! (+50%)' : '🔧 유압 수축! (칼라까지)');
}
function updateHydUI() {
  const el = $('hydState');
  if (el) el.textContent = hydPhase === 1.0 ? '중립' : hydPhase > 1 ? '신장' : '수축';
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
      ctx.strokeStyle = beamColor(b); ctx.lineWidth = M.thick;
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
    } else if (b.mat === 'cable' || b.mat === 'rope') {
      ctx.strokeStyle = beamColor(b); ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
    } else if (b.mat === 'spring') {
      // 스프링 코일 (가상 중점을 경유 — 휘어짐이 그대로 보임)
      const mid = b.mid || { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 };
      const drawCoil = (x1, y1, x2, y2) => {
        const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1;
        const nx = -dy / d, ny = dx / d, coils = 3, amp = 5;
        for (let i = 0; i <= coils * 2; i++) {
          const t = i / (coils * 2), off = (i % 2 === 0) ? 0 : amp;
          const px = x1 + dx * t + nx * off, py = y1 + dy * t + ny * off;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
      };
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = M.thick + 2;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(mid.x, mid.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.strokeStyle = beamColor(b); ctx.lineWidth = M.thick;
      ctx.beginPath();
      drawCoil(b.a.x, b.a.y, mid.x, mid.y);
      drawCoil(mid.x, mid.y, b.b.x, b.b.y);
      ctx.stroke();
    } else if (b.mat === 'hyd') {
      // 유압 피스톤 통짜 1개: 실린더(밑동→칼라) + 로드(칼라→팁) + 주황 부착 3점
      const ln = hydLug(b);
      const base = ln ? ln.lug.a : b.a;
      const tip = (ln && base === b.a) || !ln ? b.b : b.a;
      const cx = ln ? ln.x : b.a.x + (b.b.x - b.a.x) * BARREL_FRAC;
      const cy = ln ? ln.y : b.a.y + (b.b.y - b.a.y) * BARREL_FRAC;
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = M.thick + 3;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.strokeStyle = '#b25c00'; ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.strokeStyle = '#eceff1'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      // 주황 부착 3점 (양끝 + 칼라)
      for (const [px, py] of [[base.x, base.y], [cx, cy], [tip.x, tip.y]]) {
        ctx.fillStyle = '#ff8f00';
        ctx.beginPath(); ctx.arc(px, py, 6.5, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff3e0';
        ctx.beginPath(); ctx.arc(px, py, 2.5, 0, 7); ctx.fill();
      }
    } else if (b.mat === 'rroad') {
      // 강화도로: 두꺼운 노면에 주황 보강 테두리 + 이중 중앙선
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = M.thick + 3;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.strokeStyle = beamColor(b); ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      const rdx = b.b.x - b.a.x, rdy = b.b.y - b.a.y, rd = Math.hypot(rdx, rdy) || 1;
      const rnx = -rdy / rd * (M.thick / 2 - 1), rny = rdx / rd * (M.thick / 2 - 1);
      ctx.strokeStyle = '#ff8f00'; ctx.lineWidth = 2.5;
      for (const sgn of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(b.a.x + rnx * sgn, b.a.y + rny * sgn);
        ctx.lineTo(b.b.x + rnx * sgn, b.b.y + rny * sgn);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,213,79,.9)'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(b.a.x + rnx * 0.25, b.a.y + rny * 0.25); ctx.lineTo(b.b.x + rnx * 0.25, b.b.y + rny * 0.25);
      ctx.moveTo(b.a.x - rnx * 0.25, b.a.y - rny * 0.25); ctx.lineTo(b.b.x - rnx * 0.25, b.b.y - rny * 0.25);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = M.thick + 2;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      ctx.strokeStyle = beamColor(b); ctx.lineWidth = M.thick;
      ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      if (b.mat === 'wood') {
        ctx.strokeStyle = 'rgba(90,55,20,.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
      }
    }
    // 과부하 발광
    if (mode === 'sim' && showStress && Math.abs(b.strain) > 0.05) {
      const { limT, limC } = beamLimits(b, b.strain);
      const lim = b.strain > 0 ? limT : (Math.abs(limC) > 10 ? limT : Math.abs(limC));
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
// 미연결 구조 빨간 표시 (건설 모드) — 앵커에 닿지 않으면 주행 시 확정 붕괴
function drawUngrounded() {
  const g = computeGrounded();
  let any = false;
  for (const b of beams) if (!g.has(b.a) || !g.has(b.b)) { any = true; break; }
  if (!any) {
    for (const n of nodes) if (!n.anchor && !n.fixed && !g.has(n) && beams.some(x => x.a === n || x.b === n)) { any = true; break; }
  }
  if (!any) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(244,67,54,.9)'; ctx.lineWidth = 3; ctx.setLineDash([7, 5]);
  for (const b of beams) {
    if (g.has(b.a) && g.has(b.b)) continue;
    ctx.beginPath(); ctx.moveTo(b.a.x, b.a.y); ctx.lineTo(b.b.x, b.b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(244,67,54,.95)';
  for (const n of nodes) {
    if (n.anchor || g.has(n)) continue;
    ctx.beginPath(); ctx.arc(n.x, n.y, 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('!', n.x, n.y + 3);
    ctx.fillStyle = 'rgba(244,67,54,.95)';
  }
  ctx.restore();
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
  const L = LV(), cost = mode === 'sim' ? simCost : totalCost();
  if (L.free) {
    $('budgetText').textContent = fmt$(cost) + ' / ∞ FREE';
    const f = $('budgetFill');
    f.style.width = '100%';
    f.style.background = 'var(--steel)';
  } else {
    $('budgetText').textContent = fmt$(cost) + ' / ' + fmt$(L.budget);
    const pct = clamp(cost / L.budget * 100, 0, 100);
    const f = $('budgetFill');
    f.style.width = pct + '%';
    f.style.background = pct < 70 ? 'var(--acc)' : pct <= 100 ? 'var(--warn)' : 'var(--bad)';
  }
  $('maxStrain').textContent = mode === 'sim' ? (maxStrainSeen * 100).toFixed(1) + '%' : '—';
  $('btnBuild').classList.toggle('active', mode === 'build');
  $('btnSim').classList.toggle('hidden', mode !== 'build');
  $('btnStop').classList.toggle('hidden', mode !== 'sim');
  document.querySelectorAll('#palette .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.style.cursor = tool === 'erase' ? 'not-allowed' : tool === 'move' ? 'move' : 'crosshair';
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
  // 원작처럼 예산 초과분도 관대하게: 120%까지 테스트 허용 (초과 시 ★ 감점). 자유 모드는 무제한.
  if (!LV().free && totalCost() > LV().budget * 1.2 + 1e-6) { toast('⚠️ 예산 20% 초과! 빔을 줄이거나 싼 자재로 바꾸세요'); sndFail(); return; }
  const overBudget = !LV().free && totalCost() > LV().budget + 1e-6;
  const roadExists = beams.some(b => b.mat === 'road' && !b.broken);
  if (!roadExists) { toast('⚠️ 도로(Road) 상판이 없어요! 1번 자재로 길을 놓으세요'); sndFail(); return; }
  const _g = computeGrounded();
  const loose = beams.some(b => !_g.has(b.a) || !_g.has(b.b));
  pushUndoSoft();
  buildSnap = serialize();
  simCost = totalCost(); // 시작 예산 고정
  saveGame(true); // 설계안 자동 저장 (새로고침/이동 후에도 복원)
  mode = 'sim'; result = null; simTime = 0; dispatched = false;
  maxStrainSeen = 0; brokenCount = 0; bodies = []; car = null; particles = [];
  for (const n of nodes) { n.px = n.x; n.py = n.y; n.fx = 0; n.fy = 0; n.y0 = n.y; }
  for (const b of beams) { b.broken = false; b.strain = 0; b.rest0 = b.rest; b.yielded = false; b.dmg = 0; if (b.mat === 'spring') ensureSpringMid(b, true); }
  debris = []; hydPhase = 1.0; updateHydUI();
  for (const b of beams) { b.broken = false; b.strain = 0; }
  refreshMasses();
  hideOverlay(); sndClick();
  simOverBudget = overBudget;
  let h = defaultHint();
  if (loose) h = '⚠️ 빨간 점선(미연결)부터 무너집니다! ' + h;
  else if (simOverBudget) h = '⚠️ 예산 초과 (★ 감점) · ' + h;
  $('hint').textContent = h;
}
function exitSim() {
  if (mode === 'build') return;
  mode = 'build'; car = null; bodies = []; particles = []; debris = []; result = null;
  if (buildSnap) deserialize(buildSnap);
  hideOverlay(); sndClick();
  $('hint').textContent = defaultHint();
}
let softPushed = false;
function pushUndoSoft() { softPushed = true; }

// ---------- 레벨 전환 ----------
function setLevel(i, keepBridge) {
  // 시뮬 중 레벨 이동 시 먼저 원복 → 잔해가 저장되는 것 방지
  if (mode === 'sim') exitSim();
  // 이전 레벨 자동 저장
  try { if (nodes.length && beams.length) localStorage.setItem('pbw_level_' + levelIndex, serialize()); } catch (e) {}
  levelIndex = clamp(i, 0, LEVELS.length - 1);
  const sel = $('levelSelect');
  sel.value = String(levelIndex);
  carType = LV().car;
  undoStack = []; redoStack = [];
  mode = 'build'; car = null; bodies = []; particles = []; debris = []; result = null; buildSnap = null;
  hideOverlay();
  const saved = keepBridge ? localStorage.getItem(saveKey()) : null;
  if (saved) { try { deserialize(saved); } catch (e) { defaultBridge(); } }
  else if (!loadGame(true)) defaultBridge();
  refreshCarList();
  fitCamera();
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
const pts = new Map(); // 활성 포인터 (핀치 줌용)
let pinch0 = null, panning = false, lastPX = 0, lastPY = 0;
function panBy(dsx, dsy) {
  const s = effS();
  cam.cx -= dsx / s; cam.cy -= dsy / s;
  clampCam(); updateZoomUI();
}
function applyPinch() {
  const arr = [...pts.values()];
  if (arr.length < 2 || !pinch0 || pinch0.d < 5) return;
  const d = Math.hypot(arr[0].sx - arr[1].sx, arr[0].sy - arr[1].sy);
  const mx = (arr[0].sx + arr[1].sx) / 2, my = (arr[0].sy + arr[1].sy) / 2;
  cam.cx = pinch0.cx; cam.cy = pinch0.cy; cam.z = pinch0.z;
  zoomAt(pinch0.mx, pinch0.my, d / pinch0.d);
  const s = effS();
  cam.cx -= (mx - pinch0.mx) / s;
  cam.cy -= (my - pinch0.my) / s;
  clampCam(); updateZoomUI();
}
canvas.addEventListener('pointerdown', e => {
  audio();
  canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  const p = evPos(e);
  pts.set(e.pointerId, { sx: p.sx, sy: p.sy });
  if (pts.size === 2) { // 핀치 시작 — 건설 제스처 취소
    const arr = [...pts.values()];
    pinch0 = { d: Math.hypot(arr[0].sx - arr[1].sx, arr[0].sy - arr[1].sy), mx: (arr[0].sx + arr[1].sx) / 2, my: (arr[0].sy + arr[1].sy) / 2, cx: cam.cx, cy: cam.cy, z: cam.z };
    mouse.down = false; mouse.rdown = false; mouse.startNode = null; mouse.dragNode = null; panning = false;
    return;
  }
  if (tool === 'pan') setTool('build'); // 팬 도구 제거됨 — 위치는 슬라이더로
  if (e.button === 1) { // 가운데 버튼 팬
    e.preventDefault(); panning = true; lastPX = p.sx; lastPY = p.sy;
    mouse.down = false; mouse.startNode = null; mouse.dragNode = null;
    return;
  }
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
    // 러그점(유압 칼라)은 빔을 따라 자동 이동하므로 직접 이동 불가
    mouse.dragNode = (n && !n.fixed && !n.lug) ? n : null;
    if (mouse.dragNode) pushUndo();
  } else if (tool === 'erase') {
    eraseAt(p.wx, p.wy);
  }
});
canvas.addEventListener('pointermove', e => {
  const p = evPos(e);
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { sx: p.sx, sy: p.sy });
  if (pts.size >= 2) { applyPinch(); mouse.sx = p.sx; mouse.sy = p.sy; return; }
  if (panning) {
    panBy(p.sx - lastPX, p.sy - lastPY);
    lastPX = p.sx; lastPY = p.sy;
    mouse.sx = p.sx; mouse.sy = p.sy;
    return;
  }
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
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch0 = null;
  if (panning && pts.size === 0) panning = false;
  if (e.target !== canvas && e.type === 'pointerup') { /* 팔레트 클릭 등 */ }
  if (!mouse.down && !mouse.rdown) return;
  mouse.down = false; mouse.rdown = false;
  if (mode !== 'build') { mouse.startNode = null; mouse.dragNode = null; return; }
  if (tool === 'build' && mouse.startNode && mouse.cur && e.button !== 2) {
    const a = mouse.startNode, b = mouse.cur;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 4) tryBuild(a, b);
  }
  if (mouse.dragNode) { weldNodes(); refreshMasses(); updateHUD(); autosaveSoon(); }
  mouse.startNode = null; mouse.dragNode = null;
});
canvas.addEventListener('pointercancel', e => {
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch0 = null;
  if (pts.size === 0) panning = false;
  mouse.down = false; mouse.rdown = false; mouse.startNode = null; mouse.dragNode = null;
});
canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
}, { passive: false });
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
  pushUndo();
  let na = a.node, nb = b.node;
  let freshA = false, freshB = false;
  if (!na) { na = addNode(clamp(a.x, 0, W), clamp(a.y, 0, H), false, false); freshA = true; }
  if (!nb) { nb = addNode(clamp(b.x, 0, W), clamp(b.y, 0, H), false, false); freshB = true; }
  // 롤백: 이번 드래그의 모든 변경(노드 생성·분할 포함)을 스냅샷으로 원복
  const rollback = () => {
    const snap = undoStack.pop();
    if (snap) deserialize(snap);
    refreshMasses(); updateHUD();
  };
  if (na === nb) { rollback(); return; }
  // 새 노드가 기존 빔 위면 분할 → 구조 일체화 (유압은 분할하지 않고 통째로 유지)
  if (freshA) splitBeamAt(na);
  if (freshB) splitBeamAt(nb);
  // 유압 통짜 1개 + 칼라 러그점: 양끝+중간 3점이 빨간 부착점.
  // 중간점은 칼라 위치(A에서 62%, 몸통 고정)에 진짜 조인트로 생성 — 여기에 자재 부착.
  // 분할 없음 (유압 빔은 절대 안 잘림).
  if (curMat === 'hyd') {
    const total = Math.hypot(na.x - nb.x, na.y - nb.y);
    if (total < 40) { toast('유압은 최소 40px 필요해요'); rollback(); return; }
    if (total > M.maxLen + 0.5) { toast('너무 길어요! 유압 최대 ' + M.maxLen + 'px'); sndFail(); rollback(); return; }
    if (beamExists(na, nb, 'hyd')) { rollback(); return; }
    const hb = { id: beamSeq++, a: na, b: nb, mat: 'hyd', rest: total, broken: false, strain: 0 };
    beams.push(hb);
    const mx = na.x + (nb.x - na.x) * BARREL_FRAC, my = na.y + (nb.y - na.y) * BARREL_FRAC;
    let mid = findNodeAt(mx, my, 12);
    if (mid === na || mid === nb) mid = null;
    if (mid && (mid.fixed || mid.anchor)) mid = null;
    if (mid && beams.some(x => x.a === mid || x.b === mid)) mid = null; // 이미 연결된 점은 건드리지 않음
    if (!mid) {
      mid = addNode(mx, my, false, false);
      mid.lug = { a: na, b: nb, len: total * BARREL_FRAC };
    } else {
      mid.lug = { a: na, b: nb, len: Math.hypot(mid.x - na.x, mid.y - na.y) };
    }
    weldNodes();
    refreshMasses(); updateHUD(); sndClick(); autosaveSoon();
    return;
  }
  // 중간 부착: 드래그 경로상의 기존 조인트에서 자동 분할.
  // 길이 검증은 전체가 아니라 토막별로 → 중간에 붙이면 자재 최대길이를 넘겨도 됨.
  const abx = nb.x - na.x, aby = nb.y - na.y;
  const L2 = abx * abx + aby * aby || 1;
  const pts = [];
  for (const n of nodes) {
    if (n === na || n === nb) continue;
    const t = ((n.x - na.x) * abx + (n.y - na.y) * aby) / L2;
    if (t < 0.03 || t > 0.97) continue;
    const d = Math.hypot(n.x - (na.x + abx * t), n.y - (na.y + aby * t));
    if (d > 6) continue;
    pts.push({ n, t });
  }
  pts.sort((p, q) => p.t - q.t);
  const chain = [na, ...pts.map(p => p.n), nb];
  const segLens = [];
  for (let i = 0; i < chain.length - 1; i++) segLens.push(Math.hypot(chain[i].x - chain[i + 1].x, chain[i].y - chain[i + 1].y));
  if (chain.length > 2) {
    const bad = segLens.findIndex(l => l < M.minLen - 0.5 || l > M.maxLen + 0.5);
    if (bad >= 0) {
      const l = segLens[bad];
      toast(l < M.minLen ? '중간 조인트 간격이 너무 좁아요 (≥' + M.minLen + 'px)' : '토막이 너무 길어요! ' + M.name + ' 최대 ' + M.maxLen + 'px');
      sndFail(); rollback(); return;
    }
    let made = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      if (!beamExists(chain[i], chain[i + 1], curMat)) {
        beams.push({ id: beamSeq++, a: chain[i], b: chain[i + 1], mat: curMat, rest: segLens[i], broken: false, strain: 0 });
        made++;
      }
    }
    if (!made) { rollback(); return; }
  } else {
    const len = segLens[0];
    if (len < M.minLen) { toast('너무 짧아요 (≥' + M.minLen + 'px)'); rollback(); return; }
    if (len > M.maxLen) { toast('너무 길어요! ' + M.name + ' 최대 ' + M.maxLen + 'px'); sndFail(); rollback(); return; }
    if (beamExists(na, nb, curMat)) { rollback(); return; }
    beams.push({ id: beamSeq++, a: na, b: nb, mat: curMat, rest: len, broken: false, strain: 0 });
  }
  weldNodes();
  refreshMasses(); updateHUD(); sndClick(); autosaveSoon();
}
// 편집 후 자동 저장 (3초 쓰로틀 — 새로고침해도 설계 유지)
function autosaveSoon() {
  const t = Date.now();
  if (t - (autosaveSoon._l || 0) < 3000) return;
  autosaveSoon._l = t;
  try { if (mode === 'build' && nodes.length) localStorage.setItem(saveKey(), serialize()); } catch (e) {}
}
function eraseAt(wx, wy, soft) {
  let bd = 14, target = null;
  for (const b of beams) { const d = distToBeam(wx, wy, b); if (d < bd) { bd = d; target = b; } }
  if (target) {
    if (!soft) pushUndo();
    beams = beams.filter(x => x !== target);
    pruneNodes(); refreshMasses(); updateHUD(); autosaveSoon();
    return;
  }
  const n = findNodeAt(wx, wy, 18);
  if (n && !n.fixed && !n.anchor) {
    if (!soft) pushUndo();
    beams = beams.filter(x => x.a !== n && x.b !== n);
    nodes = nodes.filter(x => x !== n);
    pruneNodes(); // 고아 러그점 등 정리
    refreshMasses(); updateHUD(); autosaveSoon();
  }
}
function pruneNodes() {
  // 피스톤이 사라진 러그점은 일반점으로 (유압 빔이 있어야 유지)
  for (const n of nodes) {
    if (n.lug) {
      const L = n.lug;
      const alive = beams.some(b => !b.broken && b.mat === 'hyd' &&
        ((b.a === L.a && b.b === L.b) || (b.a === L.b && b.b === L.a)));
      if (!alive) n.lug = null;
    }
  }
  nodes = nodes.filter(n => n.fixed || n.anchor || n.lug || beams.some(b => b.a === n || b.b === n));
}

// ---------- 키보드 ----------
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (k === ' ') { e.preventDefault(); mode === 'build' ? enterSim() : exitSim(); }
  else if (k >= '1' && k <= '8' && +k <= MAT_ORDER.length) setMat(MAT_ORDER[+k - 1]);
  else if (k === 'b') setTool('build');
  else if (k === 'e') setTool('erase');
  else if (k === 'm') setTool('move');
  else if (k === 'd' && mode === 'sim' && !car) spawnCar();
  else if (k === 'h') toggleHyd();
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
    o.value = String(i); o.textContent = L.name + ' · ' + (L.free ? '∞' : fmt$(L.budget));
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
  $('btnHyd').onclick = () => toggleHyd();
  $('zoomIn').onclick = () => zoomAt(view.cw / 2, view.ch / 2, 1.25);
  $('zoomOut').onclick = () => zoomAt(view.cw / 2, view.ch / 2, 1 / 1.25);
  $('zoomFit').onclick = () => fitCamera();
  $('zoomSlider').oninput = e => { cam.z = +e.target.value / 100; clampCam(); updateZoomUI(); };
  $('panX').oninput = () => panSliderTo();
  $('panY').oninput = () => panSliderTo();
  $('btnUndo').onclick = doUndo; $('btnRedo').onclick = doRedo;
  $('btnClear').onclick = () => {
    if (mode !== 'build' || !confirm('앵커를 제외한 다리를 모두 지울까요?')) return;
    pushUndo();
    beams = []; pruneNodes(); refreshMasses(); updateHUD(); autosaveSoon();
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
        if (M.tensionOnly && d <= b.rest) continue;
        const diff = (d - b.rest) / d * M.stiff * (1 - 0.65 * (b.dmg || 0));
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
    const zq = parseFloat(params.get('zoom'));
    if (zq > 0) { cam.z = zq; clampCam(); updateZoomUI(); }
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
