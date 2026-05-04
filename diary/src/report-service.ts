import { promises as fs } from "node:fs";
import path from "node:path";
import { fileExists, readJson, writeJson } from "./json-store.ts";
import { todayJst } from "./time.ts";

type DiaryEvent = Record<string, any>;
type QuietPeriod = { from: string; to: string };

const NEXT_CHECKS = [
  "水飲み場・ごはん場・トイレなどの注目エリアを指定できるようにする",
  "昨日との差分を出す",
  "夜1回、自動でLINE/Slack/メールに送る",
];

export class ReportService {
  rootDir: string;
  dataDir: string;
  reportsDir: string;
  aiClient: any;

  constructor({
    rootDir,
    dataDir,
    reportsDir,
    aiClient,
  }: { rootDir: string; dataDir: string; reportsDir: string; aiClient: any }) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.reportsDir = reportsDir;
    this.aiClient = aiClient;
  }

  async getReport(date = todayJst(), { userId = null as number | null, householdId = userId } = {}) {
    const jsonPath = this.#reportJsonPath(date, householdId);
    const markdownPath = this.#reportMarkdownPath(date, householdId);
    if (!(await fileExists(jsonPath)) || !(await fileExists(markdownPath))) {
      return { exists: false, report: null, markdown: "" };
    }

    return {
      exists: true,
      report: await readJson(jsonPath, null),
      markdown: await fs.readFile(markdownPath, "utf8"),
    };
  }

  async createReport(
    date = todayJst(),
    { useAi = true, userId = null as number | null, householdId = userId, petName = "ペット" } = {},
  ) {
    const events = await this.#readEvents(date, userId, householdId);
    const metrics = this.#buildMetrics(events);
    const ai =
      useAi && events.length > 0
        ? await this.#analyzeRepresentativeFrames(events, petName)
        : { enabled: false, summary: "AI解析は未実行です。" };

    const report: any = this.#buildReport({ date, events, metrics, ai });
    const fallbackMarkdown = this.#renderFallbackMarkdown(report);
    const cloud = useAi
      ? await this.aiClient.polishReport({ report, fallbackMarkdown, petName })
      : { enabled: false, markdown: fallbackMarkdown };

    report.cloud = {
      enabled: cloud.enabled,
      model: cloud.model,
      summary: cloud.summary || "ok",
    };

    const markdown = cloud.markdown || fallbackMarkdown;
    await writeJson(this.#reportJsonPath(date, householdId), report);
    await fs.writeFile(this.#reportMarkdownPath(date, householdId), markdown);

    return { report, markdown };
  }

  async #readEvents(date, userId = null, householdId = userId) {
    const events = await readJson<any[]>(path.join(this.dataDir, `${date}.events.json`), []);
    if (userId == null) return events;
    return events.filter((event) => {
      if (event.householdId != null) return Number(event.householdId) === Number(householdId);
      return Number(event.userId) === Number(userId) || Number(event.userId) === Number(householdId);
    });
  }

  #buildMetrics(events: DiaryEvent[]) {
    const motionEvents = events.filter((event) => event.motionScore >= 8);
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
      quietPeriods: this.#findQuietPeriods(events).slice(0, 5),
    };
  }

  #findQuietPeriods(events: DiaryEvent[]) {
    const quietPeriods: QuietPeriod[] = [];
    let runStart: DiaryEvent | null = null;

    for (const event of events) {
      const quiet = event.motionScore < 3;
      if (quiet && !runStart) runStart = event;
      if (!quiet && runStart) {
        quietPeriods.push({ from: runStart.time, to: event.time });
        runStart = null;
      }
    }

    const lastEvent = events.at(-1);
    if (runStart && lastEvent) quietPeriods.push({ from: runStart.time, to: lastEvent.time });
    return quietPeriods;
  }

  async #analyzeRepresentativeFrames(events: DiaryEvent[], petName: string) {
    const images: string[] = [];
    for (const event of pickRepresentativeEvents(events)) {
      const imagePath = path.join(this.rootDir, event.file);
      if (await fileExists(imagePath)) {
        images.push((await fs.readFile(imagePath)).toString("base64"));
      }
    }

    if (images.length === 0) {
      return { enabled: false, summary: "保存画像が見つかりません。" };
    }

    return this.aiClient.analyzeImages(images, { petName });
  }

  #reportJsonPath(date: string, userId: number | null) {
    return path.join(this.reportsDir, this.#reportFileName(date, userId, "json"));
  }

  #reportMarkdownPath(date: string, userId: number | null) {
    return path.join(this.reportsDir, this.#reportFileName(date, userId, "md"));
  }

  #reportFileName(date: string, userId: number | null, ext: string) {
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
      summary:
        events.length === 0
          ? "まだキャプチャがありません。スマホで撮影を開始してください。"
          : `今日は${events.length}枚を記録し、そのうち動きが強めだったフレームは${metrics.activeFrames}枚でした。`,
      nextChecks: NEXT_CHECKS,
    };
  }

  #renderFallbackMarkdown(report: any) {
    return `# ペット日報 ${report.date}\n\n${report.summary}\n\n${renderAiSection(report.ai)}\n## 活動が多かった時間\n${renderActiveHours(report.topActiveHours)}\n\n## 静かだった時間候補\n${renderQuietPeriods(report.quietPeriods)}\n\n## 次に見ること\n${report.nextChecks.map((item) => `- ${item}`).join("\n")}\n`;
  }
}

function pickRepresentativeEvents(events: DiaryEvent[]) {
  const withFiles = events.filter((event) => event.file);
  if (withFiles.length <= 12) return withFiles;

  const scored = withFiles
    .map((event, index) => ({ event, index, score: reportPhotoScore(event) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const picked: DiaryEvent[] = [];
  const seen = new Set<string>();

  for (const item of scored) {
    if (picked.length >= 8) break;
    picked.push(item.event);
    seen.add(item.event.file);
  }

  for (const event of withFiles.slice(-8).reverse()) {
    if (picked.length >= 12) break;
    if (seen.has(event.file)) continue;
    picked.push(event);
    seen.add(event.file);
  }

  return picked.sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function reportPhotoScore(event) {
  let score = Number(event.motionScore || 0);
  if (event.ai?.petVisible === true) score += 30;
  if (event.activityCategory && event.activityCategory !== "not_visible" && event.activityCategory !== "unknown")
    score += 12;
  if (event.activityCategory === "mischief") score += 40;
  if (event.notify) score += 24;
  if (event.timelineText) score += 8;
  return score;
}

function renderAiSection(ai) {
  if (!ai.enabled) return `## Ollama画像解析\n- ${ai.summary || "未実行"}\n`;

  return `## Ollama画像解析（${ai.model}）\n- ペットが見える: ${ai.petVisible === true ? "はい" : ai.petVisible === false ? "いいえ" : "不明"}\n- 場面: ${ai.scene || "不明"}\n- 様子: ${ai.petActivity || "不明"}\n\n### 気になる点\n${renderList(ai.concerns, "特になし/判定困難")}\n\n### 飼い主が確認するとよいこと\n${renderList(ai.ownerChecks, "画角と明るさを確認")}\n`;
}

function renderActiveHours(hours: { hour: string; count: number }[]) {
  if (!hours.length) return "- まだ十分な動きデータがありません";
  return hours.map((item) => `- ${item.hour}ごろ: ${item.count}回`).join("\n");
}

function renderQuietPeriods(periods: QuietPeriod[]) {
  if (!periods.length) return "- まだ判定できません";
  return periods.map((item) => `- ${item.from.slice(11, 16)}〜${item.to.slice(11, 16)}`).join("\n");
}

function renderList(items: string[], fallback: string) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}
