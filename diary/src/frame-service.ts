import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "./json-store.ts";
import { timestampJst, todayJst } from "./time.ts";

const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;

export type CaptureBody = {
  image?: string;
  motionScore?: number;
  cameraId?: string;
  cameraLabel?: string;
  note?: string;
};

export type FrameEvent = {
  time: string;
  file: string;
  userId: number;
  householdId: number;
  motionScore: number;
  cameraId: string;
  cameraLabel: string;
  note: string;
  [key: string]: any;
};

type FrameServiceOptions = {
  dataDir: string;
  framesDir: string;
};

export class FrameService {
  dataDir: string;
  framesDir: string;
  writeQueues = new Map<string, Promise<FrameEvent[]>>();

  constructor({ dataDir, framesDir }: FrameServiceOptions) {
    this.dataDir = dataDir;
    this.framesDir = framesDir;
  }

  async saveCapture(body: CaptureBody, userId: number, householdId = userId) {
    if (!body.image?.startsWith("data:image/jpeg;base64,")) {
      throw new Error("image must be jpeg data url");
    }

    const date = todayJst();
    const stamp = timestampJst();
    const dateDir = path.join(this.framesDir, date);
    const filename = `${stamp}.jpg`;
    const imageBytes = Buffer.from(body.image.split(",")[1], "base64");
    if (imageBytes.length > MAX_CAPTURE_BYTES) throw new Error("image too large");
    if (imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8) throw new Error("image must be jpeg");

    await ensureDir(dateDir);
    await fs.writeFile(path.join(dateDir, filename), imageBytes);

    const event: FrameEvent = {
      time: stamp,
      file: `data/frames/${date}/${filename}`,
      userId: Number(userId),
      householdId: Number(householdId),
      motionScore: Number(body.motionScore || 0),
      cameraId: sanitizeText(body.cameraId, 80) || "browser-camera",
      cameraLabel: sanitizeText(body.cameraLabel, 40) || "カメラ",
      note: body.note || "",
    };

    const eventsFile = path.join(this.dataDir, `${date}.events.json`);
    const events = await this.updateEventsFile(eventsFile, (events) => {
      if (!events.some((item) => item.time === event.time)) events.push(event);
      return events;
    });

    return { event, count: events.length };
  }

  async listEvents(date = todayJst(), userId: number | null = null, householdId = userId) {
    const events = await readJson<FrameEvent[]>(path.join(this.dataDir, `${date}.events.json`), []);
    if (userId == null) return events;
    return events.filter((event) => {
      if (event.householdId != null) return Number(event.householdId) === Number(householdId);
      return Number(event.userId) === Number(userId) || Number(event.userId) === Number(householdId);
    });
  }

  async findEventByFile(file: string, userId: number, householdId = userId) {
    const date = String(file || "").match(/data\/frames\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    if (!date) return null;
    const events = await this.listEvents(date, userId, householdId);
    return events.find((event) => event.file === file) || null;
  }

  async updateEvent(date: string, time: string, patch: Partial<FrameEvent> & Record<string, any>) {
    const eventsFile = path.join(this.dataDir, `${date}.events.json`);
    let updated: FrameEvent | null = null;
    await this.updateEventsFile(eventsFile, (events) => {
      const index = events.findIndex((event) => event.time === time);
      if (index === -1) throw new Error("event not found");
      events[index] = { ...events[index], ...patch };
      updated = events[index];
      return events;
    });
    return updated;
  }

  private async updateEventsFile(eventsFile: string, updater: (events: FrameEvent[]) => FrameEvent[]) {
    const previous = this.writeQueues.get(eventsFile) || Promise.resolve([]);
    const next = previous
      .catch(() => [])
      .then(async () => {
        const events = await readJson<FrameEvent[]>(eventsFile, []);
        const updated = await updater(events);
        updated.sort((a, b) => String(a.time).localeCompare(String(b.time)));
        await writeJson(eventsFile, updated);
        return updated;
      });
    this.writeQueues.set(
      eventsFile,
      next.finally(() => {
        if (this.writeQueues.get(eventsFile) === next) this.writeQueues.delete(eventsFile);
      }),
    );
    return next;
  }
}

function sanitizeText(value: unknown, maxLength: number) {
  return String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, maxLength);
}
