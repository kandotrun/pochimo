const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSubmit = document.getElementById('chatSubmit');

chatForm.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = chatInput.value.trim();
  if (!prompt) return;

  appendMessage('user', prompt);
  chatInput.value = '';
  chatSubmit.disabled = true;
  const pending = appendMessage('assistant', '');
  const stopThinking = startThinkingAnimation(pending);

  try {
    const res = await fetch('/api/timeline/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: todayString(), prompt })
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'chat failed');
    stopThinking();
    pending.innerHTML = renderAssistantReply(json);
  } catch (err) {
    stopThinking();
    pending.textContent = 'うまく読み取れませんでした。少し時間を置いてもう一度聞いてください。';
  } finally {
    chatSubmit.disabled = false;
    chatInput.focus();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

function appendMessage(role, text) {
  const node = document.createElement('div');
  node.className = `chat-bubble ${role}`;
  node.textContent = text;
  chatMessages.appendChild(node);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return node;
}

function startThinkingAnimation(node) {
  const messages = [
    '今日の記録を読み込んでいます',
    '写真と行動の変化を見ています',
    'ポテトが何をしていたか整理しています',
    '関係ありそうな時間帯を探しています'
  ];
  let index = 0;

  const render = () => {
    node.classList.add('thinking');
    node.innerHTML = `
      <span class="thinking-text">${escapeHtml(messages[index % messages.length])}</span>
      <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
    index += 1;
  };

  render();
  const timer = setInterval(render, 1400);
  return () => {
    clearInterval(timer);
    node.classList.remove('thinking');
  };
}

function renderAssistantReply(json) {
  const reply = `<p>${escapeHtml(json.reply || '近い記録を表示します。')}</p>`;
  const items = Array.isArray(json.items) ? json.items.slice(0, 6) : [];
  if (!items.length) return reply;

  return `${reply}<div class="chat-related-list">${items.map(item => {
    const imageSrc = item.imageUrl || (item.file ? `/${item.file}` : '');
    const time = formatTimelineTime(item);
    const title = item.timelineText || item.title || item.detail || 'この時間帯の記録です。';
    return `
      <article class="chat-related-item">
        ${imageSrc ? `<img src="${escapeHtml(imageSrc)}?v=${encodeURIComponent(item.imageTime || item.time || item.startTime || '')}" alt="${escapeHtml(time)}の写真" loading="lazy" />` : ''}
        <div>
          <time>${escapeHtml(time)}</time>
          <p>${escapeHtml(title)}</p>
        </div>
      </article>`;
  }).join('')}</div>`;
}

function formatTimelineTime(item) {
  const start = formatEventTime(item.startTime || item.time || item.imageTime);
  const end = formatEventTime(item.endTime || item.time || item.startTime);
  return start && end && start !== end ? `${start}〜${end}` : (start || end || '');
}

function formatEventTime(time) {
  return String(time || '').slice(11, 19).replaceAll('-', ':').slice(0, 5);
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
