function observationPrompt(petName = 'ペット') {
  const name = String(petName || 'ペット').trim() || 'ペット';
  return `あなたはペット見守り日報AIです。画像は室内に置いたスマホカメラの代表フレームです。

対象のペット名は「${name}」です。
必ず日本語で、医療診断はせず、観察できる事実だけを書いてください。
出力文では「ペット」ではなく、可能な限り「${name}」という名前を使ってください。
例: 「ケージの中にペットがいます」ではなく「ケージの中に${name}がいます」。

以下のJSONだけを返してください。
{
  "petVisible": true/false,
  "scene": "室内の状況を1文。${name}が見えるなら名前を含める",
  "petActivity": "${name}が見える場合の様子。不明なら不明",
  "activityCategory": "sleep|eat|drink|toilet|play|mischief|near_owner|moving|rest|not_visible|unknown のどれか",
  "activityLabel": "お昼寝中/ご飯中/水飲み/トイレ/遊んでいる/イタズラかも/人の近く/移動中/くつろぎ中/見えない/不明 のような短い日本語",
  "notify": true/false,
  "notificationText": "飼い主に通知するなら${name}を含む短い一文。不要なら空文字",
  "petBox": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "confidence": 0.0 },
  "concerns": ["気になる点。暗い/見切れ/判定困難も含む"],
  "ownerChecks": ["飼い主が確認するとよいこと"]
}

petBoxは、${name}が見える場合だけ返してください。画像全体を左上(0,0)、右下(1,1)とする相対座標で、${name}の体全体を囲む矩形を推定してください。見えない・判定困難なら petBox は null にしてください。

通知は、ご飯・水・トイレ・イタズラ疑い・危険そうな状態・長時間見えない場合を優先してください。単なる静止や普段通りの休憩は notify=false にしてください。`;
}

function extractJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const jsonText = fenced || text.match(/\{[\s\S]*\}/)?.[0] || text;
  return JSON.parse(jsonText);
}

function safeObservationParse(raw, fallbackConcern) {
  try {
    return extractJson(raw);
  } catch {
    return {
      petVisible: null,
      scene: String(raw || '').trim() || '不明',
      petActivity: 'JSON解析失敗',
      concerns: [fallbackConcern],
      ownerChecks: []
    };
  }
}

export class OllamaClient {
  constructor(options) {
    this.localUrl = options.localUrl;
    this.localVisionModel = options.localVisionModel;
    this.cloudUrl = options.cloudUrl;
    this.cloudVisionModel = options.cloudVisionModel;
    this.cloudReportModel = options.cloudReportModel;
    this.apiKey = options.apiKey;
  }

  async analyzeImages(images, { petName = 'ペット' } = {}) {
    if (images.length === 0) {
      return { enabled: false, model: this.cloudVisionModel, summary: '解析対象の画像がありません。' };
    }

    if (this.apiKey) {
      const cloud = images.length > 1
        ? await this.#tryCloudVisionSingleFrames(images, new Error('batch skipped'), petName)
        : await this.#tryCloudVision(images, petName);
      if (cloud) return cloud;
    }

    return this.#localVision(images, petName);
  }

  async polishReport({ report, fallbackMarkdown, petName = 'ペット' }) {
    if (!this.apiKey || report.capturedFrames === 0) {
      return {
        enabled: false,
        model: this.cloudReportModel,
        markdown: fallbackMarkdown,
        summary: 'Ollama Cloud API key未設定または画像なし'
      };
    }

    const prompt = `以下はペット見守りMVPの生ログです。飼い主向けの自然な日本語日報に整えてください。

対象のペット名は「${petName}」です。本文では「ペット」ではなく、可能な限りこの名前を使ってください。

制約:
- 医療診断はしない
- 不確かなことは断定しない
- 画像が暗い/判定困難なら正直に書く
- Markdownのみ返す
- 見出しは「今日の様子」「気になる点」「明日見ること」「技術メモ」にする

生ログJSON:
${JSON.stringify(report, null, 2)}

現在の下書き:
${fallbackMarkdown}`;

    try {
      const data = await this.#chatCompletions({
        model: this.cloudReportModel,
        messages: [
          { role: 'system', content: 'あなたはペット見守り日報を書くAIです。観察事実をやさしく、ただし断定しすぎず整理します。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1200
      });

      const markdown = data.choices?.[0]?.message?.content?.trim();
      if (!markdown) throw new Error('empty response');
      return { enabled: true, model: this.cloudReportModel, markdown };
    } catch (err) {
      return {
        enabled: false,
        model: this.cloudReportModel,
        markdown: fallbackMarkdown,
        summary: `Ollama Cloud整形に失敗: ${err.message}`
      };
    }
  }

  async createTimeline({ events, petName = 'ペット' }) {
    const fallback = createFallbackTimeline(events, petName);
    if (!this.apiKey || !events.length) {
      return { enabled: false, model: this.cloudReportModel, items: fallback, summary: 'API keyなし、またはイベントなし' };
    }

    const compactEvents = events.map(event => ({
      time: event.time,
      activityCategory: event.activityCategory || event.ai?.activityCategory || 'unknown',
      activityLabel: event.activityLabel || event.ai?.activityLabel || '',
      petVisible: event.ai?.petVisible,
      petActivity: event.ai?.petActivity || '',
      scene: event.ai?.scene || '',
      notify: Boolean(event.notify),
      notificationText: event.notificationText || '',
      timelineText: event.timelineText || '',
      motionScore: Number(event.motionScore || 0)
    }));

    const prompt = `あなたは「ぽちも日報」の編集AIです。以下の検知イベント列から、飼い主に見せる価値があるタイムラインだけを作ってください。

対象のペット名: ${petName}

方針:
- 監視ログではなく、家族が読める日記にする
- 同じ状態が数分続いたものは1件にまとめる
- 「ただ暗い」「見えない」「同じ場所で静止」は重要でない限り省く
- イタズラ/危険/通知対象は必ず残す
- 休憩や睡眠はまとまった変化として残す
- 全体を見たうえで、同じ状態だけをまとめる。代表サンプリングで時間帯を捨てない
- 最大20件。多すぎる場合も時間帯を飛ばさず、近い記録を大きめにまとめる
- 必ずJSONだけ返す

形式:
{
  "items": [
    {
      "startTime": "YYYY-MM-DDTHH-MM-SS",
      "endTime": "YYYY-MM-DDTHH-MM-SS",
      "category": "sleep|eat|drink|toilet|play|mischief|near_owner|moving|rest|not_visible|unknown",
      "label": "短い日本語ラベル",
      "title": "タイムライン本文。${petName}を主語にした自然な1文",
      "detail": "補足。不要なら空文字",
      "importance": "low|normal|high",
      "notify": true/false
    }
  ]
}

イベントJSON:
${JSON.stringify(compactEvents)}`;

    try {
      const data = await this.#chatCompletions({
        model: this.cloudReportModel,
        messages: [
          { role: 'system', content: 'あなたはペットの日報タイムラインを編集するAIです。細かいログを読みやすい日記に圧縮します。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 1800
      });

      const raw = data.choices?.[0]?.message?.content || '';
      const parsed = extractJson(raw);
      const items = normalizeTimelineItems(parsed.items, events);
      return { enabled: true, model: this.cloudReportModel, items: items.length ? items : fallback, raw: String(raw).trim() };
    } catch (err) {
      return { enabled: false, model: this.cloudReportModel, items: fallback, summary: `LLMタイムライン生成に失敗: ${err.message}` };
    }
  }

  async #tryCloudVision(images, petName) {
    try {
      const content = [
        { type: 'text', text: observationPrompt(petName) },
        ...images.map(image => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }))
      ];

      const data = await this.#chatCompletions({
        model: this.cloudVisionModel,
        messages: [{ role: 'user', content }],
        temperature: 0.1,
        max_tokens: 1200
      });

      const raw = data.choices?.[0]?.message?.content || '';
      return {
        enabled: true,
        provider: 'ollama-cloud',
        model: this.cloudVisionModel,
        framesAnalyzed: images.length,
        raw: String(raw).trim(),
        ...safeObservationParse(raw, 'Visionモデルの返答がJSONではありませんでした')
      };
    } catch (err) {
      console.warn(`cloud vision batch failed; trying single-frame cloud vision: ${err.message}`);
      return this.#tryCloudVisionSingleFrames(images, err, petName);
    }
  }

  async #tryCloudVisionSingleFrames(images, originalError, petName) {
    const observations = await mapWithConcurrency(images, 3, async (image, index) => {
      try {
        const data = await this.#chatCompletions({
          model: this.cloudVisionModel,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: observationPrompt(petName) },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
            ]
          }],
          temperature: 0.1,
          max_tokens: 800
        });

        const raw = data.choices?.[0]?.message?.content || '';
        return { index, raw: String(raw).trim(), parsed: safeObservationParse(raw, 'Visionモデルの返答がJSONではありませんでした') };
      } catch (err) {
        return { index, raw: '', parsed: { petVisible: null, scene: '解析失敗', petActivity: '不明', concerns: [`frame ${index + 1}: ${err.message}`], ownerChecks: [] } };
      }
    });

    const successful = observations.filter(item => item.raw);
    if (!successful.length) {
      console.warn(`cloud vision single-frame failed; falling back to local ollama: ${originalError.message}`);
      return null;
    }

    const petVisible = observations.some(item => item.parsed.petVisible === true)
      ? true
      : observations.every(item => item.parsed.petVisible === false)
        ? false
        : null;

    return {
      enabled: true,
      provider: 'ollama-cloud-single-frame',
      model: this.cloudVisionModel,
      framesAnalyzed: successful.length,
      petVisible,
      scene: observations.map(item => `frame ${item.index + 1}: ${item.parsed.scene || item.raw}`).join(' / '),
      petActivity: observations.map(item => item.parsed.petActivity).filter(Boolean).join(' / ') || '不明',
      concerns: observations.flatMap(item => item.parsed.concerns || []).slice(0, 6),
      ownerChecks: observations.flatMap(item => item.parsed.ownerChecks || []).slice(0, 6),
      frameObservations: observations.map(item => ({ index: item.index, ...item.parsed, raw: item.raw })),
      raw: observations.map(item => `frame ${item.index + 1}: ${item.raw || '解析失敗'}`).join('\n')
    };
  }

  async #localVision(images, petName) {
    try {
      const response = await fetch(`${this.localUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.localVisionModel,
          prompt: observationPrompt(petName),
          images,
          stream: false,
          options: { temperature: 0.2 }
        }),
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const data = await response.json();
      const raw = data.response || '';
      return {
        enabled: true,
        provider: 'local-ollama',
        model: this.localVisionModel,
        framesAnalyzed: images.length,
        raw: String(raw).trim(),
        ...safeObservationParse(raw, 'Ollamaの返答がJSONではありませんでした')
      };
    } catch (err) {
      return {
        enabled: false,
        model: this.localVisionModel,
        summary: `Ollama解析に失敗: ${err.message}`
      };
    }
  }

  async #chatCompletions(payload) {
    const maxAttempts = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${this.cloudUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({ ...payload, stream: false }),
          signal: AbortSignal.timeout(120000)
        });

        if (response.ok) return response.json();

        const errorText = await response.text();
        lastError = new Error(`Ollama Cloud HTTP ${response.status}: ${errorText}`);
        if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
      } catch (err) {
        lastError = err;
      }

      if (attempt < maxAttempts) await sleep(1000 * attempt);
    }

    throw lastError;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createFallbackTimeline(events, petName = 'ペット') {
  const visible = events
    .filter(event => event.notify || event.ai?.petVisible === true || ['sleep', 'eat', 'drink', 'toilet', 'play', 'mischief', 'near_owner', 'moving', 'rest'].includes(event.activityCategory || event.ai?.activityCategory));
  const groups = [];

  for (const event of visible) {
    const previous = groups.at(-1);
    const category = event.activityCategory || event.ai?.activityCategory || 'unknown';
    if (previous && shouldMergeFallbackTimelineEvents(previous, event, category)) {
      previous.events.push(event);
      previous.endTime = event.time;
      if (isDailyLifeCategory(previous.category) && isDailyLifeCategory(category)) {
        previous.category = 'rest';
        previous.label = '過ごしている';
      }
      previous.title = fallbackGroupTitle(previous.events, petName);
      previous.detail = event.ai?.scene || previous.detail || '';
      continue;
    }

    groups.push({
      startTime: event.time,
      endTime: event.time,
      category,
      label: event.activityLabel || event.ai?.activityLabel || categoryToLabel(category),
      title: naturalTimelineTitle(event, petName),
      detail: event.ai?.scene || '',
      importance: event.notify ? 'high' : 'normal',
      notify: Boolean(event.notify),
      events: [event]
    });
  }

  return groups.map(({ events: _events, ...item }) => item);
}

function shouldMergeFallbackTimelineEvents(previous, event, category) {
  const last = previous.events.at(-1);
  if (!last) return false;
  const sameCategory = previous.category === category || (isDailyLifeCategory(previous.category) && isDailyLifeCategory(category));
  if (!sameCategory) return false;

  const minutes = Math.abs(parseEventTime(event.time) - parseEventTime(previous.endTime)) / 60000;
  const previousPlace = placeFromScene(previous.detail || previous.title || '');
  const eventPlace = placeFromScene(event.ai?.scene || event.timelineText || '');
  const samePlace = !previousPlace || !eventPlace || previousPlace === eventPlace;

  if (!samePlace) return false;
  if (previous.notify || event.notify) return minutes <= 20;
  if (isDailyLifeCategory(category)) return minutes <= 90;
  if (['not_visible', 'unknown'].includes(category)) return minutes <= 45;
  return minutes <= 25;
}

function isDailyLifeCategory(category) {
  return ['sleep', 'rest', 'moving'].includes(category);
}

function naturalTimelineTitle(event, petName) {
  const category = event.activityCategory || event.ai?.activityCategory || 'unknown';
  if (event.notificationText) return event.notificationText;
  if (event.ai?.petActivity && event.ai.petActivity !== '不明') return event.ai.petActivity.replaceAll('ペット', petName);
  if (event.timelineText && !event.timelineText.includes('写真を保存しました')) return event.timelineText.replace(/^[^:：]+[:：]\s*/, '').replaceAll('ペット', petName);
  if (event.ai?.scene) return event.ai.scene.replaceAll('ペット', petName);
  return `${petName}の様子を記録しました。`;
}

function fallbackGroupTitle(events, petName) {
  const latest = events.at(-1);
  const category = latest.activityCategory || latest.ai?.activityCategory || 'unknown';
  const label = latest.activityLabel || latest.ai?.activityLabel || categoryToLabel(category);
  const place = placeFromScene(latest.ai?.scene || latest.timelineText || '');
  if (['sleep', 'rest', 'moving'].includes(category)) return place ? `${petName}は${place}でしばらく過ごしていました。` : `${petName}はしばらく過ごしていました。`;
  if (category === 'not_visible') return `しばらく${petName}の姿が確認しづらい状態でした。`;
  if (label === '記録') return naturalTimelineTitle(latest, petName);
  return `${label}: ${naturalTimelineTitle(latest, petName)}`;
}

function placeFromScene(text) {
  const value = String(text || '');
  if (value.includes('ケージ')) return 'ケージの中';
  if (value.includes('テーブルの下')) return 'テーブルの下';
  if (value.includes('椅子')) return '椅子の上';
  if (value.includes('床')) return '床の上';
  if (value.includes('クッション')) return 'クッションのあたり';
  if (value.includes('キャリー')) return 'キャリーケースのあたり';
  return '';
}

function categoryToLabel(category) {
  return ({ sleep: 'お昼寝中', eat: 'ご飯中', drink: '水飲み', toilet: 'トイレ', play: '遊んでいる', mischief: 'イタズラかも', near_owner: '人の近く', moving: '移動中', rest: 'くつろぎ中', not_visible: '見えない', unknown: '記録' })[category] || '記録';
}

function normalizeTimelineItems(items, events) {
  if (!Array.isArray(items)) return [];
  const eventTimes = new Set(events.map(event => event.time));
  return items.slice(0, 40).map(item => {
    const startTime = eventTimes.has(item.startTime) ? item.startTime : nearestEventTime(item.startTime, events);
    const endTime = eventTimes.has(item.endTime) ? item.endTime : startTime;
    return {
      startTime,
      endTime,
      time: endTime || startTime,
      activityCategory: String(item.category || 'unknown'),
      activityLabel: String(item.label || '記録'),
      timelineText: String(item.title || '').trim(),
      detail: String(item.detail || '').trim(),
      importance: ['low', 'normal', 'high'].includes(item.importance) ? item.importance : 'normal',
      notify: Boolean(item.notify)
    };
  }).filter(item => item.startTime && item.timelineText);
}

function nearestEventTime(time, events) {
  if (!events.length) return '';
  if (!time) return events.at(-1).time;
  const target = parseEventTime(time);
  return events.reduce((best, event) => {
    const diff = Math.abs(parseEventTime(event.time) - target);
    return diff < best.diff ? { time: event.time, diff } : best;
  }, { time: events.at(-1).time, diff: Infinity }).time;
}

function parseEventTime(time) {
  const normalized = String(time || '').replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
