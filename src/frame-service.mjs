import path from 'node:path';
import { ensureDir, readJson, writeJson } from './json-store.mjs';
import { timestampJst, todayJst } from './time.mjs';
import { promises as fs } from 'node:fs';

export class FrameService {
  constructor({ dataDir, framesDir }) {
    this.dataDir = dataDir;
    this.framesDir = framesDir;
  }

  async saveCapture(body) {
    if (!body.image?.startsWith('data:image/jpeg;base64,')) {
      throw new Error('image must be jpeg data url');
    }

    const date = todayJst();
    const stamp = timestampJst();
    const dateDir = path.join(this.framesDir, date);
    const filename = `${stamp}.jpg`;
    const imageBytes = Buffer.from(body.image.split(',')[1], 'base64');

    await ensureDir(dateDir);
    await fs.writeFile(path.join(dateDir, filename), imageBytes);

    const event = {
      time: stamp,
      file: `data/frames/${date}/${filename}`,
      motionScore: Number(body.motionScore || 0),
      cameraLabel: body.cameraLabel || 'browser-camera',
      note: body.note || ''
    };

    const eventsFile = path.join(this.dataDir, `${date}.events.json`);
    const events = await readJson(eventsFile, []);
    events.push(event);
    await writeJson(eventsFile, events);

    return { event, count: events.length };
  }

  async listEvents(date = todayJst()) {
    return readJson(path.join(this.dataDir, `${date}.events.json`), []);
  }
}
