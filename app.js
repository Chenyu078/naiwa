import { FilesetResolver, HandLandmarker, FaceLandmarker } from "./vendor/vision_bundle.js";

const CDN = "https://cdn.jsdelivr.net";
const WASM_DIRS = [
  CDN + "/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  "./vendor/wasm",
];
const MODEL_HAND_URLS = [
  CDN + "/gh/Chenyu078/naiwa@main/vendor/models/hand_landmarker.task",
  "./vendor/models/hand_landmarker.task",
];
const MODEL_FACE_URLS = [
  CDN + "/gh/Chenyu078/naiwa@main/vendor/models/face_landmarker.task",
  "./vendor/models/face_landmarker.task",
];

const $ = id => document.getElementById(id);

/* ================= 素材与映射 ================= */
const MEMES = [1,2,3,4,5,6,7,8,9,10,11,12,13].map(n => `jpg/${String(n).padStart(2,'0')}.jpg`);

// 手势 → 图片序号（1 起）
const HAND_MAP = {
  thumbs_up:  { img: 1,  label: '点赞' },
  fist:       { img: 2,  label: '握拳' },
  open_palm:  { img: 3,  label: '张开手掌' },
  point_up:   { img: 4,  label: '食指朝上' },
  peace:      { img: 11, label: '剪刀手' },
  rock:       { img: 6,  label: '摇滚' },
  ok:         { img: 7,  label: 'OK' },
};

// 表情 → 图片序号
const FACE_MAP = [
  { key: 'mouthOpen', th: 0.30, img: 13, label: '张嘴' },
  { key: 'smile',     th: 0.30, img: 11, label: '微笑' },
  { key: 'eyeClose',  th: 0.45, img: 10, label: '闭眼' },
  { key: 'browUp',    th: 0.40, img: 9,  label: '挑眉' },
];

const IDLE_IMG = 8;      // 无输入时的默认图
const HOLD_MS = 600;     // 手势需保持多久
const FACE_HOLD_MS = 320; // 表情保持时间（表情停留短）
const IDLE_MS = 1400;    // 无输入多久后回默认

/* ================= 元素 ================= */
const video   = $('video');
const overlay = $('overlay');
const camWrap = $('camWrap');
const meme    = $('meme');
const camTag  = $('camTag');
const pillHand= $('pillHand');
const pillFace= $('pillFace');
const toastEl = $('toast');

let showDebug = false;
let mirror = true;
let useHand = true;
let useFace = true;

/* ================= 状态 ================= */
let currentImg = IDLE_IMG;
let pending = null;         // { key, since }
let lastHitAt = 0;
let lastText = '';

/* ================= 图片切换 ================= */
function setImage(idx, force) {
  if (!idx) return;
  if (idx === currentImg && !force) return;
  currentImg = idx;
  meme.classList.add('swap');
  const img = new Image();
  img.onload = () => {
    meme.src = img.src;
    requestAnimationFrame(() => meme.classList.remove('swap'));
  };
  img.src = MEMES[idx - 1];
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1500);
}

/* ================= 手势判定 ================= */
const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { thumb: 3, index: 6, middle: 10, ring: 14, pinky: 18 };
const MCP = { thumb: 2, index: 5, middle: 9, ring: 13, pinky: 17 };

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z||0) - (b.z||0)); }

// 手指是否伸直：指尖离手腕比 pip 离手腕更远
function fingerExtended(lm, tipIdx, pipIdx) {
  const wrist = lm[0];
  return dist(lm[tipIdx], wrist) > dist(lm[pipIdx], wrist) * 1.12;
}

function detectGesture(lm) {
  const f = {
    index: fingerExtended(lm, TIP.index, PIP.index),
    middle: fingerExtended(lm, TIP.middle, PIP.middle),
    ring: fingerExtended(lm, TIP.ring, PIP.ring),
    pinky: fingerExtended(lm, TIP.pinky, PIP.pinky),
  };
  // 拇指：以掌心为中心衡量外展程度，比单纯的指尖距离稳定
  const palm = {
    x: (lm[MCP.index].x + lm[MCP.middle].x + lm[MCP.ring].x + lm[MCP.pinky].x) / 4,
    y: (lm[MCP.index].y + lm[MCP.middle].y + lm[MCP.ring].y + lm[MCP.pinky].y) / 4,
  };
  const dTip = Math.hypot(lm[TIP.thumb].x - palm.x, lm[TIP.thumb].y - palm.y);
  const dBase = Math.hypot(lm[MCP.thumb].x - palm.x, lm[MCP.thumb].y - palm.y);
  f.thumb = dTip > dBase * 1.45;

  const cnt = [f.index, f.middle, f.ring, f.pinky].filter(Boolean).length;

  // OK：食指与拇指指尖贴近，其余三指伸开
  if (dist(lm[TIP.thumb], lm[TIP.index]) < dist(lm[MCP.index], lm[PIP.index]) * 0.75
      && f.middle && f.ring && f.pinky) return 'ok';

  // 剪刀手：食指+中指，其余收
  if (f.index && f.middle && !f.ring && !f.pinky) return 'peace';

  // 食指朝上：只有食指
  if (f.index && !f.middle && !f.ring && !f.pinky) return 'point_up';

  // 摇滚：食指+小指
  if (f.index && !f.middle && !f.ring && f.pinky) return 'rock';

  // 张开手掌：四指全伸
  if (f.index && f.middle && f.ring && f.pinky) return 'open_palm';

  // 握拳：四指全收
  if (cnt === 0 && !f.thumb) return 'fist';

  // 点赞：只竖拇指
  if (cnt === 0 && f.thumb) return 'thumbs_up';

  return null;
}

/* ================= 表情判定 ================= */
function detectFace(bs) {
  // bs: blendshape 名称 → 0~1
  const g = n => bs[n] || 0;
  const mouthOpen = (g('jawOpen') * 0.75 + g('mouthFunnel') * 0.25);
  const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
  const eyeClose = (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2;
  const browUp = (g('browInnerUp') + g('browOuterUpLeft') + g('browOuterUpRight')) / 3;
  return { mouthOpen, smile, eyeClose, browUp };
}

/* ================= 加载进度 ================= */
function setProg(text, pct) {
  const box = $('prog'), fill = $('progFill'), txt = $('progTxt');
  if (!box) return;
  box.hidden = false;
  txt.textContent = text;
  if (pct == null) { fill.style.width = '100%'; fill.classList.add('indet'); }
  else { fill.classList.remove('indet'); fill.style.width = Math.max(2, Math.min(100, pct)) + '%'; }
}

async function fetchModel(urls, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) { lastErr = new Error(label + ' ' + res.status); continue; }
      const total = Number(res.headers.get('content-length') || 0);
      if (!res.body) return new Uint8Array(await res.arrayBuffer());

      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) setProg(`下载${label} ${(got/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`, got/total*100);
        else setProg(`下载${label} ${(got/1048576).toFixed(1)} MB`, null);
      }
      if (got < 100000) throw new Error(label + ' 内容异常');
      const buf = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(label + ' 下载失败');
}

/* 探测 wasm 目录是否可用 */
async function pickWasmDir() {
  for (const dir of WASM_DIRS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(dir + '/vision_wasm_internal.js', { method: 'GET', headers: { Range: 'bytes=0-255' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return dir;
    } catch (e) { /* 试下一个 */ }
  }
  return WASM_DIRS[WASM_DIRS.length - 1];
}

/* ================= 初始化模型 ================= */
let handLandmarker = null, faceLandmarker = null;
let fileset = null, faceLoading = null, ready = false;
let faceState = 'idle';   // idle | loading | ready | error
let faceErr = '';

async function initWasm() {
  if (fileset) return fileset;
  setProg('加载识别运行库（首次约 9 MB）…', null);
  const dir = await pickWasmDir();
  fileset = await FilesetResolver.forVisionTasks(dir);
  return fileset;
}

async function initHand() {
  if (handLandmarker) return handLandmarker;
  await initWasm();
  const buf = await fetchModel(MODEL_HAND_URLS, '手势模型');
  setProg('初始化手势模型…', null);
  handLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: buf, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  }).catch(async () => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  }));
  ready = true;
  return handLandmarker;
}

async function initFace() {
  if (faceLandmarker) return faceLandmarker;
  if (faceLoading) return faceLoading;
  faceLoading = (async () => {
    await initWasm();
    const buf = await fetchModel(MODEL_FACE_URLS, '表情模型');
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: buf, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    }).catch(async () => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    }));
    faceState = 'ready';
    return faceLandmarker;
  })();
  faceState = 'loading';
  faceLoading.catch(e => { faceState = 'error'; faceErr = String(e && e.message || e).slice(0, 40); });
  return faceLoading;
}

/* ================= 摄像头 ================= */
let facingMode = 'user';
let stream = null;
let rafId = 0;
let lastVideoTime = -1;

async function startCamera() {
  if (!ready) {
    $('coverTip').textContent = '正在加载识别模型，首次约需 5–15 秒…';
  }
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 853 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    $('cover').hidden = true;
    camTag.textContent = '识别中';
    loop();
  } catch (e) {
    throw new Error('无法开启摄像头：' + (e.message || e) + '（需 HTTPS 并允许权限）');
  }
}

/* ================= 主循环 ================= */
let frameCount = 0, handMissingFrames = 0, faceMissingFrames = 0;

function loop() {
  rafId = requestAnimationFrame(loop);
  if (video.readyState < 2) return;
  const t = performance.now();
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  frameCount++;

  let gesture = null, faceB = null;

  try {
    if (useHand && handLandmarker) {
      const hr = handLandmarker.detectForVideo(video, t);
      if (hr.landmarks && hr.landmarks.length) {
        handMissingFrames = 0;
        gesture = detectGesture(hr.landmarks[0]);
        if (showDebug) drawHand(hr.landmarks[0]);
      } else {
        handMissingFrames++;
      }
    }
    if (useFace && faceLandmarker && frameCount % 2 === 0) {
      const fr = faceLandmarker.detectForVideo(video, t);
      if (fr.faceBlendshapes && fr.faceBlendshapes.length) {
        faceMissingFrames = 0;
        const cats = fr.faceBlendshapes[0].categories;
        const map = {};
        for (const c of cats) map[c.categoryName] = c.score;
        faceB = detectFace(map);
      } else {
        faceMissingFrames++;
      }
    }
  } catch (e) { /* 单帧失败忽略 */ }

  if (!showDebug) clearOverlay();

  handleInput(gesture, faceB);
  drawPills(gesture, faceB);
}

/* ================= 输入仲裁 ================= */
function handleInput(gesture, faceB) {
  const now = performance.now();
  let candidate = null;

  if (gesture && HAND_MAP[gesture]) {
    candidate = { kind: 'hand', key: gesture, img: HAND_MAP[gesture].img, text: '手势 · ' + HAND_MAP[gesture].label };
  } else if (faceB && useFace) {
    for (const f of FACE_MAP) {
      if (faceB[f.key] >= f.th) {
        candidate = { kind: 'face', key: f.key, img: f.img, text: '表情 · ' + f.label };
        break;
      }
    }
  }

  if (candidate) {
    if (!pending || pending.img !== candidate.img) {
      pending = { ...candidate, since: now };
    } else if (now - pending.since >= (pending.kind === 'face' ? FACE_HOLD_MS : HOLD_MS)) {
      setImage(pending.img);
      lastHitAt = now;
      if (pending.text !== lastText) { camTag.textContent = pending.text; lastText = pending.text; }
      pending = null;
    }
  } else {
    pending = null;
  }

  // 长时间无输入 → 回默认
  if (now - lastHitAt > IDLE_MS && currentImg !== IDLE_IMG && !pending) {
    setImage(IDLE_IMG);
    camTag.textContent = '待机';
    lastText = '';
  }
}

/* ================= 顶部标签 ================= */
let lastFaceB = null;
function drawPills(gesture, faceB) {
  if (faceB) lastFaceB = faceB;
  if (useFace && faceState === 'idle' && stream) initFace().catch(() => {});
  if (gesture && HAND_MAP[gesture]) {
    pillHand.textContent = '手势 ' + HAND_MAP[gesture].label;
    pillHand.classList.add('hit');
  } else {
    pillHand.textContent = '手势 —';
    pillHand.classList.remove('hit');
  }
  // 表情状态
  if (!useFace) {
    pillFace.textContent = '表情 已关闭';
    pillFace.classList.remove('hit');
  } else if (faceState === 'loading') {
    pillFace.textContent = '表情 模型加载中';
    pillFace.classList.remove('hit');
  } else if (faceState === 'error') {
    pillFace.textContent = '表情 模型失败';
    pillFace.classList.remove('hit');
  } else if (faceState === 'ready') {
    if (!lastFaceB) {
      pillFace.textContent = '表情 未检测到人脸';
      pillFace.classList.remove('hit');
    } else if (showDebug) {
      const b = lastFaceB;
      pillFace.textContent = `嘴${b.mouthOpen.toFixed(2)} 笑${b.smile.toFixed(2)} 闭${b.eyeClose.toFixed(2)} 眉${b.browUp.toFixed(2)}`;
      pillFace.classList.add('hit');
    } else {
      let best = null;
      for (const f of FACE_MAP) if (lastFaceB[f.key] >= f.th) { best = f; break; }
      if (best) { pillFace.textContent = '表情 ' + best.label; pillFace.classList.add('hit'); }
      else { pillFace.textContent = '表情 —'; pillFace.classList.remove('hit'); }
    }
  } else {
    pillFace.textContent = '表情 —';
  }
}

/* ================= 骨骼绘制 ================= */
function clearOverlay() {
  if (overlay._dirty) {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    overlay._dirty = false;
  }
}

const HAND_EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function drawHand(lm) {
  if (overlay.width !== video.videoWidth) {
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  overlay._dirty = true;
  const W = overlay.width, H = overlay.height;
  ctx.strokeStyle = 'rgba(242,201,76,.95)';
  ctx.lineWidth = Math.max(2, W / 220);
  for (const [a, b] of HAND_EDGES) {
    ctx.beginPath();
    ctx.moveTo(lm[a].x * W, lm[a].y * H);
    ctx.lineTo(lm[b].x * W, lm[b].y * H);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, Math.max(2, W / 260), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ================= 交互绑定 ================= */
$('startBtn').addEventListener('click', async () => {
  const btn = $('startBtn');
  btn.disabled = true;
  btn.textContent = '准备中…';
  $('coverTip').textContent = '首次需下载约 17 MB 识别资源，之后会缓存。';
  try {
    await initHand();
    setProg('请求摄像头权限…', null);
    await startCamera();
    $('prog').hidden = true;
    btn.textContent = '重新开启';
    btn.disabled = false;
    // 表情模型空闲时后台加载，不阻塞使用
    if (useFace) {
      setTimeout(() => initFace().catch(() => {}), 1200);
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    $('coverTip').textContent = '加载失败：' + msg + '。请检查网络后重试。';
    $('prog').hidden = true;
    btn.disabled = false;
    btn.textContent = '重试';
  }
});

$('demoBtn').addEventListener('click', () => {
  $('cover').hidden = true;
  camWrap.style.display = 'none';
  toast('演示模式：每分钟自动换一张');
  let i = 0;
  setInterval(() => { i = (i + 1) % MEMES.length; setImage(i + 1, true); }, 2500);
});

$('optHand').addEventListener('change', e => { useHand = e.target.checked; });
$('optFace').addEventListener('change', e => {
  useFace = e.target.checked;
  if (useFace && !faceLandmarker) {
    toast('正在加载表情模型…');
    initFace().then(() => toast('表情识别已就绪')).catch(() => toast('表情模型加载失败'));
  }
});
$('optMirror').addEventListener('change', e => {
  mirror = e.target.checked;
  camWrap.classList.toggle('mirror', mirror);
});
$('optDebug').addEventListener('change', e => {
  showDebug = e.target.checked;
  if (!showDebug) clearOverlay();
});

$('switchCam').addEventListener('click', async () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  await startCamera();
  toast(facingMode === 'user' ? '前置镜头' : '后置镜头');
});

$('shootBtn').addEventListener('click', () => {
  // 把当前表情图 + 摄像头小窗合成一张
  const W = 1080, H = 1440;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const base = new Image();
  base.onload = () => {
    // 背景铺满
    const s = Math.max(W / base.width, H / base.height);
    const bw = base.width * s, bh = base.height * s;
    ctx.drawImage(base, (W - bw) / 2, (H - bh) / 2, bw, bh);
    // 摄像头小窗
    if (stream && video.videoWidth) {
      const cw = W * 0.26, ch = cw * 4 / 3, x = W - cw - 28, y = H - ch - 28;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, cw, ch, 18);
      ctx.clip();
      ctx.translate(x + cw, y); ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, cw, ch);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(x, y, cw, ch, 18); ctx.stroke();
    }
    const a = document.createElement('a');
    a.download = `naiwa-${Date.now()}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
    toast('已保存');
  };
  base.src = MEMES[currentImg - 1];
});

pillFace.style.pointerEvents = 'auto';
pillFace.addEventListener('click', () => {
  if (!useFace) { $('optFace').checked = true; useFace = true; }
  if (faceState === 'error') { faceState = 'idle'; faceLoading = null; faceLandmarker = null; }
  if (faceState === 'idle') { toast('重新加载表情模型…'); initFace().then(() => toast('表情识别已就绪')).catch(e => toast('加载失败：' + (e.message || e))); }
});

/* ================= 图例 ================= */
(function buildLegend() {
  const box = $('legendGrid');
  const items = [];
  for (const [k, v] of Object.entries(HAND_MAP)) items.push({ img: v.img, text: '✋ ' + v.label });
  for (const f of FACE_MAP) items.push({ img: f.img, text: '🙂 ' + f.label });
  box.innerHTML = items.map(it =>
    `<div class="legend-item"><img src="${MEMES[it.img-1]}" alt=""><span>${it.text}</span></div>`
  ).join('');
})();

/* 预加载图片 */
MEMES.forEach(src => { const i = new Image(); i.src = src; });
camWrap.classList.add('mirror');
setImage(IDLE_IMG, true);

/* 页面隐藏时暂停 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(rafId); }
  else if (stream) loop();
});
