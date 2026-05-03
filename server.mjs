import http from 'node:http';
import { config, paths } from './src/config.mjs';
import { ensureDir } from './src/json-store.mjs';
import { FrameService } from './src/frame-service.mjs';
import { OllamaClient } from './src/ollama-client.mjs';
import { ReportService } from './src/report-service.mjs';
import { parseBody, sendJson } from './src/http-utils.mjs';
import { serveStatic } from './src/static-files.mjs';
import { todayJst } from './src/time.mjs';

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, date: todayJst() });
    }

    if (req.method === 'POST' && url.pathname === '/api/capture') {
      const result = await frameService.saveCapture(JSON.parse(await parseBody(req)));
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const date = url.searchParams.get('date') || todayJst();
      return sendJson(res, 200, await frameService.listEvents(date));
    }

    if (req.method === 'GET' && url.pathname === '/api/report') {
      const date = url.searchParams.get('date') || todayJst();
      const useAi = url.searchParams.get('ai') !== '0';
      return sendJson(res, 200, await reportService.createReport(date, { useAi }));
    }

    return serveStatic({ publicDir: config.publicDir, pathname: url.pathname, res });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Pet Diary AI MVP running: http://localhost:${config.port}`);
});
