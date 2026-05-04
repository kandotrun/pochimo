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
