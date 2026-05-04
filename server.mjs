import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config, paths } from './src/config.mjs';
import { ensureDir } from './src/json-store.mjs';
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
      const loginCode = authService.createEmailLoginCode(body);
      await sendLoginCodeMail(loginCode);
      return sendJson(res, 200, { ok: true, email: loginCode.email, expiresAt: loginCode.expiresAt });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/email/verify') {
      const session = authService.verifyEmailLoginCode(JSON.parse(await parseBody(req)));
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
      return sendJson(res, 200, { ok: true, profile: authService.getPetProfile(user.id) });
    }

    if (req.method === 'GET' && url.pathname === '/api/invites') {
      return sendJson(res, 200, { ok: true, invites: authService.listInvites(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/invites') {
      return sendJson(res, 200, { ok: true, invite: authService.createInvite(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = JSON.parse(await parseBody(req, 3 * 1024 * 1024));
      return sendJson(res, 200, { ok: true, profile: authService.savePetProfile(user.id, body) });
    }

    const petProfile = user ? authService.getPetProfile(user.id) : null;
    const hasPetName = Boolean(petProfile?.name?.trim());
    if (user && !hasPetName && !isProfileSetupPath(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 400, { ok: false, error: 'pet name is required' });
      return redirect(res, '/settings');
    }

    if (req.method === 'POST' && url.pathname === '/api/capture') {
      const body = JSON.parse(await parseBody(req));
      const result = await frameService.saveCapture(body, user.id, user.householdId);
      analyzeEventInBackground(result.event, body.image, petProfile.name);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const date = url.searchParams.get('date') || todayJst();
      return sendJson(res, 200, await frameService.listEvents(date, user.id, user.householdId));
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
    return sendJson(res, 500, { ok: false, error: err.message });
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
  const filePath = path.normalize(path.join(paths.framesDir, relative));

  if (!filePath.startsWith(paths.framesDir) || !filePath.endsWith('.jpg')) {
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

    if (hour !== '22' || minute !== '00' || lastRunDate === date) return;
    lastRunDate = date;
    await createReportsForAllUsers(date).catch(err => {
      console.warn(`daily report failed: ${err.message}`);
    });
  };

  setInterval(tick, 30 * 1000);
  tick().catch(() => {});
}

async function createReportsForAllUsers(date) {
  for (const user of authService.listUsers()) {
    const profile = authService.getPetProfile(user.id);
    if (!profile?.name?.trim()) continue;
    await reportService.createReport(date, {
      useAi: true,
      userId: user.id,
      householdId: user.householdId,
      petName: profile.name
    });
  }
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
