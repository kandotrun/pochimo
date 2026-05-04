const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const burstStatusEl = document.getElementById('burstStatus');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const intervalSec = document.getElementById('intervalSec');
const recordBadge = document.getElementById('recordBadge');

const MOTION_CHECK_MS = 1000;
const BURST_INTERVAL_MS = 1000;
const BURST_DURATION_MS = 30000;
const MOTION_THRESHOLD = 12;

let scheduler = null;
let lastSample = null;
let count = 0;
let nextSaveAt = 0;
let burstUntil = 0;
let sending = false;

function setStatus(text) { statusEl.textContent = text; }
function setBurstStatus(text) { burstStatusEl.textContent = text; }

function setRecording(active) {
  recordBadge.textContent = active ? '記録中' : '停止中';
  recordBadge.classList.toggle('recording', active);
  recordBadge.classList.toggle('idle', !active);
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}

function captureFrame() {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 64;
  sampleCanvas.height = 36;
  const sampleCtx = sampleCanvas.getContext('2d');
  sampleCtx.drawImage(video, 0, 0, 64, 36);
  const data = sampleCtx.getImageData(0, 0, 64, 36).data;
  let motionScore = 0;
  if (lastSample) {
    let diff = 0;
    for (let i = 0; i < data.length; i += 4) {
      diff += Math.abs(data[i] - lastSample[i]);
      diff += Math.abs(data[i + 1] - lastSample[i + 1]);
      diff += Math.abs(data[i + 2] - lastSample[i + 2]);
    }
    motionScore = Math.round(diff / (64 * 36 * 3));
  }
  lastSample = new Uint8ClampedArray(data);

  return { image: canvas.toDataURL('image/jpeg', 0.72), motionScore };
}

async function postFrame(payload) {
  const res = await fetch('/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'capture failed');
  count = json.count;
}

async function captureTick() {
  if (sending || video.readyState < 2) return;

  const now = Date.now();
  const payload = captureFrame();
  const normalIntervalMs = Number(intervalSec.value) * 1000;

  if (payload.motionScore >= MOTION_THRESHOLD) {
    burstUntil = Math.max(burstUntil, now + BURST_DURATION_MS);
  }

  const inBurst = now < burstUntil;
  const saveIntervalMs = inBurst ? BURST_INTERVAL_MS : normalIntervalMs;
  const shouldSave = now >= nextSaveAt;

  setBurstStatus(inBurst
    ? `動きあり: バースト撮影中（motion=${payload.motionScore}）`
    : `待機中: 動きが大きい時に1秒バーストします（motion=${payload.motionScore}）`);

  if (!shouldSave) return;

  sending = true;
  nextSaveAt = now + saveIntervalMs;
  try {
    await postFrame(payload);
    setStatus(inBurst ? `${count}枚記録しました（バースト）` : `${count}枚記録しました`);
  } catch (err) {
    setStatus(`エラー: ${err.message}`);
  } finally {
    sending = false;
  }
}

startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    await startCamera();
    setRecording(true);
    nextSaveAt = 0;
    burstUntil = 0;
    await captureTick();
    scheduler = setInterval(captureTick, MOTION_CHECK_MS);
    stopBtn.disabled = false;
    setStatus('記録中です。iPadは画面をつけたままにしてください。');
  } catch (err) {
    startBtn.disabled = false;
    setRecording(false);
    setStatus(`開始失敗: ${err.message}`);
  }
});

stopBtn.addEventListener('click', () => {
  clearInterval(scheduler);
  scheduler = null;
  nextSaveAt = 0;
  burstUntil = 0;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setRecording(false);
  setStatus('停止しました');
  setBurstStatus('動きが大きい時は自動で1秒バースト撮影します。');
});
