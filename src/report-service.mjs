import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileExists, readJson, writeJson } from './json-store.mjs';
import { todayJst } from './time.mjs';

const NEXT_CHECKS = [
  '水飲み場・ごはん場・トイレなどの注目エリアを指定できるようにする',
  '昨日との差分を出す',
  '夜1回、自動でLINE/Slack/メールに送る'
];

export class ReportService {
  constructor({ rootDir, dataDir, reportsDir, aiClient }) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.reportsDir = reportsDir;
    this.aiClient = aiClient;
  }

  async getReport(date = todayJst(), { userId = null, householdId = userId } = {}) {
    const jsonPath = this.#reportJsonPath(date, householdId);
    const markdownPath = this.#reportMarkdownPath(date, householdId);
    if (!await fileExists(jsonPath) || !await fileExists(markdownPath)) {
      return { exists: false, report: null, markdown: '' };
    }

    return {
      exists: true,
      report: await readJson(jsonPath, null),
      markdown: await fs.readFile(markdownPath, 'utf8')
    };
  }

  async createReport(date = todayJst(), { useAi = true, userId = null, householdId = userId, petName = 'ペット' } = {}) {
    const events = await this.#readEvents(date, userId, householdId);
    const metrics = this.#buildMetrics(events);
    const ai = useAi && events.length > 0
      ? await this.#analyzeRepresentativeFrames(events, petName)
      : { enabled: false, summary: 'AI解析は未実行です。' };

    const report = this.#buildReport({ date, events, metrics, ai });
    const fallbackMarkdown = this.#renderFallbackMarkdown(report);
    const cloud = useAi
      ? await this.aiClient.polishReport({ report, fallbackMarkdown, petName })
      : { enabled: false, markdown: fallbackMarkdown };

    report.cloud = {
      enabled: cloud.enabled,
      model: cloud.model,
      summary: cloud.summary || 'ok'
    };

    const markdown = cloud.markdown || fallbackMarkdown;
    await writeJson(this.#reportJsonPath(date, householdId), report);
    await fs.writeFile(this.#reportMarkdownPath(date, householdId), markdown);

    return { report, markdown };
  }

  async #readEvents(date, userId = null, householdId = userId) {
    const events = await readJson(path.join(this.dataDir, `${date}.events.json`), []);
    if (userId == null) return events;
    return events.filter(event => {
      if (event.householdId != null) return Number(event.householdId) === Number(householdId);
      return Number(event.userId) === Number(userId) || Number(event.userId) === Number(householdId);
    });
  }

  #buildMetrics(events) {
    const motionEvents = events.filter(event => event.motionScore >= 8);
    const activeByHour = new Map();

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
      quietPeriods: this.#findQuietPeriods(events).slice(0, 5)
    };
  }

  #findQuietPeriods(events) {
    const quietPeriods = [];
    let runStart = null;

    for (const event of events) {
      const quiet = event.motionScore < 3;
      if (quiet && !runStart) runStart = event;
      if (!quiet && runStart) {
        quietPeriods.push({ from: runStart.time, to: event.time });
        runStart = null;
      }
    }

    if (runStart && events.at(-1)) quietPeriods.push({ from: runStart.time, to: events.at(-1).time });
    return quietPeriods;
  }

  async #analyzeRepresentativeFrames(events, petName) {
    const images = [];
    for (const event of pickRepresentativeEvents(events)) {
      const imagePath = path.join(this.rootDir, event.file);
      if (await fileExists(imagePath)) {
        images.push((await fs.readFile(imagePath)).toString('base64'));
      }
    }

    if (images.length === 0) {
      return { enabled: false, summary: '保存画像が見つかりません。' };
    }

    return this.aiClient.analyzeImages(images, { petName });
  }

  #reportJsonPath(date, userId) {
    return path.join(this.reportsDir, this.#reportFileName(date, userId, 'json'));
  }

  #reportMarkdownPath(date, userId) {
    return path.join(this.reportsDir, this.#reportFileName(date, userId, 'md'));
  }

  #reportFileName(date, userId, ext) {
    return userId == null ? `${date}.${ext}` : `${date}.user-${userId}.${ext}`;
  }

  #buildReport({ date, events, metrics, ai }) {
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

  #renderFallbackMarkdown(report) {
    return `# ペット日報 ${report.date}\n\n${report.summary}\n\n${renderAiSection(report.ai)}\n## 活動が多かった時間\n${renderActiveHours(report.topActiveHours)}\n\n## 静かだった時間候補\n${renderQuietPeriods(report.quietPeriods)}\n\n## 次に見ること\n${report.nextChecks.map(item => `- ${item}`).join('\n')}\n`;
  }
}

function pickRepresentativeEvents(events) {
  return events;
}

function renderAiSection(ai) {
  if (!ai.enabled) return `## Ollama画像解析\n- ${ai.summary || '未実行'}\n`;

  return `## Ollama画像解析（${ai.model}）\n- ペットが見える: ${ai.petVisible === true ? 'はい' : ai.petVisible === false ? 'いいえ' : '不明'}\n- 場面: ${ai.scene || '不明'}\n- 様子: ${ai.petActivity || '不明'}\n\n### 気になる点\n${renderList(ai.concerns, '特になし/判定困難')}\n\n### 飼い主が確認するとよいこと\n${renderList(ai.ownerChecks, '画角と明るさを確認')}\n`;
}

function renderActiveHours(hours) {
  if (!hours.length) return '- まだ十分な動きデータがありません';
  return hours.map(item => `- ${item.hour}ごろ: ${item.count}回`).join('\n');
}

function renderQuietPeriods(periods) {
  if (!periods.length) return '- まだ判定できません';
  return periods.map(item => `- ${item.from.slice(11, 16)}〜${item.to.slice(11, 16)}`).join('\n');
}

function renderList(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map(item => `- ${item}`).join('\n');
}
