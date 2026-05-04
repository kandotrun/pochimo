import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

loadDotEnv(path.join(rootDir, '.env'));

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8787),
  marketingOrigin: process.env.PUBLIC_MARKETING_ORIGIN || 'https://pochimo.com',
  appOrigin: process.env.PUBLIC_APP_ORIGIN || 'https://diary.pochimo.com',
  dataDir: path.join(rootDir, 'data'),
  publicDir: path.join(rootDir, 'public'),
  ollama: {
    localUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    localVisionModel: process.env.OLLAMA_VISION_MODEL || 'moondream',
    cloudUrl: process.env.OLLAMA_CLOUD_URL || 'https://ollama.com/v1',
    cloudVisionModel: process.env.OLLAMA_CLOUD_VISION_MODEL || 'gemma4:31b',
    cloudReportModel: process.env.OLLAMA_CLOUD_MODEL || 'deepseek-v4-pro',
    apiKey: process.env.OLLAMA_API_KEY || ''
  }
};

export const paths = {
  framesDir: path.join(config.dataDir, 'frames'),
  reportsDir: path.join(config.dataDir, 'reports')
};

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = rawValue
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
}
