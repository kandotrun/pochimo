import path from 'node:path';
import { ensureDir, readJson, writeJson } from './json-store.mjs';
import { timestampJst, todayJst } from './time.mjs';
import { promises as fs } from 'node:fs';

export class FrameService {
  constructor({ dataDir, framesDir }) {
    this.dataDir = dataDir;
    this.framesDir = framesDir;
  }

  async saveCapture(body, userId, householdId = userId) {
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
      userId: Number(userId),
      householdId: Number(householdId),
      motionScore: Number(body.motionScore || 0),
      cameraId: sanitizeText(body.cameraId, 80) || 'browser-camera',
      cameraLabel: sanitizeText(body.cameraLabel, 40) || 'カメラ',
      note: body.note || ''
    };

    const eventsFile = path.join(this.dataDir, `${date}.events.json`);
    const events = await readJson(eventsFile, []);
    events.push(event);
    await writeJson(eventsFile, events);

    return { event, count: events.length };
  }

  async listEvents(date = todayJst(), userId = null, householdId = userId) {
    const events = await readJson(path.join(this.dataDir, `${date}.events.json`), []);
    if (userId == null) return events;
    return events.filter(event => {
      if (event.householdId != null) return Number(event.householdId) === Number(householdId);
      return Number(event.userId) === Number(userId) || Number(event.userId) === Number(householdId);
    });
  }

  async findEventByFile(file, userId, householdId = userId) {
    const date = String(file || '').match(/data\/frames\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    if (!date) return null;
    const events = await this.listEvents(date, userId, householdId);
    return events.find(event => event.file === file) || null;
  }

  async updateEvent(date, time, patch) {
    const eventsFile = path.join(this.dataDir, `${date}.events.json`);
    const events = await readJson(eventsFile, []);
    const index = events.findIndex(event => event.time === time);
    if (index === -1) throw new Error('event not found');

    events[index] = { ...events[index], ...patch };
    await writeJson(eventsFile, events);
    return events[index];
  }
}

function sanitizeText(value, maxLength) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLength);
}
