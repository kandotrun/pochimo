import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config, paths } from './src/config.js';
import { ensureDir } from './src/json-store.js';
import { FrameService } from './src/frame-service.js';
import { OllamaClient } from './src/ollama-client.js';
import { ReportService } from './src/report-service.js';
import { serveStaticFile } from './src/static-files.js';
import { todayJst } from './src/time.js';

await ensureDir(paths.framesDir);
await ensureDir(paths.reportsDir);

const aiClient = new OllamaClient(config.ollama);
const frameService = new FrameService({ dataDir: config.dataDir, framesDir: paths.framesDir });
const reportService = new ReportService({
  rootDir: config.rootDir,
  dataDir: config.dataDir,
  reportsDir: paths.reportsDir,
  aiClient
});

const app = new Hono();

app.get('/api/health', c => c.json({ ok: true, date: todayJst() }));

app.post('/api/capture', async c => {
  const result = await frameService.saveCapture(await c.req.json());
  return c.json({ ok: true, ...result });
});

app.get('/api/events', async c => {
  const date = c.req.query('date') || todayJst();
  return c.json(await frameService.listEvents(date));
});

app.get('/api/report', async c => {
  const date = c.req.query('date') || todayJst();
  const useAi = c.req.query('ai') !== '0';
  return c.json(await reportService.createReport(date, { useAi }));
});

app.onError((err, c) => c.json({ ok: false, error: err.message }, 500));

app.get('*', c => serveStaticFile(c, config.publicDir, new URL(c.req.url).pathname));

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' });
console.log(`Pet Diary AI MVP running: http://localhost:${config.port}`);
