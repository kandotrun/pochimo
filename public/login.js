const authTitle = document.getElementById('authTitle');
const authLead = document.getElementById('authLead');
const authForm = document.getElementById('authForm');
const authStatus = document.getElementById('authStatus');
const submitBtn = document.getElementById('submitBtn');
const backBtn = document.getElementById('backBtn');
const emailInput = document.getElementById('email');
const codeField = document.getElementById('codeField');
const codeInput = document.getElementById('code');
const inviteCodeInput = document.getElementById('inviteCode');

let step = 'email';
let currentEmail = '';

function renderStep(nextStep) {
  step = nextStep;
  const isCodeStep = step === 'code';
  codeField.hidden = !isCodeStep;
  codeField.setAttribute('aria-hidden', String(!isCodeStep));
  codeField.classList.toggle('is-visible', isCodeStep);
  codeInput.required = isCodeStep;
  if (!isCodeStep) codeInput.value = '';
  emailInput.disabled = isCodeStep;
  submitBtn.textContent = isCodeStep ? 'ログインする' : 'コードを送る';
  backBtn.hidden = !isCodeStep;
}

async function init() {
  renderStep('email');
  const state = await fetch('/api/auth/state').then(res => res.json());
  if (state.user) {
    location.href = '/viewer';
    return;
  }

  const invite = new URLSearchParams(location.search).get('invite') || '';
  inviteCodeInput.value = invite;
  authTitle.textContent = invite ? 'ぽちも日報に参加' : 'ぽちも日報';
  authLead.textContent = invite
    ? 'メールに届く6桁コードで、家族の日報に参加します。'
    : 'メールに届く6桁コードでログインします。';
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (step === 'email') return requestCode();
  return verifyCode();
});

backBtn.addEventListener('click', () => {
  renderStep('email');
  authStatus.textContent = '';
  emailInput.focus();
});

async function requestCode() {
  submitBtn.disabled = true;
  authStatus.textContent = 'コードを送信しています...';
  currentEmail = emailInput.value.trim();

  try {
    const json = await postJson('/api/auth/email/start', {
      email: currentEmail,
      inviteCode: inviteCodeInput.value
    });
    if (!json.ok) throw new Error(json.error || 'failed');

    renderStep('code');
    authStatus.textContent = `${json.email} に6桁コードを送りました。10分以内に入力してください。`;
    codeInput.focus();
  } catch (err) {
    authStatus.textContent = `コードを送れませんでした: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
}

async function verifyCode() {
  submitBtn.disabled = true;
  authStatus.textContent = '確認しています...';

  try {
    const json = await postJson('/api/auth/email/verify', {
      email: currentEmail || emailInput.value.trim(),
      code: codeInput.value.trim(),
      inviteCode: inviteCodeInput.value
    });
    if (!json.ok) throw new Error(json.error || 'failed');
    location.href = '/viewer';
  } catch (err) {
    authStatus.textContent = `ログインできませんでした: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

init().catch(err => {
  authStatus.textContent = `読み込みに失敗しました: ${err.message}`;
});
