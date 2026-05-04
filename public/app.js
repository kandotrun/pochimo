const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const reportBtn = document.getElementById('reportBtn');
const reportEl = document.getElementById('report');
const intervalSec = document.getElementById('intervalSec');
const recordBadge = document.getElementById('recordBadge');
const statFrames = document.getElementById('statFrames');
const statActive = document.getElementById('statActive');
const statPet = document.getElementById('statPet');
const timelineEl = document.getElementById('timeline');

let timer = null;
let lastSample = null;
let count = 0;
let latestEvents = [];

function setStatus(text) { statusEl.textContent = text; }

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
  setStatus(`${count}枚記録しました`);
  await refreshTimeline();
}

async function refreshTimeline() {
  const res = await fetch('/api/events');
  latestEvents = await res.json();
  renderStats(latestEvents);
  renderTimeline(latestEvents);
}

function renderStats(events, ai) {
  const active = events.filter(event => Number(event.motionScore) >= 8).length;
  statFrames.textContent = String(events.length);
  statActive.textContent = String(active);
  if (ai) {
    statPet.textContent = ai.petVisible === true ? '見えた' : ai.petVisible === false ? '未確認' : '不明';
  }
}

function renderTimeline(events, observations = []) {
  if (!events.length) {
    timelineEl.className = 'timeline empty';
    timelineEl.textContent = 'まだ記録がありません。撮影開始するとここに並びます。';
    return;
  }

  timelineEl.className = 'timeline';
  const obsByIndex = new Map(observations.map(item => [item.index, item]));
  timelineEl.innerHTML = events.map((event, index) => {
    const motion = Number(event.motionScore || 0);
    const level = motion >= 50 ? 'high' : motion >= 8 ? 'mid' : 'low';
    const label = motion >= 50 ? '大きな動き' : motion >= 8 ? '動きあり' : '静か';
    const observation = event.ai || obsByIndex.get(index);
    const title = event.timelineText
      || (observation?.petVisible === true
        ? observation.petActivity || 'ペットが写っています'
        : observation?.scene || (event.aiStatus === 'analyzing' ? '内容を確認中...' : '写真を保存しました'));
    const pet = observation
      ? observation.petVisible === true ? 'ペットが見えます' : observation.petVisible === false ? 'ペットは見えません' : '確認中'
      : event.aiStatus === 'analyzing' ? '確認中' : '保存しました';
    const detail = observation?.scene || '写真を保存しました';

    return `
      <article class="timeline-item">
        <time class="timeline-time">${escapeHtml(formatEventTime(event.time))}</time>
        <span class="timeline-dot ${level}"></span>
        <div class="timeline-body">
          <p class="timeline-title">${escapeHtml(title)}</p>
          <p class="timeline-meta">${escapeHtml(pet)} ・ ${escapeHtml(detail)}</p>
        </div>
      </article>`;
  }).join('');
}

function formatEventTime(time) {
  return String(time || '').slice(11, 19).replaceAll('-', ':').slice(0, 5);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    await startCamera();
    setRecording(true);
    await sendFrame();
    timer = setInterval(() => sendFrame().catch(err => setStatus(`エラー: ${err.message}`)), Number(intervalSec.value) * 1000);
    stopBtn.disabled = false;
    setStatus('記録中です。iPadは画面をつけたままにしてください。');
  } catch (err) {
    startBtn.disabled = false;
    setRecording(false);
    setStatus(`開始失敗: ${err.message}`);
  }
});

stopBtn.addEventListener('click', () => {
  clearInterval(timer);
  timer = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setRecording(false);
  setStatus('停止しました');
});

refreshBtn.addEventListener('click', refreshTimeline);

reportBtn.addEventListener('click', async () => {
  reportBtn.disabled = true;
  reportEl.classList.remove('report-placeholder');
  reportEl.textContent = '今日の様子をまとめています...';
  try {
    const res = await fetch('/api/report');
    const json = await res.json();
    const report = json.report || json;
    const markdown = json.markdown || JSON.stringify(json, null, 2);
    reportEl.textContent = markdown;
    renderStats(latestEvents, report.ai);
    renderTimeline(latestEvents, report.ai?.frameObservations || []);
  } catch (err) {
    reportEl.textContent = `日報生成失敗: ${err.message}`;
  } finally {
    reportBtn.disabled = false;
  }
});

(async function init() {
  await refreshTimeline().catch(() => {});
})();
