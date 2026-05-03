const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const reportBtn = document.getElementById('reportBtn');
const reportEl = document.getElementById('report');
const intervalSec = document.getElementById('intervalSec');

let timer = null;
let lastSample = null;
let count = 0;

function setStatus(text) { statusEl.textContent = text; }

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

async function sendFrame() {
  const payload = captureFrame();
  const res = await fetch('/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'capture failed');
  count = json.count;
  setStatus(`保存済み: ${count}枚 / motion=${payload.motionScore}`);
}

startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    await startCamera();
    await sendFrame();
    timer = setInterval(() => sendFrame().catch(err => setStatus(`エラー: ${err.message}`)), Number(intervalSec.value) * 1000);
    stopBtn.disabled = false;
    setStatus('撮影中');
  } catch (err) {
    startBtn.disabled = false;
    setStatus(`開始失敗: ${err.message}`);
  }
});

stopBtn.addEventListener('click', () => {
  clearInterval(timer);
  timer = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('停止しました');
});

reportBtn.addEventListener('click', async () => {
  reportEl.textContent = '生成中... Ollama画像解析は少し時間がかかります';
  const res = await fetch('/api/report');
  const json = await res.json();
  reportEl.textContent = json.markdown || JSON.stringify(json, null, 2);
});
