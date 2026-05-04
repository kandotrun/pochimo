const prevDayBtn = document.getElementById('prevDayBtn');
const nextDayBtn = document.getElementById('nextDayBtn');
const dateInput = document.getElementById('dateInput');
const dateDisplayBtn = document.getElementById('dateDisplayBtn');
const latestTitle = document.getElementById('latestTitle');
const pageTitle = document.getElementById('pageTitle');
const pageLead = document.getElementById('pageLead');
const petAvatar = document.getElementById('petAvatar');
const reportEl = document.getElementById('report');
const timelineEl = document.getElementById('timeline');
const latestImage = document.getElementById('latestImage');
const latestOverlay = document.getElementById('latestOverlay');
const latestEmpty = document.getElementById('latestEmpty');
const latestMeta = document.getElementById('latestMeta');

latestImage.addEventListener('load', () => applyAdaptivePhotoEnhancement(latestImage));

let latestEvents = [];
let petProfile = {};
let selectedDate = todayString();
let initialLoading = true;

async function refreshAll() {
  if (initialLoading) renderSkeletons();
  await Promise.all([refreshTimeline(), refreshLatest(), refreshReport()]);
  initialLoading = false;
}

function renderSkeletons() {
  latestImage.hidden = true;
  latestOverlay.hidden = true;
  latestOverlay.innerHTML = '';
  latestEmpty.hidden = false;
  latestEmpty.innerHTML = '<div class="skeleton skeleton-latest"></div>';
  latestMeta.innerHTML = '<div class="skeleton skeleton-line short"></div>';
  timelineEl.className = 'timeline';
  timelineEl.innerHTML = Array.from({ length: 4 }, () => `
    <article class="skeleton-timeline-item">
      <div class="skeleton skeleton-time"></div>
      <span class="skeleton skeleton-dot"></span>
      <div class="skeleton-card">
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      </div>
    </article>
  `).join('');
}

async function refreshTimeline() {
  const res = await fetch(`/api/events?date=${encodeURIComponent(selectedDate)}`);
  latestEvents = await res.json();
  renderTimeline(latestEvents);
}

async function refreshLatest() {
  latestTitle.textContent = selectedDate === todayString() ? '最新の写真' : `${formatDateLabel(selectedDate)}の写真`;
  const json = await fetch(`/api/latest?date=${encodeURIComponent(selectedDate)}`).then(res => res.json());
  if (!json.imageUrl || !json.event) {
    latestImage.hidden = true;
    resetPhotoEnhancement(latestImage);
    latestOverlay.hidden = true;
    latestOverlay.innerHTML = '';
    latestEmpty.hidden = false;
    latestMeta.textContent = `${formatDateLabel(selectedDate)}の写真はまだありません。`;
    return;
  }

  latestImage.src = `${json.imageUrl}?v=${encodeURIComponent(json.event.time)}`;
  latestImage.hidden = false;
  latestEmpty.hidden = true;
  latestMeta.textContent = `${formatEventTime(json.event.time)} に撮影`;
  renderLatestDetection(json.event);
}

function applyAdaptivePhotoEnhancement(img) {
  const brightness = estimateImageBrightness(img);
  if (brightness == null) {
    resetPhotoEnhancement(img);
    return;
  }

  const target = brightness < 0.16 ? 0.58 : brightness < 0.28 ? 0.54 : 0.48;
  const boost = clamp(target / Math.max(brightness, 0.05), 1, 3.8);
  const contrast = clamp(1.04 + (boost - 1) * 0.14, 1, 1.38);
  const saturate = clamp(1.02 + (boost - 1) * 0.08, 1, 1.24);

  img.style.setProperty('--photo-brightness', boost.toFixed(2));
  img.style.setProperty('--photo-contrast', contrast.toFixed(2));
  img.style.setProperty('--photo-saturate', saturate.toFixed(2));
}

function estimateImageBrightness(img) {
  if (!img.naturalWidth || !img.naturalHeight) return null;

  const canvas = document.createElement('canvas');
  const size = 48;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const values = [];
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha < 0.5) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    const start = Math.floor(values.length * 0.08);
    const end = Math.ceil(values.length * 0.82);
    const sample = values.slice(start, end);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  } catch {
    return null;
  }
}

function resetPhotoEnhancement(img) {
  img.style.removeProperty('--photo-brightness');
  img.style.removeProperty('--photo-contrast');
  img.style.removeProperty('--photo-saturate');
}

function renderLatestDetection(event) {
  const box = normalizePetBox(event?.ai?.petBox || event?.petBox);
  if (!box || event?.ai?.petVisible !== true) {
    latestOverlay.hidden = true;
    latestOverlay.innerHTML = '';
    return;
  }

  const label = petProfile.name?.trim() ? `${petProfile.name.trim()}はここ` : 'ここにいます';
  latestOverlay.hidden = false;
  latestOverlay.innerHTML = `
    <div class="pet-box" style="left:${box.x * 100}%;top:${box.y * 100}%;width:${box.width * 100}%;height:${box.height * 100}%">
      <span>${escapeHtml(label)}</span>
    </div>`;
}

function normalizePetBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x = clamp01(Number(box.x));
  const y = clamp01(Number(box.y));
  const width = clamp01(Number(box.width));
  const height = clamp01(Number(box.height));

  if (![x, y, width, height].every(Number.isFinite) || width <= 0.02 || height <= 0.02) return null;
  return {
    x: Math.min(x, 0.98),
    y: Math.min(y, 0.98),
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y)
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return NaN;
  return Math.max(0, Math.min(1, value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function loadPetProfile() {
  const json = await fetch('/api/profile').then(res => res.json());
  petProfile = json.profile || {};
  renderPetProfile();
}

function renderPetProfile() {
  const name = petProfile.name?.trim();
  pageTitle.textContent = name ? `${name}の今日` : '今日の様子';
  pageLead.textContent = name
    ? `${name}の最新写真と、一日の記録を確認できます。`
    : '最新の写真と、ペットの一日を確認できます。';
  if (petProfile.photo) {
    petAvatar.textContent = '';
    petAvatar.style.backgroundImage = `url(${petProfile.photo})`;
    petAvatar.classList.add('has-photo');
  } else {
    petAvatar.style.backgroundImage = '';
    petAvatar.textContent = '🐾';
    petAvatar.classList.remove('has-photo');
  }
}

function renderTimeline(events, observations = []) {
  if (!events.length) {
    timelineEl.className = 'timeline empty';
    timelineEl.textContent = 'まだ記録がありません。';
    return;
  }

  const shown = events.filter(shouldShowTimelineEvent).slice(-80).reverse();
  if (!shown.length) {
    timelineEl.className = 'timeline empty';
    timelineEl.textContent = 'まだ表示する記録はありません。ペットが写った時や気になる行動だけ表示します。';
    return;
  }
  const obsByIndex = new Map(observations.map(item => [item.index, item]));
  timelineEl.className = 'timeline';
  timelineEl.innerHTML = shown.map(event => {
    const originalIndex = events.indexOf(event);
    const motion = Number(event.motionScore || 0);
    const level = motion >= 50 ? 'high' : motion >= 8 ? 'mid' : 'low';
    const observation = event.ai || obsByIndex.get(originalIndex);
    const category = event.activityLabel || observation?.activityLabel || categoryLabel(event.activityCategory || observation?.activityCategory, observation);
    const title = event.timelineText
      || (observation?.petVisible === true
        ? `${shouldShowCategoryBadge(category) ? `${category}: ` : ''}${observation.petActivity || '写っています'}`
        : observation?.scene || (event.aiStatus === 'analyzing' ? '内容を確認中...' : '写真を保存しました'));
    const pet = observation
      ? observation.petVisible === true ? 'ペットが見えます' : observation.petVisible === false ? 'ペットは見えません' : '確認中'
      : event.aiStatus === 'analyzing' ? '確認中' : '保存しました';
    const detail = observation?.scene || '写真を保存しました';

    const badge = shouldShowCategoryBadge(category)
      ? `<span class="category-badge">${escapeHtml(category)}</span>`
      : '';

    return `
      <article class="timeline-item">
        <time class="timeline-time">${escapeHtml(formatEventTime(event.time))}</time>
        <span class="timeline-dot ${level}"></span>
        <div class="timeline-body">
          <p class="timeline-title">${badge}${escapeHtml(title)}</p>
          <p class="timeline-meta">${escapeHtml(pet)} ・ ${escapeHtml(detail)}${event.notify ? ' ・ 通知対象' : ''}</p>
        </div>
      </article>`;
  }).join('');
}

function shouldShowCategoryBadge(category) {
  return Boolean(category) && !['ペット', '見えない', '不明', '確認中'].includes(category);
}

function categoryLabel(category, observation) {
  if (!category || category === 'unknown') {
    if (observation?.petVisible === true) return 'ペット';
    if (observation?.petVisible === false) return '見えない';
  }

  return ({
    sleep: 'お昼寝中',
    eat: 'ご飯中',
    drink: '水飲み',
    toilet: 'トイレ',
    play: '遊んでいる',
    mischief: 'イタズラかも',
    near_owner: '人の近く',
    moving: '移動中',
    rest: 'くつろぎ中',
    not_visible: '見えない',
    unknown: '不明'
  })[category] || 'ペット';
}

function shouldShowTimelineEvent(event) {
  const ai = event.ai;
  const category = event.activityCategory || ai?.activityCategory;

  if (event.notify) return true;
  if (ai?.petVisible === true) return true;

  return ['sleep', 'eat', 'drink', 'toilet', 'play', 'mischief', 'near_owner', 'moving', 'rest'].includes(category);
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

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDate(date, days) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, '0');
  const d = String(next.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLabel(date) {
  if (date === todayString()) return '今日';
  if (date === shiftDate(todayString(), -1)) return '昨日';
  if (date === shiftDate(todayString(), 1)) return '明日';
  const [, month, day] = String(date).split('-');
  return `${Number(month)}月${Number(day)}日`;
}

function updateDateControls() {
  dateInput.value = selectedDate;
  dateDisplayBtn.textContent = formatDateLabel(selectedDate);
}

function setSelectedDate(date) {
  selectedDate = date;
  updateDateControls();
  reportEl.classList.add('report-placeholder');
  reportEl.textContent = '22時になると、その日のふりかえりが表示されます。';
  initialLoading = true;
  refreshAll().catch(() => {});
}

prevDayBtn.addEventListener('click', () => setSelectedDate(shiftDate(selectedDate, -1)));
nextDayBtn.addEventListener('click', () => setSelectedDate(shiftDate(selectedDate, 1)));
dateDisplayBtn.addEventListener('click', () => {
  if (dateInput.showPicker) dateInput.showPicker();
  else dateInput.click();
});
dateInput.addEventListener('change', event => {
  if (event.target.value) setSelectedDate(event.target.value);
});

async function refreshReport() {
  try {
    const res = await fetch(`/api/report?date=${encodeURIComponent(selectedDate)}`);
    const json = await res.json();
    if (!json.exists) {
      reportEl.classList.add('report-placeholder');
      reportEl.textContent = selectedDate === todayString()
        ? '22時になると、今日のふりかえりが表示されます。'
        : `${formatDateLabel(selectedDate)}のふりかえりはまだありません。`;
      return;
    }

    reportEl.classList.remove('report-placeholder');
    reportEl.textContent = json.markdown || '';
    renderTimeline(latestEvents, json.report?.ai?.frameObservations || []);
  } catch (err) {
    reportEl.classList.add('report-placeholder');
    reportEl.textContent = `ふりかえりを読み込めませんでした: ${err.message}`;
  }
}

updateDateControls();
loadPetProfile().catch(() => renderPetProfile());
refreshAll().catch(() => {});
setInterval(refreshAll, 5000);
