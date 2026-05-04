import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";

let tempDir = "";
let app: Hono<any>;
let sessionCookie = "";
let householdId = 0;

const appOrigin = "https://diary.pochimo.com";
const marketingOrigin = "https://pochimo.com";

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-api-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = path.join(tempDir, "data");
  process.env.SETUP_TOKEN = "integration-token";
  process.env.PUBLIC_APP_ORIGIN = appOrigin;
  process.env.PUBLIC_MARKETING_ORIGIN = marketingOrigin;
  process.env.OLLAMA_API_KEY = "";
  process.env.OLLAMA_URL = "http://127.0.0.1:1";

  ({ app } = await import(`./server.ts?integration=${Date.now()}`));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function request(pathname: string, init: RequestInit = {}) {
  return app.request(`http://localhost${pathname}`, init);
}

function jsonRequest(pathname: string, body: unknown, init: RequestInit = {}) {
  return request(pathname, {
    method: init.method || "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      origin: appOrigin,
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...init.headers,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response) {
  return (await res.json()) as any;
}

function tinyJpegDataUrl() {
  return `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;
}

describe("server HTTP integration", () => {
  test("health and auth state are public", async () => {
    const health = await request("/api/health");
    const authState = await request("/api/auth/state");

    expect(health.status).toBe(200);
    expect(await readJson(health)).toMatchObject({ ok: true });
    expect(authState.status).toBe(200);
    expect(await readJson(authState)).toMatchObject({ ok: true, hasUsers: false, user: null });
  });

  test("mutating requests require a valid Origin", async () => {
    const missingOrigin = await request("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner@example.com", password: "password123", setupToken: "integration-token" }),
    });
    const badOrigin = await jsonRequest(
      "/api/auth/setup",
      { username: "owner@example.com", password: "password123", setupToken: "integration-token" },
      { headers: { origin: "https://evil.example" } },
    );

    expect(missingOrigin.status).toBe(403);
    expect(await readJson(missingOrigin)).toMatchObject({ ok: false, error: "invalid request origin" });
    expect(badOrigin.status).toBe(403);
  });

  test("setup requires setup token before bootstrap", async () => {
    const res = await jsonRequest("/api/auth/setup", { username: "owner@example.com", password: "password123" });

    expect(res.status).toBe(500);
    expect(await readJson(res)).toMatchObject({ ok: false, error: "invalid setup token" });
  });

  test("setup creates session and profile guard blocks app APIs until pet name is set", async () => {
    const setup = await jsonRequest("/api/auth/setup", {
      username: "owner@example.com",
      password: "password123",
      setupToken: "integration-token",
    });
    sessionCookie = setup.headers.get("set-cookie") || "";
    const body = await readJson(setup);
    householdId = body.user.householdId;

    const events = await request("/api/events", { headers: { cookie: sessionCookie } });

    expect(setup.status).toBe(200);
    expect(sessionCookie).toContain("pet_session=");
    expect(events.status).toBe(400);
    expect(await readJson(events)).toMatchObject({ ok: false, error: "pet name is required" });
  });

  test("profile setup unlocks authenticated capture/events/latest/report routes", async () => {
    const profile = await jsonRequest("/api/profile", { name: "ポテト", photo: "" });
    const capture = await jsonRequest("/api/capture", {
      image: tinyJpegDataUrl(),
      motionScore: 15,
      cameraId: "living",
      cameraLabel: "リビング",
    });
    const events = await request("/api/events", { headers: { cookie: sessionCookie } });
    const latest = await request("/api/latest", { headers: { cookie: sessionCookie } });
    const report = await request("/api/report", { headers: { cookie: sessionCookie } });

    expect(profile.status).toBe(200);
    expect(await readJson(profile)).toMatchObject({ ok: true, profile: { name: "ポテト" } });
    expect(capture.status).toBe(200);
    expect(await readJson(capture)).toMatchObject({ ok: true, count: 1, event: { householdId, cameraId: "living" } });
    expect(events.status).toBe(200);
    expect(await readJson(events)).toHaveLength(1);
    expect(latest.status).toBe(200);
    expect((await readJson(latest)).imageUrl).toContain("/data/frames/");
    expect(report.status).toBe(200);
    expect(await readJson(report)).toMatchObject({ ok: true, exists: false, markdown: "" });
  });

  test("frame route denies traversal and only serves household-owned images", async () => {
    const events = await readJson(await request("/api/events", { headers: { cookie: sessionCookie } }));
    const framePath = `/${events[0].file}`;

    const frame = await request(framePath, { headers: { cookie: sessionCookie } });
    const traversal = await request("/data/frames/%2e%2e/%2e%2e/auth.sqlite", { headers: { cookie: sessionCookie } });

    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toContain("image/jpeg");
    expect([403, 404]).toContain(traversal.status);
  });

  test("auth login rate limit returns 429", async () => {
    let last: Response | null = null;
    for (let index = 0; index < 9; index += 1) {
      last = await jsonRequest("/api/auth/login", { username: "owner@example.com", password: "wrongpass" });
    }

    expect(last?.status).toBe(429);
    expect(await readJson(last as Response)).toMatchObject({ ok: false, error: "too many requests" });
  });
});
