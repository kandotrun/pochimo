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

async function init() {
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
  step = 'email';
  codeField.hidden = true;
  codeInput.required = false;
  codeInput.value = '';
  emailInput.disabled = false;
  submitBtn.textContent = 'コードを送る';
  backBtn.hidden = true;
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

    step = 'code';
    emailInput.disabled = true;
    codeField.hidden = false;
    codeInput.required = true;
    submitBtn.textContent = 'ログインする';
    backBtn.hidden = false;
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
