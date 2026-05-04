const authTitle = document.getElementById('authTitle');
const authLead = document.getElementById('authLead');
const authForm = document.getElementById('authForm');
const authStatus = document.getElementById('authStatus');
const submitBtn = document.getElementById('submitBtn');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const inviteField = document.getElementById('inviteField');
const inviteCodeInput = document.getElementById('inviteCode');

let setupMode = false;

async function init() {
  const state = await fetch('/api/auth/state').then(res => res.json());
  if (state.user) {
    location.href = '/viewer';
    return;
  }

  setupMode = !state.hasUsers;
  const invite = new URLSearchParams(location.search).get('invite') || '';

  authTitle.textContent = setupMode ? 'ぽちも日報を始める' : invite ? 'ぽちも日報に参加' : 'ぽちも日報';
  authLead.textContent = setupMode
    ? 'この日報を開くためのアカウントを作成してください。'
    : invite
      ? '家族の日報に参加するアカウントを作成してください。'
      : '日報を見るにはログインしてください。';
  submitBtn.textContent = setupMode ? '作成して始める' : invite ? '参加する' : 'ログイン';
  usernameInput.placeholder = setupMode ? '例: kan' : '';

  inviteField.hidden = setupMode || !invite;
  inviteCodeInput.value = invite;
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  submitBtn.disabled = true;
  authStatus.textContent = setupMode ? '作成しています...' : 'ログインしています...';

  const invite = inviteCodeInput.value.trim();
  const endpoint = setupMode ? '/api/auth/setup' : invite ? '/api/auth/register' : '/api/auth/login';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value, inviteCode: invite })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'failed');
    location.href = '/viewer';
  } catch (err) {
    authStatus.textContent = setupMode ? `作成できませんでした: ${err.message}` : `ログインできませんでした: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

init().catch(err => {
  authStatus.textContent = `読み込みに失敗しました: ${err.message}`;
});
