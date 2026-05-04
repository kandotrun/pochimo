import { promises as fs } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AbService } from "./src/ab-service.ts";
import { AuthService, clearSessionCookie, sessionCookie } from "./src/auth-service.ts";
import { config, paths } from "./src/config.ts";
import { FrameService } from "./src/frame-service.ts";
import { ensureDir, readJson, writeJson } from "./src/json-store.ts";
import { mailService } from "./src/mail-service.ts";
import { OllamaClient } from "./src/ollama-client.ts";
import { ReportService } from "./src/report-service.ts";
import { todayJst } from "./src/time.ts";

type User = { id: number; username: string; householdId?: number };
type AppBindings = { Variables: { user: User | null } };
type RateLimitEntry = { count: number; resetAt: number };

await ensureDir(paths.framesDir);
await ensureDir(paths.reportsDir);

const authService = new AuthService({ dataDir: config.dataDir });
const abService = new AbService({ dataDir: config.dataDir });
const aiClient = new OllamaClient(config.ollama);
const timelineCache = new Map<string, any>();
const rateLimits = new Map<string, RateLimitEntry>();
const frameService = new FrameService({ dataDir: config.dataDir, framesDir: paths.framesDir });
const reportService = new ReportService({
  rootDir: config.rootDir,
  dataDir: config.dataDir,
  reportsDir: paths.reportsDir,
  aiClient,
});

if (process.env.NODE_ENV !== "test") startDailyReportScheduler();

export const app = new Hono<AppBindings>();

app.onError((err, c) => {
  const status =
    err.message === "too many requests"
      ? 429
      : err.message === "invalid request origin"
        ? 403
        : err.message === "authentication required"
          ? 401
          : 500;
  return c.json({ ok: false, error: err.message }, status as 500);
});

app.use("*", async (c, next) => {
  verifyRequestOrigin(c.req.raw);
  const cookies = parseCookieHeader(c.req.header("cookie"));
  const user = authService.getUserByToken(cookies.pet_session) as User | null;
  c.set("user", user);
  await next();
});

app.options("*", (c) => c.body(null, 204));

app.get("/api/health", (c) => c.json({ ok: true, date: todayJst() }));

app.get("/api/auth/state", (c) => c.json({ ok: true, hasUsers: authService.hasUsers(), user: c.get("user") }));

app.get("/api/ab/summary", async (c) => c.json({ ok: true, ...(await abService.summary()) }));

app.post("/api/ab/conversion", async (c) => {
  enforceRateLimit(`ab-conversion:ip:${getClientIp(c.req.raw)}`, 120, 15 * 60 * 1000);
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  return c.json(await abService.recordConversion(body.variant));
});

app.get("/", async (c) => {
  if (isMarketingHome(c.req.raw, "/")) return serveLp(c.req.raw);
  return requireUserOrRedirect(c, async () => serveStatic(config.publicDir, "/"));
});

app.get("/lp", (c) => serveLp(c.req.raw));
app.get("/lp.html", (c) => serveLp(c.req.raw));

app.post("/api/auth/setup", async (c) => {
  const ip = getClientIp(c.req.raw);
  enforceRateLimit(`setup:ip:${ip}`, 5, 60 * 60 * 1000);
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  verifySetupToken(body.setupToken || c.req.header("x-setup-token"));
  const created = authService.createFirstUser(body);
  const session = authService.login({ username: created.username, password: body.password });
  c.header("set-cookie", sessionCookie(session.token, session.expiresAt));
  return c.json({ ok: true, user: session.user });
});

app.post("/api/auth/register", async (c) => {
  const ip = getClientIp(c.req.raw);
  enforceRateLimit(`register:ip:${ip}`, 20, 60 * 60 * 1000);
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  const created = authService.createUserWithInvite(body);
  const session = authService.login({ username: created.username, password: body.password });
  c.header("set-cookie", sessionCookie(session.token, session.expiresAt));
  return c.json({ ok: true, user: session.user });
});

app.post("/api/auth/login", async (c) => {
  const ip = getClientIp(c.req.raw);
  enforceRateLimit(`password-login:ip:${ip}`, 20, 15 * 60 * 1000);
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  enforceRateLimit(
    `password-login:user:${String(body.username || "")
      .trim()
      .toLowerCase()}`,
    8,
    15 * 60 * 1000,
  );
  const session = authService.login(body);
  c.header("set-cookie", sessionCookie(session.token, session.expiresAt));
  return c.json({ ok: true, user: session.user });
});

app.post("/api/auth/email/start", async (c) => {
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  verifySetupToken(body.setupToken || c.req.header("x-setup-token"));
  const ip = getClientIp(c.req.raw);
  const emailKey = String(body.email || "")
    .trim()
    .toLowerCase();
  enforceRateLimit(`email-start:ip:${ip}`, 30, 15 * 60 * 1000);
  enforceRateLimit(`email-start:email:${emailKey}`, 5, 15 * 60 * 1000);
  const loginCode = authService.createEmailLoginCode(body);
  if (!("skipped" in loginCode) || !loginCode.skipped) await sendLoginCodeMail(loginCode);
  return c.json({ ok: true, email: loginCode.email, expiresAt: loginCode.expiresAt });
});

app.post("/api/auth/email/verify", async (c) => {
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  verifySetupToken(body.setupToken || c.req.header("x-setup-token"));
  const ip = getClientIp(c.req.raw);
  const emailKey = String(body.email || "")
    .trim()
    .toLowerCase();
  enforceRateLimit(`email-verify:ip:${ip}`, 60, 15 * 60 * 1000);
  enforceRateLimit(`email-verify:email:${emailKey}`, 10, 15 * 60 * 1000);
  const session = authService.verifyEmailLoginCode(body);
  c.header("set-cookie", sessionCookie(session.token, session.expiresAt));
  return c.json({ ok: true, user: session.user });
});

app.post("/api/auth/logout", (c) => {
  const cookies = parseCookieHeader(c.req.header("cookie"));
  authService.logout(cookies.pet_session);
  c.header("set-cookie", clearSessionCookie());
  return c.json({ ok: true });
});

app.use("*", async (c, next) => {
  const user = c.get("user");
  const pathname = new URL(c.req.url).pathname;
  if (!isPublicPath(pathname) && !user) {
    if (pathname.startsWith("/api/")) return c.json({ ok: false, error: "authentication required" }, 401);
    return c.redirect("/login");
  }
  if (user && pathname === "/login") return c.redirect("/viewer");

  const petProfile = user ? authService.getPetProfile(user.id, user.householdId) : null;
  const hasPetName = Boolean(petProfile?.name?.trim());
  if (user && !hasPetName && !isProfileSetupPath(pathname)) {
    if (pathname.startsWith("/api/")) return c.json({ ok: false, error: "pet name is required" }, 400);
    return c.redirect("/settings");
  }
  await next();
});

app.get("/api/profile", (c) => {
  const user = requireUser(c.get("user"));
  return c.json({ ok: true, profile: authService.getPetProfile(user.id, user.householdId) });
});

app.get("/api/settings", (c) => {
  const user = requireUser(c.get("user"));
  return c.json({ ok: true, settings: authService.getHouseholdSettings(user.householdId || user.id) });
});

app.post("/api/settings", async (c) => {
  const user = requireUser(c.get("user"));
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  return c.json({ ok: true, settings: authService.saveHouseholdSettings(user.householdId || user.id, body) });
});

app.get("/api/invites", (c) => {
  const user = requireUser(c.get("user"));
  return c.json({ ok: true, invites: authService.listInvites(user.id) });
});

app.post("/api/invites", (c) => {
  const user = requireUser(c.get("user"));
  return c.json({ ok: true, invite: authService.createInvite(user.id) });
});

app.post("/api/profile", async (c) => {
  const user = requireUser(c.get("user"));
  const body = await parseJsonBody(c.req.raw, 3 * 1024 * 1024);
  return c.json({ ok: true, profile: authService.savePetProfile(user.id, body, user.householdId) });
});

app.post("/api/capture", async (c) => {
  const user = requireUser(c.get("user"));
  const petProfile = authService.getPetProfile(user.id, user.householdId);
  enforceRateLimit(`capture:user:${user.id}`, 240, 15 * 60 * 1000);
  const body = await parseJsonBody(c.req.raw, 8 * 1024 * 1024);
  const result = await frameService.saveCapture(body, user.id, user.householdId);
  analyzeEventInBackground(result.event, body.image, petProfile.name);
  return c.json({ ok: true, ...result });
});

app.get("/api/events", async (c) => {
  const user = requireUser(c.get("user"));
  const date = validateDateParam(c.req.query("date") || todayJst());
  return c.json(await frameService.listEvents(date, user.id, user.householdId));
});

app.get("/api/timeline", async (c) => {
  const user = requireUser(c.get("user"));
  const date = validateDateParam(c.req.query("date") || todayJst());
  const events = await frameService.listEvents(date, user.id, user.householdId);
  const profile = authService.getPetProfile(user.id, user.householdId);
  const timeline = await getCachedTimeline({ date, user, events, petName: profile.name || "ペット" });
  return c.json({ ok: true, ...timeline });
});

app.post("/api/timeline/chat", async (c) => {
  const user = requireUser(c.get("user"));
  enforceRateLimit(`timeline-chat:user:${user.id}`, 40, 15 * 60 * 1000);
  const body = await parseJsonBody(c.req.raw, 32 * 1024);
  const date = validateDateParam(body.date || todayJst());
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return c.json({ ok: false, error: "prompt is required" }, 400);
  const events = await frameService.listEvents(date, user.id, user.householdId);
  const profile = authService.getPetProfile(user.id, user.householdId);
  const result = await aiClient.chatTimeline({ events, prompt, petName: profile.name || "ペット" });
  return c.json({ ok: true, ...enrichTimelineWithImages(result, events) });
});

app.get("/api/latest", async (c) => {
  const user = requireUser(c.get("user"));
  const date = validateDateParam(c.req.query("date") || todayJst());
  const events = await frameService.listEvents(date, user.id, user.householdId);
  const latest = [...events].reverse().find((event: any) => event.file);
  return c.json(
    latest ? { ok: true, event: latest, imageUrl: `/${latest.file}` } : { ok: true, event: null, imageUrl: null },
  );
});

app.get("/data/frames/*", async (c) => {
  const user = requireUser(c.get("user"));
  return serveFrame(new URL(c.req.url).pathname, user.id, user.householdId);
});

app.get("/api/report", async (c) => {
  const user = requireUser(c.get("user"));
  const date = validateDateParam(c.req.query("date") || todayJst());
  const saved = await reportService.getReport(date, { userId: user.id, householdId: user.householdId });
  return c.json({ ok: true, ...saved });
});

app.get("*", (c) => serveStatic(config.publicDir, new URL(c.req.url).pathname));

async function parseJsonBody(req: Request, limitBytes: number) {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > limitBytes) throw new Error("payload too large");
  return JSON.parse(text || "{}");
}

function requireUser(user: User | null): User {
  if (!user) throw new Error("authentication required");
  return user;
}

async function requireUserOrRedirect(c: any, handler: () => Promise<Response>) {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  return handler();
}

async function serveLp(req: Request) {
  const cookies = parseCookieHeader(req.headers.get("cookie") || "");
  const { variant, shouldSetCookie } = await abService.chooseVariant(cookies);
  let html = await fs.readFile(path.join(config.publicDir, "lp.html"), "utf8");
  html = html
    .replaceAll("__AB_VARIANT__", variant.id)
    .replaceAll("__AB_IMAGE__", variant.image)
    .replaceAll("__OG_IMAGE__", variant.ogImage)
    .replaceAll("__MARKETING_ORIGIN__", config.marketingOrigin)
    .replaceAll("__APP_ORIGIN__", config.appOrigin);
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  if (shouldSetCookie)
    headers["set-cookie"] = `ab_lp_visual=${variant.id}; Path=/; Max-Age=${60 * 60 * 24 * 90}; SameSite=Lax`;
  return new Response(html, { status: 200, headers });
}

async function analyzeEventInBackground(event: any, imageDataUrl: string, petName = "ペット") {
  if (!imageDataUrl?.startsWith("data:image/jpeg;base64,")) return;

  const date = event.time.slice(0, 10);
  const base64 = imageDataUrl.split(",")[1];

  frameService.updateEvent(date, event.time, { aiStatus: "analyzing" }).catch(() => {});

  queueMicrotask(async () => {
    try {
      const ai = await aiClient.analyzeImages([base64], { petName });
      const patch = {
        aiStatus: ai.enabled ? "done" : "failed",
        ai,
        activityCategory: ai.activityCategory || "unknown",
        activityLabel: ai.activityLabel || categoryLabel(ai.activityCategory),
        notify: Boolean(ai.notify),
        notificationText: ai.notificationText || "",
        timelineText: buildTimelineText(ai, event.motionScore, petName),
      };
      const updated = await frameService.updateEvent(date, event.time, patch);
      await notifyImportantEventByEmail(updated, petName).catch(async (err: Error) => {
        console.warn(`event mail failed: ${err.message}`);
        await frameService
          .updateEvent(date, event.time, {
            notificationStatus: "failed",
            notificationError: err.message,
          })
          .catch(() => {});
      });
    } catch (err: any) {
      await frameService
        .updateEvent(date, event.time, {
          aiStatus: "failed",
          timelineText: `解析失敗: ${err.message}`,
        })
        .catch(() => {});
    }
  });
}

async function getCachedTimeline({
  date,
  user,
  events,
  petName,
}: {
  date: string;
  user: User;
  events: any[];
  petName: string;
}) {
  const householdId = user.householdId || user.id;
  const signature = buildTimelineSignature(events);
  const cacheKey = `${householdId}:${date}`;
  const cached = timelineCache.get(cacheKey);
  if (cached?.signature === signature && cached.result) return cached.result;
  if (cached?.signature === signature && cached.promise) return cached.promise;

  const promise = aiClient
    .createTimeline({ events, petName })
    .then((result: any) => {
      const enriched = enrichTimelineWithImages(result, events);
      timelineCache.set(cacheKey, { signature, result: enriched, createdAt: Date.now() });
      return enriched;
    })
    .catch((err: Error) => {
      timelineCache.delete(cacheKey);
      throw err;
    });

  timelineCache.set(cacheKey, { signature, promise, createdAt: Date.now() });
  return promise;
}

function enrichTimelineWithImages(timeline: any, events: any[]) {
  const items = (timeline.items || []).map((item: any) => {
    const event = findTimelinePhotoEvent(item, events);
    return {
      ...item,
      imageUrl: event?.file ? `/${event.file}` : "",
      imageTime: event?.time || "",
      petBox: event?.ai?.petBox || event?.petBox || null,
      petVisible: event?.ai?.petVisible === true,
    };
  });
  return { ...timeline, items };
}

function findTimelinePhotoEvent(item: any, events: any[]) {
  const withFiles = events.filter((event) => event.file);
  if (!withFiles.length) return null;

  const start = parseTimelineTime(item.startTime || item.time);
  const end = parseTimelineTime(item.endTime || item.time || item.startTime);
  const inRange = withFiles.filter((event) => {
    const time = parseTimelineTime(event.time);
    return time >= start && time <= end;
  });
  const candidates = inRange.length ? inRange : withFiles;
  return candidates.reduce(
    (best, event) => {
      const score = timelinePhotoScore(event, item);
      return score > best.score ? { event, score } : best;
    },
    { event: candidates[0], score: -Infinity },
  ).event;
}

function timelinePhotoScore(event: any, item: any) {
  let score = Number(event.motionScore || 0);
  if (event.ai?.petVisible === true) score += 40;
  if ((event.activityCategory || event.ai?.activityCategory) === item.activityCategory) score += 18;
  if (event.notify) score += 24;
  if (event.timelineText) score += 6;
  return score;
}

function parseTimelineTime(time: string) {
  const normalized = String(time || "").replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTimelineSignature(events: any[]) {
  return events
    .map((event) =>
      [
        event.time,
        event.aiStatus || "",
        event.activityCategory || "",
        event.activityLabel || "",
        event.notify ? "1" : "0",
        event.timelineText || "",
      ].join("|"),
    )
    .join("\n");
}

async function notifyImportantEventByEmail(event: any, petName = "ペット") {
  if (!shouldSendEventMail(event)) return;
  const cooldown = await checkEventMailCooldown(event);
  if (!cooldown.allowed) {
    await frameService.updateEvent(event.time.slice(0, 10), event.time, {
      notificationStatus: "skipped",
      notificationSkippedReason: cooldown.reason,
    });
    return;
  }
  const settings = authService.getHouseholdSettings(event.householdId || event.userId);
  if (event.activityCategory === "mischief" && !settings.mischiefEmailEnabled) {
    await frameService.updateEvent(event.time.slice(0, 10), event.time, {
      notificationStatus: "skipped",
      notificationSkippedReason: "mischief_email_disabled",
    });
    return;
  }

  const recipients = authService
    .listHouseholdUsers(event.householdId || event.userId)
    .map((user: any) => user.username)
    .filter(isEmailAddress);
  if (!recipients.length) return;

  const imagePath = path.join(config.rootDir, event.file);
  const imageBase64 = await fs.readFile(imagePath, "base64");
  const label = event.activityLabel || categoryLabel(event.activityCategory) || "通知";
  const message = event.notificationText || event.timelineText || `${petName}の様子を確認してください。`;
  const timeLabel = event.time.replace("T", " ");

  const result = await mailService.sendMail({
    to: recipients,
    subject: `ぽちも日報: ${label}`,
    text: `${message}\n\n撮影時刻: ${timeLabel}\n写真を添付しています。`,
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif; line-height: 1.7; color: #18181b;">
        <p style="margin: 0 0 8px; color: #166534; font-weight: 800;">ぽちも日報</p>
        <h1 style="font-size: 22px; margin: 0 0 12px;">${escapeHtml(label)}</h1>
        <p>${escapeHtml(message)}</p>
        <p style="color: #71717a; font-size: 13px;">撮影時刻: ${escapeHtml(timeLabel)}</p>
        <p>写真を添付しています。</p>
      </div>
    `,
    attachments: [{ filename: `pochimo-${event.time}.jpg`, content: imageBase64 }],
    tags: [{ name: "type", value: "event_alert" }],
  });

  await frameService.updateEvent(event.time.slice(0, 10), event.time, {
    notificationStatus: result.skipped ? "skipped" : "sent",
    notificationSentAt: new Date().toISOString(),
    notificationRecipients: recipients,
  });
  if (!result.skipped) await markEventMailSent(event);
}

async function checkEventMailCooldown(event: any) {
  const state = await readJson<Record<string, { sentAt?: string; eventTime?: string }>>(eventMailStatePath(), {});
  const category = event.activityCategory || event.ai?.activityCategory || "unknown";
  const key = `${event.householdId || event.userId}:${category}`;
  const lastSentAt = Date.parse(state[key]?.sentAt || "");
  const cooldownMs = category === "mischief" ? 30 * 60 * 1000 : 60 * 60 * 1000;
  if (Number.isFinite(lastSentAt) && Date.now() - lastSentAt < cooldownMs) {
    return { allowed: false, reason: `${category}_email_cooldown` };
  }
  return { allowed: true };
}

async function markEventMailSent(event: any) {
  const file = eventMailStatePath();
  const state = await readJson<Record<string, { sentAt?: string; eventTime?: string }>>(file, {});
  const category = event.activityCategory || event.ai?.activityCategory || "unknown";
  const key = `${event.householdId || event.userId}:${category}`;
  state[key] = { sentAt: new Date().toISOString(), eventTime: event.time };
  await writeJson(file, state);
}

function eventMailStatePath() {
  return path.join(paths.reportsDir, "event-mail-state.json");
}

function shouldSendEventMail(event: any) {
  if (event.notificationStatus === "sent") return false;
  if (!event.file) return false;
  const category = event.activityCategory || event.ai?.activityCategory || "";
  if (
    ["not_visible", "unknown", "rest", "sleep", "eat", "drink", "toilet", "moving", "near_owner", "play"].includes(
      category,
    )
  )
    return false;
  return category === "mischief" || (Boolean(event.notify) && event.ai?.petVisible === true);
}

function isEmailAddress(value: unknown) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendLoginCodeMail({ email, code }: { email: string; code: string }) {
  await mailService.sendMail({
    to: email,
    subject: "ぽちも日報のログインコード",
    text: `ぽちも日報のログインコードは ${code} です。\n\n10分以内に入力してください。`,
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif; line-height: 1.7; color: #18181b;">
        <p>ぽちも日報のログインコードです。</p>
        <p style="font-size: 32px; font-weight: 800; letter-spacing: 0.18em; margin: 20px 0;">${code}</p>
        <p>10分以内に入力してください。</p>
      </div>
    `,
    tags: [{ name: "type", value: "login_code" }],
  });
}

async function serveFrame(pathname: string, userId: number, householdId?: number) {
  const relative = pathname.replace(/^\/data\/frames\//, "");
  const filePath = safeJoin(paths.framesDir, relative);

  if (!filePath?.endsWith(".jpg")) return new Response("Forbidden", { status: 403 });

  const eventFile = `data/frames/${relative}`;
  const event = await frameService.findEventByFile(eventFile, userId, householdId);
  if (!event) return new Response("Not found", { status: 404 });

  try {
    const content = await fs.readFile(filePath);
    return new Response(content, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  } catch (err: any) {
    if (err.code === "ENOENT") return new Response("Not found", { status: 404 });
    throw err;
  }
}

async function serveStatic(publicDir: string, pathname: string) {
  const routeMap = new Map([
    ["/", "/index.html"],
    ["/viewer", "/viewer.html"],
    ["/chat", "/chat.html"],
    ["/camera", "/camera.html"],
    ["/login", "/login.html"],
    ["/settings", "/settings.html"],
    ["/lp", "/lp.html"],
  ]);
  const requested = routeMap.get(pathname) || pathname;
  const filePath = safeJoin(publicDir, requested);
  if (!filePath) return new Response("Forbidden", { status: 403 });

  try {
    const content = await fs.readFile(filePath);
    return new Response(content, { headers: { "content-type": `${mimeType(path.extname(filePath))}; charset=utf-8` } });
  } catch (err: any) {
    if (err.code === "ENOENT") return new Response("Not found", { status: 404 });
    throw err;
  }
}

function mimeType(ext: string) {
  return (
    (
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
      } as Record<string, string>
    )[ext] || "text/plain"
  );
}

function safeJoin(rootDir: string, requestedPath: string) {
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, String(requestedPath || "").replace(/^\/+/, ""));
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return filePath;
}

function getClientIp(req: Request) {
  return String(req.headers.get("cf-connecting-ip") || "unknown")
    .split(",")[0]
    .trim();
}

function verifyRequestOrigin(req: Request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) throw new Error("invalid request origin");
  const allowed = new Set(
    [config.appOrigin, config.marketingOrigin].map((value) => String(value || "").replace(/\/$/, "")),
  );
  if (!allowed.has(String(origin).replace(/\/$/, ""))) throw new Error("invalid request origin");
}

function verifySetupToken(token: unknown) {
  if (authService.hasUsers()) return;
  if (!config.setupToken) throw new Error("setup token is required");
  if (String(token || "") !== config.setupToken) throw new Error("invalid setup token");
}

function validateDateParam(value: unknown) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid date");
  return date;
}

function enforceRateLimit(key: string, maxRequests: number, windowMs: number) {
  const now = Date.now();
  for (const [entryKey, entry] of rateLimits) {
    if (entry.resetAt <= now) rateLimits.delete(entryKey);
  }
  const current = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };
  current.count += 1;
  rateLimits.set(key, current);
  if (current.count > maxRequests) throw new Error("too many requests");
}

function isProfileSetupPath(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname === "/settings.html" ||
    pathname === "/settings.js" ||
    pathname === "/style.css" ||
    pathname === "/api/profile" ||
    pathname === "/api/auth/state" ||
    pathname === "/api/auth/logout"
  );
}

function isMarketingHome(req: Request, pathname: string) {
  if (pathname !== "/") return false;
  const host = String(req.headers.get("host") || "")
    .split(":")[0]
    .toLowerCase();
  const marketingHost = new URL(config.marketingOrigin).hostname.toLowerCase();
  return host === marketingHost;
}

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/lp" ||
    pathname === "/lp.html" ||
    pathname.startsWith("/og-image") ||
    pathname.startsWith("/assets/") ||
    pathname === "/api/ab/summary" ||
    pathname === "/api/ab/conversion" ||
    pathname === "/login.html" ||
    pathname === "/login.js" ||
    pathname === "/style.css" ||
    pathname === "/api/health" ||
    pathname === "/api/auth/state" ||
    pathname === "/api/auth/setup" ||
    pathname === "/api/auth/register" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/email/start" ||
    pathname === "/api/auth/email/verify"
  );
}

function parseCookieHeader(header = "") {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return null;
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
      })
      .filter(Boolean) as [string, string][],
  );
}

function startDailyReportScheduler() {
  let lastRunDate = "";
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const date = `${value("year")}-${value("month")}-${value("day")}`;
    const hour = value("hour");
    const minute = value("minute");

    const shouldRun = Number(hour) > 22 || (hour === "22" && Number(minute) >= 0);
    if (!shouldRun || lastRunDate === date) return;
    running = true;
    console.log(`[daily-report] start ${date}`);
    const ok = await createReportsForAllUsers(date)
      .then(() => true)
      .catch((err: Error) => {
        console.warn(`daily report failed: ${err.message}`);
        return false;
      })
      .finally(() => {
        running = false;
      });
    console.log(`[daily-report] ${ok ? "finished" : "failed"} ${date}`);
    if (ok) lastRunDate = date;
  };

  setInterval(tick, 30 * 1000);
  tick().catch(() => {});
}

async function createReportsForAllUsers(date: string) {
  const reportedHouseholds = new Set<number>();
  for (const user of authService.listUsers() as any[]) {
    const householdId = user.householdId || user.id;
    if (reportedHouseholds.has(householdId)) continue;
    if (await wasDailyReportMailSent(date, householdId)) continue;

    const profile = authService.getPetProfile(user.id, householdId);
    if (!profile?.name?.trim()) continue;
    console.log(`[daily-report] creating household=${householdId}`);
    const result = await reportService.createReport(date, {
      useAi: true,
      userId: user.id,
      householdId,
      petName: profile.name,
    });
    reportedHouseholds.add(householdId);
    await sendDailyReportMail({ date, user, householdId, petName: profile.name, ...result });
    await markDailyReportMailSent(date, householdId);
    console.log(`[daily-report] sent household=${householdId}`);
  }
}

async function wasDailyReportMailSent(date: string, householdId: number) {
  const state = await readJson<Record<string, { sentAt?: string }>>(dailyReportMailStatePath(date), {});
  return Boolean(state[String(householdId)]?.sentAt);
}

async function markDailyReportMailSent(date: string, householdId: number) {
  const file = dailyReportMailStatePath(date);
  const state = await readJson<Record<string, { sentAt?: string }>>(file, {});
  state[String(householdId)] = { sentAt: new Date().toISOString() };
  await writeJson(file, state);
}

function dailyReportMailStatePath(date: string) {
  return path.join(paths.reportsDir, `${date}.mail-state.json`);
}

async function sendDailyReportMail({ date, user, householdId, petName, markdown }: any) {
  const recipients = authService
    .listHouseholdUsers(householdId || user.id)
    .map((item: any) => item.username)
    .filter(isEmailAddress);
  if (!recipients.length) return;

  const events = await frameService.listEvents(date, user.id, householdId || user.id);
  const photoEvents = await pickDailyReportPhotoEvents(events);
  const attachments: { filename: string; content: string }[] = [];
  for (const event of photoEvents) {
    const imagePath = path.join(config.rootDir, event.file);
    const content = await fs.readFile(imagePath, "base64").catch(() => "");
    if (!content) continue;
    attachments.push({ filename: `pochimo-${event.time}.jpg`, content });
  }

  await mailService.sendMail({
    to: recipients,
    subject: `ぽちも日報 ${date}`,
    text: `${markdown}\n\n写真を${attachments.length}枚添付しています。`,
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif; line-height: 1.8; color: #18181b;">
        <p style="margin: 0 0 8px; color: #166534; font-weight: 800;">ぽちも日報</p>
        <h1 style="font-size: 24px; margin: 0 0 16px;">${escapeHtml(petName)}の一日まとめ</h1>
        ${markdownToHtml(markdown)}
        <p style="color: #71717a; font-size: 13px;">写真を${attachments.length}枚添付しています。</p>
      </div>
    `,
    attachments,
    tags: [{ name: "type", value: "daily_report" }],
  });
}

async function pickDailyReportPhotoEvents(events: any[]) {
  const withFiles = events.filter((event) => event.file);
  const scored = withFiles
    .map((event, index) => ({ event, index, score: dailyPhotoScore(event) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const picked: any[] = [];
  const seen = new Set<string>();

  for (const item of scored) {
    if (picked.length >= 6) break;
    if (seen.has(item.event.file)) continue;
    picked.push(item.event);
    seen.add(item.event.file);
  }

  if (picked.length < 3) {
    for (const event of withFiles.slice(-6).reverse()) {
      if (picked.length >= 3) break;
      if (seen.has(event.file)) continue;
      picked.push(event);
      seen.add(event.file);
    }
  }

  return picked.sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function dailyPhotoScore(event: any) {
  let score = Number(event.motionScore || 0);
  if (event.ai?.petVisible === true) score += 30;
  if (event.activityCategory && event.activityCategory !== "not_visible" && event.activityCategory !== "unknown")
    score += 12;
  if (event.activityCategory === "mischief") score += 40;
  if (event.notify) score += 24;
  if (event.timelineText) score += 8;
  return score;
}

function markdownToHtml(markdown: string) {
  const lines = String(markdown || "").split(/\r?\n/);
  return lines
    .map((line) => {
      if (line.startsWith("# "))
        return `<h2 style="font-size: 20px; margin: 22px 0 8px;">${escapeHtml(line.slice(2))}</h2>`;
      if (line.startsWith("## "))
        return `<h3 style="font-size: 16px; margin: 18px 0 6px;">${escapeHtml(line.slice(3))}</h3>`;
      if (line.startsWith("- ")) return `<p style="margin: 4px 0;">・${escapeHtml(line.slice(2))}</p>`;
      if (!line.trim()) return "<br />";
      return `<p style="margin: 8px 0;">${escapeHtml(line)}</p>`;
    })
    .join("\n");
}

function buildTimelineText(ai: any, motionScore = 0, petName = "ペット") {
  const name = String(petName || "ペット").trim() || "ペット";
  if (!ai?.enabled) return `内容を確認中（動き=${motionScore}）`;

  const label = ai.activityLabel || categoryLabel(ai.activityCategory);
  if (ai.petVisible === true) {
    const activity =
      ai.petActivity && ai.petActivity !== "不明" ? ai.petActivity.replaceAll("ペット", name) : `${name}が写っています`;
    return label && label !== "不明" ? `${label}: ${activity}` : activity;
  }

  if (ai.scene) return `${categoryLabel("not_visible")}: ${ai.scene.replaceAll("ペット", name)}`;
  return `${name}は確認できませんでした`;
}

function categoryLabel(category: string) {
  return (
    (
      {
        sleep: "お昼寝中",
        eat: "ご飯中",
        drink: "水飲み",
        toilet: "トイレ",
        play: "遊んでいる",
        mischief: "イタズラかも",
        near_owner: "人の近く",
        moving: "移動中",
        rest: "くつろぎ中",
        not_visible: "見えない",
        unknown: "不明",
      } as Record<string, string>
    )[category] || "不明"
  );
}

export function startServer() {
  serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
  console.log(`Pet Diary AI MVP running: http://localhost:${config.port}`);
}

if (process.env.NODE_ENV !== "test") startServer();
