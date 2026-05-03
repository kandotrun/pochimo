import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from './json-store.js';
import { timestampJst, todayJst } from './time.js';
import type { CaptureEvent } from './types.js';

type CaptureBody = {
  image?: string;
  motionScore?: number;
  cameraLabel?: string;
  note?: string;
};

export class FrameService {
  constructor(private readonly options: { dataDir: string; framesDir: string }) {}

  async saveCapture(body: CaptureBody): Promise<{ event: CaptureEvent; count: number }> {
    if (!body.image?.startsWith('data:image/jpeg;base64,')) {
      throw new Error('image must be jpeg data url');
    }

    const date = todayJst();
    const stamp = timestampJst();
    const dateDir = path.join(this.options.framesDir, date);
    const filename = `${stamp}.jpg`;
    const imageBytes = Buffer.from(body.image.split(',')[1] ?? '', 'base64');

    await ensureDir(dateDir);
    await fs.writeFile(path.join(dateDir, filename), imageBytes);

    const event: CaptureEvent = {
      time: stamp,
      file: `data/frames/${date}/${filename}`,
      motionScore: Number(body.motionScore || 0),
      cameraLabel: body.cameraLabel || 'browser-camera',
      note: body.note || ''
    };

    const eventsFile = path.join(this.options.dataDir, `${date}.events.json`);
    const events = await readJson<CaptureEvent[]>(eventsFile, []);
    events.push(event);
    await writeJson(eventsFile, events);

    return { event, count: events.length };
  }

  async listEvents(date = todayJst()): Promise<CaptureEvent[]> {
    return readJson<CaptureEvent[]>(path.join(this.options.dataDir, `${date}.events.json`), []);
  }
}
