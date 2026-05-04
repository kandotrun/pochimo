import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config, paths } from './src/config.mjs';
import { ensureDir, readJson, writeJson } from './src/json-store.mjs';
import { FrameService } from './src/frame-service.mjs';
import { OllamaClient } from './src/ollama-client.mjs';
import { ReportService } from './src/report-service.mjs';
import { parseBody, sendJson } from './src/http-utils.mjs';
import { serveStatic } from './src/static-files.mjs';
import { todayJst } from './src/time.mjs';
import { AuthService, clearSessionCookie, parseCookies, sessionCookie } from './src/auth-service.mjs';
import { AbService } from './src/ab-service.mjs';
import { mailService } from './src/mail-service.mjs';

await ensureDir(paths.framesDir);
await ensureDir(paths.reportsDir);

const authService = new AuthService({ dataDir: config.dataDir });
const abService = new AbService({ dataDir: config.dataDir });
const aiClient = new OllamaClient(config.ollama);
const timelineCache = new Map();
const rateLimits = new Map();
const frameService = new FrameService({ dataDir: config.dataDir, framesDir: paths.framesDir });
const reportService = new ReportService({
  rootDir: config.rootDir,
  dataDir: config.dataDir,
  reportsDir: paths.reportsDir,
  aiClient
});

startDailyReportScheduler();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    const url = new URL(req.url, `http://${req.headers.host}`);
    verifyRequestOrigin(req);

    const user = authService.getUserByToken(parseCookies(req).pet_session);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, date: todayJst() });
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/state') {
      return sendJson(res, 200, { ok: true, hasUsers: authService.hasUsers(), user });
    }

    if (req.method === 'GET' && url.pathname === '/api/ab/summary') {
      return sendJson(res, 200, { ok: true, ...(await abService.summary()) });
    }

    if (req.method === 'POST' && url.pathname === '/api/ab/conversion') {
      const body = JSON.parse(await parseBody(req, 32 * 1024));
      return sendJson(res, 200, await abService.recordConversion(body.variant));
    }

    if (req.method === 'GET' && isMarketingHome(req, url.pathname)) {
      return serveLp({ req, res });
    }

    if (req.method === 'GET' && (url.pathname === '/lp' || url.pathname === '/lp.html')) {
      return serveLp({ req, res });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
      const body = JSON.parse(await parseBody(req));
      const created = authService.createFirstUser(body);
      const session = authService.login({ username: created.username, password: body.password });
      res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      return sendJson(res, 200, { ok: true, user: session.user });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = JSON.parse(await parseBody(req));
      const created = authService.createUserWithInvite(body);
      const session = authService.login({ username: created.username, password: body.password });
      res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      return sendJson(res, 200, { ok: true, user: session.user });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const session = authService.login(JSON.parse(await parseBody(req)));
      res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      return sendJson(res, 200, { ok: true, user: session.user });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/email/start') {
      const body = JSON.parse(await parseBody(req));
      const ip = getClientIp(req);
      const emailKey = String(body.email || '').trim().toLowerCase();
      enforceRateLimit(`email-start:ip:${ip}`, 30, 15 * 60 * 1000);
      enforceRateLimit(`email-start:email:${emailKey}`, 5, 15 * 60 * 1000);
      const loginCode = authService.createEmailLoginCode(body);
      if (!loginCode.skipped) await sendLoginCodeMail(loginCode);
      return sendJson(res, 200, { ok: true, email: loginCode.email, expiresAt: loginCode.expiresAt });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/email/verify') {
      const body = JSON.parse(await parseBody(req));
      const ip = getClientIp(req);
      const emailKey = String(body.email || '').trim().toLowerCase();
      enforceRateLimit(`email-verify:ip:${ip}`, 60, 15 * 60 * 1000);
      enforceRateLimit(`email-verify:email:${emailKey}`, 10, 15 * 60 * 1000);
      const session = authService.verifyEmailLoginCode(body);
      res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      return sendJson(res, 200, { ok: true, user: session.user });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      authService.logout(parseCookies(req).pet_session);
      res.setHeader('Set-Cookie', clearSessionCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (!isPublicPath(url.pathname) && !user) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { ok: false, error: 'authentication required' });
      return redirect(res, '/login');
    }

    if (user && url.pathname === '/login') return redirect(res, '/viewer');

    if (req.method === 'GET' && url.pathname === '/api/profile') {
      return sendJson(res, 200, { ok: true, profile: authService.getPetProfile(user.id, user.householdId) });
    }

    if (req.method === 'GET' && url.pathname === '/api/invites') {
      return sendJson(res, 200, { ok: true, invites: authService.listInvites(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/invites') {
      return sendJson(res, 200, { ok: true, invite: authService.createInvite(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = JSON.parse(await parseBody(req, 3 * 1024 * 1024));
      return sendJson(res, 200, { ok: true, profile: authService.savePetProfile(user.id, body, user.householdId) });
    }

    const petProfile = user ? authService.getPetProfile(user.id, user.householdId) : null;
    const hasPetName = Boolean(petProfile?.name?.trim());
    if (user && !hasPetName && !isProfileSetupPath(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 400, { ok: false, error: 'pet name is required' });
      return redirect(res, '/settings');
    }

    if (req.method === 'POST' && url.pathname === '/api/capture') {
      enforceRateLimit(`capture:user:${user.id}`, 240, 15 * 60 * 1000);
      const body = JSON.parse(await parseBody(req));
      const result = await frameService.saveCapture(body, user.id, user.householdId);
      analyzeEventInBackground(result.event, body.image, petProfile.name);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const date = url.searchParams.get('date') || todayJst();
      return sendJson(res, 200, await frameService.listEvents(date, user.id, user.householdId));
    }

    if (req.method === 'GET' && url.pathname === '/api/timeline') {
      const date = url.searchParams.get('date') || todayJst();
      const events = await frameService.listEvents(date, user.id, user.householdId);
      const profile = authService.getPetProfile(user.id, user.householdId);
      const timeline = await getCachedTimeline({ date, user, events, petName: profile.name || 'ペット' });
      return sendJson(res, 200, { ok: true, ...timeline });
    }

    if (req.method === 'POST' && url.pathname === '/api/timeline/chat') {
      enforceRateLimit(`timeline-chat:user:${user.id}`, 40, 15 * 60 * 1000);
      const body = JSON.parse(await parseBody(req, 32 * 1024));
      const date = body.date || todayJst();
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt is required' });
      const events = await frameService.listEvents(date, user.id, user.householdId);
      const profile = authService.getPetProfile(user.id, user.householdId);
      const result = await aiClient.chatTimeline({ events, prompt, petName: profile.name || 'ペット' });
      return sendJson(res, 200, { ok: true, ...enrichTimelineWithImages(result, events) });
    }

    if (req.method === 'GET' && url.pathname === '/api/latest') {
      const date = url.searchParams.get('date') || todayJst();
      const events = await frameService.listEvents(date, user.id, user.householdId);
      const latest = [...events].reverse().find(event => event.file);
      return sendJson(res, 200, latest ? { ok: true, event: latest, imageUrl: `/${latest.file}` } : { ok: true, event: null, imageUrl: null });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/data/frames/')) {
      return serveFrame(url.pathname, res, user.id, user.householdId);
    }

    if (req.method === 'GET' && url.pathname === '/api/report') {
      const date = url.searchParams.get('date') || todayJst();
      const saved = await reportService.getReport(date, { userId: user.id, householdId: user.householdId });
      return sendJson(res, 200, { ok: true, ...saved });
    }

    return serveStatic({ publicDir: config.publicDir, pathname: url.pathname, res });
  } catch (err) {
    const status = err.message === 'too many requests'
      ? 429
      : err.message === 'invalid request origin'
        ? 403
        : 500;
    return sendJson(res, status, { ok: false, error: err.message });
  }
});

async function serveLp({ req, res }) {
  const cookies = parseCookies(req);
  const { variant, shouldSetCookie } = await abService.chooseVariant(cookies);
  let html = await fs.readFile(path.join(config.publicDir, 'lp.html'), 'utf8');
  html = html
    .replaceAll('__AB_VARIANT__', variant.id)
    .replaceAll('__AB_IMAGE__', variant.image)
    .replaceAll('__OG_IMAGE__', variant.ogImage)
    .replaceAll('__MARKETING_ORIGIN__', config.marketingOrigin)
    .replaceAll('__APP_ORIGIN__', config.appOrigin);
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (shouldSetCookie) headers['set-cookie'] = `ab_lp_visual=${variant.id}; Path=/; Max-Age=${60 * 60 * 24 * 90}; SameSite=Lax`;
  res.writeHead(200, headers);
  res.end(html);
}

async function analyzeEventInBackground(event, imageDataUrl, petName = 'ペット') {
  if (!imageDataUrl?.startsWith('data:image/jpeg;base64,')) return;

  const date = event.time.slice(0, 10);
  const base64 = imageDataUrl.split(',')[1];

  frameService.updateEvent(date, event.time, { aiStatus: 'analyzing' }).catch(() => {});

  queueMicrotask(async () => {
    try {
      const ai = await aiClient.analyzeImages([base64], { petName });
      const patch = {
        aiStatus: ai.enabled ? 'done' : 'failed',
        ai,
        activityCategory: ai.activityCategory || 'unknown',
        activityLabel: ai.activityLabel || categoryLabel(ai.activityCategory),
        notify: Boolean(ai.notify),
        notificationText: ai.notificationText || '',
        timelineText: buildTimelineText(ai, event.motionScore, petName)
      };
      const updated = await frameService.updateEvent(date, event.time, patch);
      await notifyImportantEventByEmail(updated, petName).catch(async err => {
        console.warn(`event mail failed: ${err.message}`);
        await frameService.updateEvent(date, event.time, {
          notificationStatus: 'failed',
          notificationError: err.message
        }).catch(() => {});
      });
    } catch (err) {
      await frameService.updateEvent(date, event.time, {
        aiStatus: 'failed',
        timelineText: `解析失敗: ${err.message}`
      }).catch(() => {});
    }
  });
}

async function getCachedTimeline({ date, user, events, petName }) {
  const householdId = user.householdId || user.id;
  const signature = buildTimelineSignature(events);
  const cacheKey = `${householdId}:${date}`;
  const cached = timelineCache.get(cacheKey);
  if (cached?.signature === signature && cached.result) return cached.result;
  if (cached?.signature === signature && cached.promise) return cached.promise;

  const promise = aiClient.createTimeline({ events, petName })
    .then(result => {
      const enriched = enrichTimelineWithImages(result, events);
      timelineCache.set(cacheKey, { signature, result: enriched, createdAt: Date.now() });
      return enriched;
    })
    .catch(err => {
      timelineCache.delete(cacheKey);
      throw err;
    });

  timelineCache.set(cacheKey, { signature, promise, createdAt: Date.now() });
  return promise;
}

function enrichTimelineWithImages(timeline, events) {
  const items = (timeline.items || []).map(item => {
    const event = findTimelinePhotoEvent(item, events);
    return {
      ...item,
      imageUrl: event?.file ? `/${event.file}` : '',
      imageTime: event?.time || ''
    };
  });
  return { ...timeline, items };
}

function findTimelinePhotoEvent(item, events) {
  const withFiles = events.filter(event => event.file);
  if (!withFiles.length) return null;

  const start = parseTimelineTime(item.startTime || item.time);
  const end = parseTimelineTime(item.endTime || item.time || item.startTime);
  const inRange = withFiles.filter(event => {
    const time = parseTimelineTime(event.time);
    return time >= start && time <= end;
  });
  const candidates = inRange.length ? inRange : withFiles;
  return candidates.reduce((best, event) => {
    const score = timelinePhotoScore(event, item);
    return score > best.score ? { event, score } : best;
  }, { event: candidates[0], score: -Infinity }).event;
}

function timelinePhotoScore(event, item) {
  let score = Number(event.motionScore || 0);
  if (event.ai?.petVisible === true) score += 40;
  if ((event.activityCategory || event.ai?.activityCategory) === item.activityCategory) score += 18;
  if (event.notify) score += 24;
  if (event.timelineText) score += 6;
  return score;
}

function parseTimelineTime(time) {
  const normalized = String(time || '').replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTimelineSignature(events) {
  return events.map(event => [
    event.time,
    event.aiStatus || '',
    event.activityCategory || '',
    event.activityLabel || '',
    event.notify ? '1' : '0',
    event.timelineText || ''
  ].join('|')).join('\n');
}

async function notifyImportantEventByEmail(event, petName = 'ペット') {
  if (!shouldSendEventMail(event)) return;

  const recipients = authService
    .listHouseholdUsers(event.householdId || event.userId)
    .map(user => user.username)
    .filter(isEmailAddress);
  if (!recipients.length) return;

  const imagePath = path.join(config.rootDir, event.file);
  const imageBase64 = await fs.readFile(imagePath, 'base64');
  const label = event.activityLabel || categoryLabel(event.activityCategory) || '通知';
  const message = event.notificationText || event.timelineText || `${petName}の様子を確認してください。`;
  const timeLabel = event.time.replace('T', ' ');

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
    attachments: [{
      filename: `pochimo-${event.time}.jpg`,
      content: imageBase64
    }],
    tags: [{ name: 'type', value: 'event_alert' }]
  });

  await frameService.updateEvent(event.time.slice(0, 10), event.time, {
    notificationStatus: result.skipped ? 'skipped' : 'sent',
    notificationSentAt: new Date().toISOString(),
    notificationRecipients: recipients
  });
}

function shouldSendEventMail(event) {
  if (event.notificationStatus === 'sent') return false;
  if (!event.file) return false;
  return Boolean(event.notify) || event.activityCategory === 'mischief';
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendLoginCodeMail({ email, code }) {
  await mailService.sendMail({
    to: email,
    subject: 'ぽちも日報のログインコード',
    text: `ぽちも日報のログインコードは ${code} です。\n\n10分以内に入力してください。`,
    html: `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif; line-height: 1.7; color: #18181b;">
        <p>ぽちも日報のログインコードです。</p>
        <p style="font-size: 32px; font-weight: 800; letter-spacing: 0.18em; margin: 20px 0;">${code}</p>
        <p>10分以内に入力してください。</p>
      </div>
    `,
    tags: [{ name: 'type', value: 'login_code' }]
  });
}

async function serveFrame(pathname, res, userId, householdId) {
  const relative = pathname.replace(/^\/data\/frames\//, '');
  const filePath = safeJoin(paths.framesDir, relative);

  if (!filePath || !filePath.endsWith('.jpg')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const eventFile = `data/frames/${relative}`;
  const event = await frameService.findEventByFile(eventFile, userId, householdId);
  if (!event) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'cache-control': 'no-store'
    });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    throw err;
  }
}

function safeJoin(rootDir, requestedPath) {
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, String(requestedPath || '').replace(/^\/+/, ''));
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return filePath;
}

function getClientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function verifyRequestOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = new Set([config.appOrigin, config.marketingOrigin].map(value => String(value || '').replace(/\/$/, '')));
  if (!allowed.has(String(origin).replace(/\/$/, ''))) throw new Error('invalid request origin');
}

function enforceRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  for (const [entryKey, entry] of rateLimits) {
    if (entry.resetAt <= now) rateLimits.delete(entryKey);
  }
  const current = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };
  current.count += 1;
  rateLimits.set(key, current);
  if (current.count > maxRequests) throw new Error('too many requests');
}

function isProfileSetupPath(pathname) {
  return pathname === '/settings'
    || pathname === '/settings.html'
    || pathname === '/settings.js'
    || pathname === '/style.css'
    || pathname === '/api/profile'
    || pathname === '/api/auth/state'
    || pathname === '/api/auth/logout';
}

function isMarketingHome(req, pathname) {
  if (pathname !== '/') return false;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const marketingHost = new URL(config.marketingOrigin).hostname.toLowerCase();
  return host === marketingHost;
}

function isPublicPath(pathname) {
  return pathname === '/login'
    || pathname === '/lp'
    || pathname === '/lp.html'
    || pathname.startsWith('/og-image')
    || pathname.startsWith('/assets/')
    || pathname === '/api/ab/summary'
    || pathname === '/api/ab/conversion'
    || pathname === '/login.html'
    || pathname === '/login.js'
    || pathname === '/style.css'
    || pathname === '/api/health'
    || pathname === '/api/auth/state'
    || pathname === '/api/auth/setup'
    || pathname === '/api/auth/register'
    || pathname === '/api/auth/login'
    || pathname === '/api/auth/email/start'
    || pathname === '/api/auth/email/verify';
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function startDailyReportScheduler() {
  let lastRunDate = '';

  const tick = async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const value = type => parts.find(part => part.type === type)?.value;
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const hour = value('hour');
    const minute = value('minute');

    const shouldRun = Number(hour) > 22 || (hour === '22' && Number(minute) >= 0);
    if (!shouldRun || lastRunDate === date) return;
    const ok = await createReportsForAllUsers(date).then(() => true).catch(err => {
      console.warn(`daily report failed: ${err.message}`);
      return false;
    });
    if (ok) lastRunDate = date;
  };

  setInterval(tick, 30 * 1000);
  tick().catch(() => {});
}

async function createReportsForAllUsers(date) {
  const reportedHouseholds = new Set();
  for (const user of authService.listUsers()) {
    const householdId = user.householdId || user.id;
    if (reportedHouseholds.has(householdId)) continue;
    if (await wasDailyReportMailSent(date, householdId)) continue;

    const profile = authService.getPetProfile(user.id, householdId);
    if (!profile?.name?.trim()) continue;
    const result = await reportService.createReport(date, {
      useAi: true,
      userId: user.id,
      householdId,
      petName: profile.name
    });
    reportedHouseholds.add(householdId);
    await sendDailyReportMail({ date, user, householdId, petName: profile.name, ...result });
    await markDailyReportMailSent(date, householdId);
  }
}

async function wasDailyReportMailSent(date, householdId) {
  const state = await readJson(dailyReportMailStatePath(date), {});
  return Boolean(state[String(householdId)]?.sentAt);
}

async function markDailyReportMailSent(date, householdId) {
  const file = dailyReportMailStatePath(date);
  const state = await readJson(file, {});
  state[String(householdId)] = { sentAt: new Date().toISOString() };
  await writeJson(file, state);
}

function dailyReportMailStatePath(date) {
  return path.join(paths.reportsDir, `${date}.mail-state.json`);
}

async function sendDailyReportMail({ date, user, householdId, petName, report, markdown }) {
  const recipients = authService
    .listHouseholdUsers(householdId || user.id)
    .map(item => item.username)
    .filter(isEmailAddress);
  if (!recipients.length) return;

  const events = await frameService.listEvents(date, user.id, householdId || user.id);
  const photoEvents = await pickDailyReportPhotoEvents(events);
  const attachments = [];
  for (const event of photoEvents) {
    const imagePath = path.join(config.rootDir, event.file);
    const content = await fs.readFile(imagePath, 'base64').catch(() => '');
    if (!content) continue;
    attachments.push({
      filename: `pochimo-${event.time}.jpg`,
      content
    });
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
    tags: [{ name: 'type', value: 'daily_report' }]
  });
}

async function pickDailyReportPhotoEvents(events) {
  const withFiles = events.filter(event => event.file);
  const scored = withFiles.map((event, index) => ({ event, index, score: dailyPhotoScore(event) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const picked = [];
  const seen = new Set();

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

function dailyPhotoScore(event) {
  let score = Number(event.motionScore || 0);
  if (event.ai?.petVisible === true) score += 30;
  if (event.activityCategory && event.activityCategory !== 'not_visible' && event.activityCategory !== 'unknown') score += 12;
  if (event.activityCategory === 'mischief') score += 40;
  if (event.notify) score += 24;
  if (event.timelineText) score += 8;
  return score;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  return lines.map(line => {
    if (line.startsWith('# ')) return `<h2 style="font-size: 20px; margin: 22px 0 8px;">${escapeHtml(line.slice(2))}</h2>`;
    if (line.startsWith('## ')) return `<h3 style="font-size: 16px; margin: 18px 0 6px;">${escapeHtml(line.slice(3))}</h3>`;
    if (line.startsWith('- ')) return `<p style="margin: 4px 0;">・${escapeHtml(line.slice(2))}</p>`;
    if (!line.trim()) return '<br />';
    return `<p style="margin: 8px 0;">${escapeHtml(line)}</p>`;
  }).join('\n');
}

function buildTimelineText(ai, motionScore = 0, petName = 'ペット') {
  const name = String(petName || 'ペット').trim() || 'ペット';
  if (!ai?.enabled) return `内容を確認中（動き=${motionScore}）`;

  const label = ai.activityLabel || categoryLabel(ai.activityCategory);
  if (ai.petVisible === true) {
    const activity = ai.petActivity && ai.petActivity !== '不明'
      ? ai.petActivity.replaceAll('ペット', name)
      : `${name}が写っています`;
    return label && label !== '不明' ? `${label}: ${activity}` : activity;
  }

  if (ai.scene) return `${categoryLabel('not_visible')}: ${ai.scene.replaceAll('ペット', name)}`;
  return `${name}は確認できませんでした`;
}

function categoryLabel(category) {
  return ({
    sleep: 'お昼寝中',
    eat: 'ご飯中',
    drink: '水飲み',
    toilet: 'トイレ',
    play: '遊んでいる',
    mischief: 'イタズラかも',
    near_owner: '人の近く',
    moving: '移動中',
    rest: 'くつろぎ中',
    not_visible: '見えない',
    unknown: '不明'
  })[category] || '不明';
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Pet Diary AI MVP running: http://localhost:${config.port}`);
});
