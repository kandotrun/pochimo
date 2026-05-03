import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const FRAME_DIR = path.join(DATA_DIR, 'frames');
const REPORT_DIR = path.join(DATA_DIR, 'reports');
const PUBLIC_DIR = path.join(__dirname, 'public');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_CLOUD_URL || 'https://ollama.com/v1';
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL || 'deepseek-v4-pro';
const OLLAMA_CLOUD_VISION_MODEL = process.env.OLLAMA_CLOUD_VISION_MODEL || 'gemma4:31b';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

await fs.mkdir(FRAME_DIR, { recursive: true });
await fs.mkdir(REPORT_DIR, { recursive: true });

function todayJst() {
  const d = new Date();
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function nowStampJst() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
  return parts.replace(' ', 'T').replaceAll(':', '-');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function pickRepresentativeEvents(events) {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => b.motionScore - a.motionScore);
  const picks = [events[0], sorted[0], events.at(-1)].filter(Boolean);
  const seen = new Set();
  return picks.filter(e => {
    if (seen.has(e.file)) return false;
    seen.add(e.file);
    return true;
  }).slice(0, 3);
}

async function analyzeFramesWithOllama(events) {
  const picks = pickRepresentativeEvents(events);
  if (picks.length === 0) return { enabled: false, model: OLLAMA_CLOUD_VISION_MODEL, observations: [], summary: '解析対象の画像がありません。' };

  const images = [];
  for (const e of picks) {
    const imagePath = path.join(__dirname, e.file);
    if (await fileExists(imagePath)) images.push((await fs.readFile(imagePath)).toString('base64'));
  }
  if (images.length === 0) return { enabled: false, model: OLLAMA_CLOUD_VISION_MODEL, observations: [], summary: '保存画像が見つかりません。' };

  const prompt = `あなたはペット見守り日報AIです。画像は室内に置いたスマホカメラの代表フレームです。\n\n必ず日本語で、医療診断はせず、観察できる事実だけを書いてください。\n以下のJSONだけを返してください。\n{\n  "petVisible": true/false,\n  "scene": "室内の状況を1文",\n  "petActivity": "ペットが見える場合の様子。不明なら不明",\n  "concerns": ["気になる点。暗い/見切れ/判定困難も含む"],\n  "ownerChecks": ["飼い主が確認するとよいこと"]\n}`;

  if (OLLAMA_API_KEY) {
    try {
      const content = [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }))];
      const response = await fetch(`${OLLAMA_CLOUD_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OLLAMA_API_KEY}` },
        body: JSON.stringify({
          model: OLLAMA_CLOUD_VISION_MODEL,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 1200,
          stream: false
        }),
        signal: AbortSignal.timeout(120000)
      });
      if (!response.ok) throw new Error(`Ollama Cloud Vision HTTP ${response.status}: ${await response.text()}`);
      const data = await response.json();
      const raw = String(data.choices?.[0]?.message?.content || '').trim();
      let parsed;
      try {
        const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
        parsed = JSON.parse(jsonText);
      } catch {
        parsed = { petVisible: null, scene: raw, petActivity: 'JSON解析失敗', concerns: ['Visionモデルの返答がJSONではありませんでした'], ownerChecks: [] };
      }
      return { enabled: true, provider: 'ollama-cloud', model: OLLAMA_CLOUD_VISION_MODEL, framesAnalyzed: images.length, raw, ...parsed };
    } catch (err) {
      console.warn(`cloud vision failed; falling back to local ollama: ${err.message}`);
    }
  }

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_VISION_MODEL, prompt, images, stream: false, options: { temperature: 0.2 } }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = await response.json();
    const raw = String(data.response || '').trim();
    let parsed;
    try {
      const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = { petVisible: null, scene: raw, petActivity: 'JSON解析失敗', concerns: ['Ollamaの返答がJSONではありませんでした'], ownerChecks: [] };
    }
    return { enabled: true, provider: 'local-ollama', model: OLLAMA_VISION_MODEL, framesAnalyzed: images.length, raw, ...parsed };
  } catch (err) {
    return { enabled: false, model: OLLAMA_VISION_MODEL, observations: [], summary: `Ollama解析に失敗: ${err.message}` };
  }
}

async function polishMarkdownWithCloud({ report, fallbackMarkdown }) {
  if (!OLLAMA_API_KEY || report.capturedFrames === 0) return { enabled: false, model: OLLAMA_CLOUD_MODEL, markdown: fallbackMarkdown, summary: 'Ollama Cloud API key未設定または画像なし' };

  const prompt = `以下はペット見守りMVPの生ログです。飼い主向けの自然な日本語日報に整えてください。\n\n制約:\n- 医療診断はしない\n- 不確かなことは断定しない\n- 画像が暗い/判定困難なら正直に書く\n- Markdownのみ返す\n- 見出しは「今日の様子」「気になる点」「明日見ること」「技術メモ」にする\n\n生ログJSON:\n${JSON.stringify(report, null, 2)}\n\n現在の下書き:\n${fallbackMarkdown}`;

  try {
    const response = await fetch(`${OLLAMA_CLOUD_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OLLAMA_API_KEY}` },
      body: JSON.stringify({
        model: OLLAMA_CLOUD_MODEL,
        messages: [
          { role: 'system', content: 'あなたはペット見守り日報を書くAIです。観察事実をやさしく、ただし断定しすぎず整理します。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1200,
        stream: false
      }),
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`Ollama Cloud HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const markdown = data.choices?.[0]?.message?.content?.trim();
    if (!markdown) throw new Error('empty response');
    return { enabled: true, model: OLLAMA_CLOUD_MODEL, markdown };
  } catch (err) {
    return { enabled: false, model: OLLAMA_CLOUD_MODEL, markdown: fallbackMarkdown, summary: `Ollama Cloud整形に失敗: ${err.message}` };
  }
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'access-control-allow-origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function parseBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) reject(new Error('payload too large'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function createReport(date = todayJst(), { useAi = true } = {}) {
  const eventsFile = path.join(DATA_DIR, `${date}.events.json`);
  const events = await readJson(eventsFile, []);
  const captured = events.length;
  const motionEvents = events.filter(e => e.motionScore >= 8);
  const activeByHour = new Map();
  for (const e of motionEvents) {
    const hour = e.time.slice(11, 13);
    activeByHour.set(hour, (activeByHour.get(hour) || 0) + 1);
  }
  const topHours = [...activeByHour.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const quietRuns = [];
  let runStart = null;
  for (const e of events) {
    const quiet = e.motionScore < 3;
    if (quiet && !runStart) runStart = e;
    if (!quiet && runStart) {
      quietRuns.push({ from: runStart.time, to: e.time });
      runStart = null;
    }
  }
  if (runStart && events.at(-1)) quietRuns.push({ from: runStart.time, to: events.at(-1).time });

  const ai = useAi && captured > 0 ? await analyzeFramesWithOllama(events) : { enabled: false, model: OLLAMA_VISION_MODEL, summary: 'AI解析は未実行です。' };

  const report = {
    date,
    capturedFrames: captured,
    activeFrames: motionEvents.length,
    topActiveHours: topHours.map(([hour, count]) => ({ hour: `${hour}:00`, count })),
    quietPeriods: quietRuns.slice(0, 5),
    ai,
    summary: captured === 0
      ? 'まだキャプチャがありません。スマホで撮影を開始してください。'
      : `今日は${captured}枚を記録し、そのうち動きが強めだったフレームは${motionEvents.length}枚でした。`,
    nextChecks: [
      '水飲み場・ごはん場・トイレなどの注目エリアを指定できるようにする',
      '昨日との差分を出す',
      '夜1回、自動でLINE/Slack/メールに送る'
    ]
  };

  const aiSection = ai.enabled
    ? `## Ollama画像解析（${ai.model}）\n- ペットが見える: ${ai.petVisible === true ? 'はい' : ai.petVisible === false ? 'いいえ' : '不明'}\n- 場面: ${ai.scene || '不明'}\n- 様子: ${ai.petActivity || '不明'}\n\n### 気になる点\n${Array.isArray(ai.concerns) && ai.concerns.length ? ai.concerns.map(x => `- ${x}`).join('\n') : '- 特になし/判定困難'}\n\n### 飼い主が確認するとよいこと\n${Array.isArray(ai.ownerChecks) && ai.ownerChecks.length ? ai.ownerChecks.map(x => `- ${x}`).join('\n') : '- 画角と明るさを確認'}\n`
    : `## Ollama画像解析\n- ${ai.summary || '未実行'}\n`;

  const fallbackMd = `# ペット日報 ${date}\n\n${report.summary}\n\n${aiSection}\n## 活動が多かった時間\n${report.topActiveHours.length ? report.topActiveHours.map(x => `- ${x.hour}ごろ: ${x.count}回`).join('\n') : '- まだ十分な動きデータがありません'}\n\n## 静かだった時間候補\n${report.quietPeriods.length ? report.quietPeriods.map(x => `- ${x.from.slice(11,16)}〜${x.to.slice(11,16)}`).join('\n') : '- まだ判定できません'}\n\n## 次に見ること\n${report.nextChecks.map(x => `- ${x}`).join('\n')}\n`;

  const cloud = useAi ? await polishMarkdownWithCloud({ report, fallbackMarkdown: fallbackMd }) : { enabled: false, model: OLLAMA_CLOUD_MODEL, markdown: fallbackMd };
  report.cloud = { enabled: cloud.enabled, model: cloud.model, summary: cloud.summary || 'ok' };
  const md = cloud.markdown || fallbackMd;

  await writeJson(path.join(REPORT_DIR, `${date}.json`), report);
  await fs.writeFile(path.join(REPORT_DIR, `${date}.md`), md);
  return { report, markdown: md };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, date: todayJst() });
    }

    if (req.method === 'POST' && url.pathname === '/api/capture') {
      const raw = await parseBody(req);
      const body = JSON.parse(raw);
      if (!body.image?.startsWith('data:image/jpeg;base64,')) return send(res, 400, { ok: false, error: 'image must be jpeg data url' });
      const date = todayJst();
      const stamp = nowStampJst();
      const dateDir = path.join(FRAME_DIR, date);
      await fs.mkdir(dateDir, { recursive: true });
      const filename = `${stamp}.jpg`;
      const imageBytes = Buffer.from(body.image.split(',')[1], 'base64');
      await fs.writeFile(path.join(dateDir, filename), imageBytes);

      const event = {
        time: stamp,
        file: `data/frames/${date}/${filename}`,
        motionScore: Number(body.motionScore || 0),
        cameraLabel: body.cameraLabel || 'browser-camera',
        note: body.note || ''
      };
      const eventsFile = path.join(DATA_DIR, `${date}.events.json`);
      const events = await readJson(eventsFile, []);
      events.push(event);
      await writeJson(eventsFile, events);
      return send(res, 200, { ok: true, event, count: events.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const date = url.searchParams.get('date') || todayJst();
      return send(res, 200, await readJson(path.join(DATA_DIR, `${date}.events.json`), []));
    }

    if (req.method === 'GET' && url.pathname === '/api/report') {
      const date = url.searchParams.get('date') || todayJst();
      const useAi = url.searchParams.get('ai') !== '0';
      return send(res, 200, await createReport(date, { useAi }));
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
    if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(content);
  } catch (err) {
    send(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pet Diary AI MVP running: http://localhost:${PORT}`);
});
