import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson } from "./json-store.ts";
import { ReportService } from "./report-service.ts";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

async function newReportService(aiClient: any) {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-report-"));
  const dataDir = path.join(tempDir, "data");
  const reportsDir = path.join(dataDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  return {
    dataDir,
    reportsDir,
    service: new ReportService({ rootDir: tempDir, dataDir, reportsDir, aiClient }),
  };
}

describe("ReportService", () => {
  test("creates a household-scoped fallback report and persists it", async () => {
    const aiCalls: any[] = [];
    const { dataDir, reportsDir, service } = await newReportService({
      analyzeImages: async () => ({ enabled: false, summary: "保存画像が見つかりません。" }),
      polishReport: async (input: any) => {
        aiCalls.push(input);
        return { enabled: false, markdown: input.fallbackMarkdown, summary: "fallback" };
      },
    });
    await writeJson(path.join(dataDir, "2026-05-05.events.json"), [
      { time: "2026-05-05T10-00-00", userId: 1, householdId: 10, motionScore: 12, file: "data/frames/a.jpg" },
      { time: "2026-05-05T11-00-00", userId: 2, householdId: 99, motionScore: 20, file: "data/frames/b.jpg" },
    ]);

    const result = await service.createReport("2026-05-05", { userId: 1, householdId: 10, petName: "ポテト" });

    expect(result.report.capturedFrames).toBe(1);
    expect(result.report.activeFrames).toBe(1);
    expect(result.markdown).toContain("今日は1枚を記録");
    expect(aiCalls[0].petName).toBe("ポテト");
    expect(await readFile(path.join(reportsDir, "2026-05-05.user-10.md"), "utf8")).toBe(result.markdown);
    expect(await service.getReport("2026-05-05", { userId: 1, householdId: 10 })).toMatchObject({ exists: true });
  });

  test("uses representative frame images when files exist", async () => {
    let analyzedImages: string[] = [];
    const { dataDir, service } = await newReportService({
      analyzeImages: async (images: string[]) => {
        analyzedImages = images;
        return { enabled: true, model: "vision", petVisible: true, summary: "ok" };
      },
      polishReport: async (input: any) => ({ enabled: true, model: "report", markdown: input.fallbackMarkdown }),
    });
    await mkdir(path.join(tempDir, "data", "frames"), { recursive: true });
    await writeFile(path.join(tempDir, "data", "frames", "one.jpg"), Buffer.from([1, 2, 3]));
    await writeJson(path.join(dataDir, "2026-05-05.events.json"), [
      { time: "2026-05-05T10-00-00", userId: 1, householdId: 10, motionScore: 8, file: "data/frames/one.jpg" },
    ]);

    await service.createReport("2026-05-05", { userId: 1, householdId: 10, petName: "ポテト" });

    expect(analyzedImages).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
  });

  test("does not call AI when useAi is false", async () => {
    const { dataDir, service } = await newReportService({
      analyzeImages: async () => {
        throw new Error("should not analyze");
      },
      polishReport: async () => {
        throw new Error("should not polish");
      },
    });
    await writeJson(path.join(dataDir, "2026-05-05.events.json"), [
      { time: "2026-05-05T10-00-00", userId: 1, householdId: 10, motionScore: 8 },
    ]);

    const result = await service.createReport("2026-05-05", { useAi: false, userId: 1, householdId: 10 });

    expect(result.report.ai).toMatchObject({ enabled: false, summary: "AI解析は未実行です。" });
  });
});
