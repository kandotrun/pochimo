import { afterEach, describe, expect, test } from "bun:test";
import { OllamaClient } from "./ollama-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function newClient(overrides: Partial<ConstructorParameters<typeof OllamaClient>[0]> = {}) {
  return new OllamaClient({
    localUrl: "http://local.test",
    localVisionModel: "local-vision",
    cloudUrl: "http://cloud.test/v1",
    cloudVisionModel: "cloud-vision",
    cloudReportModel: "cloud-report",
    apiKey: "api-key",
    ...overrides,
  });
}

describe("OllamaClient", () => {
  test("polishReport returns fallback when cloud markdown is incomplete", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "# 今日の様子\n未完" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const fallbackMarkdown = "# fallback";

    const result = await newClient().polishReport({
      report: { capturedFrames: 1 },
      fallbackMarkdown,
      petName: "ポテト",
    });

    expect(result.enabled).toBe(false);
    expect(result.markdown).toBe(fallbackMarkdown);
    expect(result.summary).toContain("Ollama Cloud整形に失敗");
  });

  test("createTimeline normalizes LLM times to nearest existing event", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      startTime: "2026-05-05T10-04-00",
                      endTime: "2026-05-05T10-04-00",
                      category: "play",
                      label: "遊んでいる",
                      title: "ポテトが遊んでいました。",
                      detail: "",
                      importance: "normal",
                      notify: false,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await newClient().createTimeline({
      petName: "ポテト",
      events: [
        { time: "2026-05-05T10-00-00", activityCategory: "rest", motionScore: 1 },
        { time: "2026-05-05T10-05-00", activityCategory: "play", motionScore: 20 },
      ],
    });

    expect(result.enabled).toBe(true);
    expect(result.items[0]).toMatchObject({
      startTime: "2026-05-05T10-05-00",
      timelineText: "ポテトが遊んでいました。",
      activityCategory: "play",
    });
  });

  test("createTimeline falls back when cloud returns invalid JSON", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await newClient().createTimeline({
      petName: "ポテト",
      events: [
        {
          time: "2026-05-05T10-00-00",
          activityCategory: "mischief",
          notify: true,
          notificationText: "ポテトがいたずらしています。",
        },
      ],
    });

    expect(result.enabled).toBe(false);
    expect(result.items[0].title).toContain("ポテト");
  });

  test("analyzeImages falls back to local vision when cloud fails", async () => {
    let calls = 0;
    globalThis.fetch = (async (url) => {
      calls += 1;
      if (String(url).startsWith("http://cloud.test")) return new Response("bad", { status: 400 });
      return new Response(
        JSON.stringify({
          response: JSON.stringify({
            petVisible: true,
            scene: "ケージの中にポテトがいます。",
            petActivity: "休んでいます。",
          }),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await newClient().analyzeImages([Buffer.from("jpg").toString("base64")], { petName: "ポテト" });

    expect(calls).toBeGreaterThan(1);
    expect(result).toMatchObject({ enabled: true, provider: "local-ollama", petVisible: true });
  });

  test("chatTimeline returns bounded fallback without API key", async () => {
    const result = await newClient({ apiKey: "" }).chatTimeline({
      petName: "ポテト",
      prompt: "夕方どうだった？",
      events: Array.from({ length: 12 }, (_, index) => ({
        time: `2026-05-05T10-${String(index).padStart(2, "0")}-00`,
        activityCategory: "rest",
        ai: { petVisible: true, scene: "床の上にポテトがいます。" },
      })),
    });

    expect(result.enabled).toBe(false);
    expect(result.reply).toBe("今日はまだ答えられる記録がありません。");
    expect(result.items.length).toBeGreaterThan(0);
  });
});
