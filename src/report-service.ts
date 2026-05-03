import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileExists, readJson, writeJson } from './json-store.js';
import { todayJst } from './time.js';
import type { CaptureEvent, Observation, Report } from './types.js';
import type { OllamaClient } from './ollama-client.js';

const NEXT_CHECKS = [
  '水飲み場・ごはん場・トイレなどの注目エリアを指定できるようにする',
  '昨日との差分を出す',
  '夜1回、自動でLINE/Slack/メールに送る'
];

type ReportMetrics = {
  activeFrames: number;
  topActiveHours: Report['topActiveHours'];
  quietPeriods: Report['quietPeriods'];
};

export class ReportService {
  constructor(
    private readonly options: {
      rootDir: string;
      dataDir: string;
      reportsDir: string;
      aiClient: OllamaClient;
    }
  ) {}

  async createReport(date = todayJst(), { useAi = true }: { useAi?: boolean } = {}): Promise<{ report: Report; markdown: string }> {
    const events = await this.readEvents(date);
    const metrics = this.buildMetrics(events);
    const ai: Observation = useAi && events.length > 0
      ? await this.analyzeRepresentativeFrames(events)
      : { enabled: false, summary: 'AI解析は未実行です。' };

    const report = this.buildReport({ date, events, metrics, ai });
    const fallbackMarkdown = this.renderFallbackMarkdown(report);
    const cloud = useAi
      ? await this.options.aiClient.polishReport({ report, fallbackMarkdown })
      : { enabled: false, markdown: fallbackMarkdown };

    report.cloud = {
      enabled: cloud.enabled,
      model: cloud.model,
      summary: cloud.summary || 'ok'
    };

    const markdown = cloud.markdown || fallbackMarkdown;
    await writeJson(path.join(this.options.reportsDir, `${date}.json`), report);
    await fs.writeFile(path.join(this.options.reportsDir, `${date}.md`), markdown);

    return { report, markdown };
  }

  private async readEvents(date: string): Promise<CaptureEvent[]> {
    return readJson<CaptureEvent[]>(path.join(this.options.dataDir, `${date}.events.json`), []);
  }

  private buildMetrics(events: CaptureEvent[]): ReportMetrics {
    const motionEvents = events.filter(event => event.motionScore >= 8);
    const activeByHour = new Map<string, number>();

    for (const event of motionEvents) {
      const hour = event.time.slice(11, 13);
      activeByHour.set(hour, (activeByHour.get(hour) || 0) + 1);
    }

    return {
      activeFrames: motionEvents.length,
      topActiveHours: [...activeByHour.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([hour, count]) => ({ hour: `${hour}:00`, count })),
      quietPeriods: this.findQuietPeriods(events).slice(0, 5)
    };
  }

  private findQuietPeriods(events: CaptureEvent[]): Report['quietPeriods'] {
    const quietPeriods: Report['quietPeriods'] = [];
    let runStart: CaptureEvent | null = null;

    for (const event of events) {
      const quiet = event.motionScore < 3;
      if (quiet && !runStart) runStart = event;
      if (!quiet && runStart) {
        quietPeriods.push({ from: runStart.time, to: event.time });
        runStart = null;
      }
    }

    if (runStart && events.at(-1)) quietPeriods.push({ from: runStart.time, to: events.at(-1)!.time });
    return quietPeriods;
  }

  private async analyzeRepresentativeFrames(events: CaptureEvent[]): Promise<Observation> {
    const images: string[] = [];
    for (const event of pickRepresentativeEvents(events)) {
      const imagePath = path.join(this.options.rootDir, event.file);
      if (await fileExists(imagePath)) {
        images.push((await fs.readFile(imagePath)).toString('base64'));
      }
    }

    if (images.length === 0) {
      return { enabled: false, summary: '保存画像が見つかりません。' };
    }

    return this.options.aiClient.analyzeImages(images);
  }

  private buildReport({ date, events, metrics, ai }: { date: string; events: CaptureEvent[]; metrics: ReportMetrics; ai: Observation }): Report {
    return {
      date,
      capturedFrames: events.length,
      activeFrames: metrics.activeFrames,
      topActiveHours: metrics.topActiveHours,
      quietPeriods: metrics.quietPeriods,
      ai,
      summary: events.length === 0
        ? 'まだキャプチャがありません。スマホで撮影を開始してください。'
        : `今日は${events.length}枚を記録し、そのうち動きが強めだったフレームは${metrics.activeFrames}枚でした。`,
      nextChecks: NEXT_CHECKS
    };
  }

  private renderFallbackMarkdown(report: Report): string {
    return `# ペット日報 ${report.date}\n\n${report.summary}\n\n${renderAiSection(report.ai)}\n## 活動が多かった時間\n${renderActiveHours(report.topActiveHours)}\n\n## 静かだった時間候補\n${renderQuietPeriods(report.quietPeriods)}\n\n## 次に見ること\n${report.nextChecks.map(item => `- ${item}`).join('\n')}\n`;
  }
}

function pickRepresentativeEvents(events: CaptureEvent[]): CaptureEvent[] {
  if (events.length === 0) return [];

  const mostActive = [...events].sort((a, b) => b.motionScore - a.motionScore)[0];
  const picks = [events[0], mostActive, events.at(-1)].filter((event): event is CaptureEvent => Boolean(event));
  const seen = new Set<string>();

  return picks.filter(event => {
    if (seen.has(event.file)) return false;
    seen.add(event.file);
    return true;
  }).slice(0, 3);
}

function renderAiSection(ai: Observation): string {
  if (!ai.enabled) return `## Ollama画像解析\n- ${ai.summary || '未実行'}\n`;

  return `## Ollama画像解析（${ai.model}）\n- ペットが見える: ${ai.petVisible === true ? 'はい' : ai.petVisible === false ? 'いいえ' : '不明'}\n- 場面: ${ai.scene || '不明'}\n- 様子: ${ai.petActivity || '不明'}\n\n### 気になる点\n${renderList(ai.concerns, '特になし/判定困難')}\n\n### 飼い主が確認するとよいこと\n${renderList(ai.ownerChecks, '画角と明るさを確認')}\n`;
}

function renderActiveHours(hours: Report['topActiveHours']): string {
  if (!hours.length) return '- まだ十分な動きデータがありません';
  return hours.map(item => `- ${item.hour}ごろ: ${item.count}回`).join('\n');
}

function renderQuietPeriods(periods: Report['quietPeriods']): string {
  if (!periods.length) return '- まだ判定できません';
  return periods.map(item => `- ${item.from.slice(11, 16)}〜${item.to.slice(11, 16)}`).join('\n');
}

function renderList(items: string[] | undefined, fallback: string): string {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map(item => `- ${item}`).join('\n');
}
