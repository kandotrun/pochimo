import type { CloudPolishResult, Observation, Report } from './types.js';

const OBSERVATION_PROMPT = `あなたはペット見守り日報AIです。画像は室内に置いたスマホカメラの代表フレームです。

必ず日本語で、医療診断はせず、観察できる事実だけを書いてください。
以下のJSONだけを返してください。
{
  "petVisible": true/false,
  "scene": "室内の状況を1文",
  "petActivity": "ペットが見える場合の様子。不明なら不明",
  "concerns": ["気になる点。暗い/見切れ/判定困難も含む"],
  "ownerChecks": ["飼い主が確認するとよいこと"]
}`;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
};

type ChatPayload = {
  model: string;
  messages: ChatMessage[];
  response_format?: { type: 'json_object' };
  temperature?: number;
  max_tokens?: number;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type LocalGenerateResponse = {
  response?: string;
};

type OllamaOptions = {
  localUrl: string;
  localVisionModel: string;
  cloudUrl: string;
  cloudVisionModel: string;
  cloudReportModel: string;
  apiKey: string;
};

function extractJson(raw: string): unknown {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const jsonText = fenced || text.match(/\{[\s\S]*\}/)?.[0] || text;
  return JSON.parse(jsonText);
}

function safeObservationParse(raw: string, fallbackConcern: string): Partial<Observation> {
  try {
    return extractJson(raw) as Partial<Observation>;
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
  constructor(private readonly options: OllamaOptions) {}

  async analyzeImages(images: string[]): Promise<Observation> {
    if (images.length === 0) {
      return { enabled: false, model: this.options.cloudVisionModel, summary: '解析対象の画像がありません。' };
    }

    if (this.options.apiKey) {
      const cloud = await this.tryCloudVision(images);
      if (cloud) return cloud;
    }

    return this.localVision(images);
  }

  async polishReport({ report, fallbackMarkdown }: { report: Report; fallbackMarkdown: string }): Promise<CloudPolishResult> {
    if (!this.options.apiKey || report.capturedFrames === 0) {
      return {
        enabled: false,
        model: this.options.cloudReportModel,
        markdown: fallbackMarkdown,
        summary: 'Ollama Cloud API key未設定または画像なし'
      };
    }

    const prompt = `以下はペット見守りMVPの生ログです。飼い主向けの自然な日本語日報に整えてください。

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
      const data = await this.chatCompletions({
        model: this.options.cloudReportModel,
        messages: [
          { role: 'system', content: 'あなたはペット見守り日報を書くAIです。観察事実をやさしく、ただし断定しすぎず整理します。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1200
      });

      const markdown = data.choices?.[0]?.message?.content?.trim();
      if (!markdown) throw new Error('empty response');
      return { enabled: true, model: this.options.cloudReportModel, markdown };
    } catch (err) {
      return {
        enabled: false,
        model: this.options.cloudReportModel,
        markdown: fallbackMarkdown,
        summary: `Ollama Cloud整形に失敗: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  private async tryCloudVision(images: string[]): Promise<Observation | null> {
    try {
      const content: ChatMessage['content'] = [
        { type: 'text', text: OBSERVATION_PROMPT },
        ...images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${image}` } }))
      ];

      const data = await this.chatCompletions({
        model: this.options.cloudVisionModel,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 1200
      });

      const raw = data.choices?.[0]?.message?.content || '';
      return {
        enabled: true,
        provider: 'ollama-cloud',
        model: this.options.cloudVisionModel,
        framesAnalyzed: images.length,
        raw: String(raw).trim(),
        ...safeObservationParse(raw, 'Visionモデルの返答がJSONではありませんでした')
      };
    } catch (err) {
      console.warn(`cloud vision failed; falling back to local ollama: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async localVision(images: string[]): Promise<Observation> {
    try {
      const response = await fetch(`${this.options.localUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.options.localVisionModel,
          prompt: OBSERVATION_PROMPT,
          images,
          stream: false,
          options: { temperature: 0.2 }
        }),
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const data = (await response.json()) as LocalGenerateResponse;
      const raw = data.response || '';
      return {
        enabled: true,
        provider: 'local-ollama',
        model: this.options.localVisionModel,
        framesAnalyzed: images.length,
        raw: String(raw).trim(),
        ...safeObservationParse(raw, 'Ollamaの返答がJSONではありませんでした')
      };
    } catch (err) {
      return {
        enabled: false,
        model: this.options.localVisionModel,
        summary: `Ollama解析に失敗: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  private async chatCompletions(payload: ChatPayload): Promise<ChatResponse> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${this.options.cloudUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`
          },
          body: JSON.stringify({ ...payload, stream: false }),
          signal: AbortSignal.timeout(120000)
        });

        if (response.ok) return (await response.json()) as ChatResponse;

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
