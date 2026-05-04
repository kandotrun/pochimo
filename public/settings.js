const petAvatar = document.getElementById('petAvatar');
const petNameInput = document.getElementById('petNameInput');
const petPhotoInput = document.getElementById('petPhotoInput');
const profileStatus = document.getElementById('profileStatus');
const settingsLead = document.getElementById('settingsLead');
const cropModal = document.getElementById('cropModal');
const cropImage = document.getElementById('cropImage');
const cropZoom = document.getElementById('cropZoom');
const cropX = document.getElementById('cropX');
const cropY = document.getElementById('cropY');
const cropCanvas = document.getElementById('cropCanvas');
const cropCancel = document.getElementById('cropCancel');
const cropSave = document.getElementById('cropSave');
const createInviteBtn = document.getElementById('createInviteBtn');
const inviteResult = document.getElementById('inviteResult');
const inviteList = document.getElementById('inviteList');

let petProfile = {};
let profileSaveTimer = null;
let cropSource = null;

function renderSettingsSkeleton() {
  petAvatar.textContent = '';
  petAvatar.style.backgroundImage = '';
  petAvatar.classList.add('skeleton');
  petNameInput.placeholder = '読み込み中...';
  profileStatus.innerHTML = '<div class="skeleton skeleton-line short"></div>';
  inviteList.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div>';
}

async function loadPetProfile() {
  const json = await fetch('/api/profile').then(res => res.json());
  petProfile = json.profile || {};
  renderPetProfile();
}

function renderPetProfile() {
  const name = petProfile.name?.trim();
  petNameInput.value = name || '';
  settingsLead.textContent = name ? `${name}のプロフィールを設定できます。` : 'ペットの名前と写真を登録できます。';

  petAvatar.classList.remove('skeleton');
  profileStatus.textContent = name ? '保存済みです。' : '名前を入力すると自動保存されます。';
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

function savePetProfile(patch) {
  petProfile = { ...petProfile, ...patch };
  renderPetProfile();
  profileStatus.textContent = '保存中...';

  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: petProfile.name || '', photo: petProfile.photo || '' })
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'failed');
      petProfile = json.profile;
      profileStatus.textContent = '保存しました';
    } catch (err) {
      profileStatus.textContent = `保存できませんでした: ${err.message}`;
    }
  }, 350);
}

petNameInput.addEventListener('input', event => savePetProfile({ name: event.target.value }));
petPhotoInput.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => openCropModal(reader.result);
  reader.readAsDataURL(file);
  petPhotoInput.value = '';
});

cropCancel.addEventListener('click', closeCropModal);
cropSave.addEventListener('click', () => {
  const cropped = renderCroppedPhoto();
  savePetProfile({ photo: cropped });
  closeCropModal();
});
[cropZoom, cropX, cropY].forEach(input => input.addEventListener('input', updateCropPreview));

function openCropModal(src) {
  cropSource = src;
  cropImage.src = src;
  cropZoom.value = '1';
  cropX.value = '0';
  cropY.value = '0';
  cropModal.hidden = false;
  cropImage.onload = updateCropPreview;
}

function closeCropModal() {
  cropModal.hidden = true;
  cropSource = null;
  cropImage.src = '';
}

function updateCropPreview() {
  if (!cropSource || !cropImage.naturalWidth) return;

  const stage = cropImage.parentElement.getBoundingClientRect();
  const baseScale = Math.max(stage.width / cropImage.naturalWidth, stage.height / cropImage.naturalHeight);
  const zoom = Number(cropZoom.value);
  const width = cropImage.naturalWidth * baseScale * zoom;
  const height = cropImage.naturalHeight * baseScale * zoom;
  const x = Number(cropX.value) / 100 * stage.width * 0.5;
  const y = Number(cropY.value) / 100 * stage.height * 0.5;

  cropImage.style.width = `${width}px`;
  cropImage.style.height = `${height}px`;
  cropImage.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function renderCroppedPhoto() {
  const size = 512;
  cropCanvas.width = size;
  cropCanvas.height = size;
  const ctx = cropCanvas.getContext('2d');
  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, size, size);

  const stage = cropImage.parentElement.getBoundingClientRect();
  const baseScale = Math.max(stage.width / cropImage.naturalWidth, stage.height / cropImage.naturalHeight);
  const zoom = Number(cropZoom.value);
  const displayedWidth = cropImage.naturalWidth * baseScale * zoom;
  const displayedHeight = cropImage.naturalHeight * baseScale * zoom;
  const offsetX = Number(cropX.value) / 100 * stage.width * 0.5;
  const offsetY = Number(cropY.value) / 100 * stage.height * 0.5;

  const scaleToCanvas = size / stage.width;
  const drawWidth = displayedWidth * scaleToCanvas;
  const drawHeight = displayedHeight * scaleToCanvas;
  const drawX = size / 2 - drawWidth / 2 + offsetX * scaleToCanvas;
  const drawY = size / 2 - drawHeight / 2 + offsetY * scaleToCanvas;

  ctx.drawImage(cropImage, drawX, drawY, drawWidth, drawHeight);
  return cropCanvas.toDataURL('image/jpeg', 0.86);
}

async function loadInvites() {
  const json = await fetch('/api/invites').then(res => res.json());
  const invites = json.invites || [];
  inviteList.innerHTML = invites.length
    ? invites.map(invite => `<div class="invite-row"><span>${escapeHtml(invite.usedBy ? `使用済み: ${invite.usedBy}` : '未使用')}</span><code>${escapeHtml(invite.code)}</code></div>`).join('')
    : '<p class="section-description">まだ招待リンクはありません。</p>';
}

createInviteBtn.addEventListener('click', async () => {
  createInviteBtn.disabled = true;
  inviteResult.hidden = false;
  inviteResult.textContent = '作成中...';
  try {
    const json = await fetch('/api/invites', { method: 'POST' }).then(res => res.json());
    if (!json.ok) throw new Error(json.error || 'failed');
    const url = `${location.origin}/login?invite=${encodeURIComponent(json.invite.code)}`;
    inviteResult.innerHTML = `<p>このリンクを家族に共有してください。</p><input class="invite-url" readonly value="${escapeHtml(url)}" />`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    await loadInvites();
  } catch (err) {
    inviteResult.textContent = `作成できませんでした: ${err.message}`;
  } finally {
    createInviteBtn.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

renderSettingsSkeleton();
loadPetProfile().catch(err => {
  profileStatus.textContent = `読み込みに失敗しました: ${err.message}`;
});
loadInvites().catch(() => {});
