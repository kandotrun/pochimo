import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FrameService } from "./frame-service.ts";
import { todayJst } from "./time.ts";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function tinyJpegDataUrl() {
  return `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;
}

describe("FrameService", () => {
  test("saves a JPEG capture and scopes events by household", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-frame-"));
    const service = new FrameService({ dataDir: tempDir, framesDir: path.join(tempDir, "frames") });

    const result = await service.saveCapture(
      {
        image: tinyJpegDataUrl(),
        motionScore: 12,
        cameraId: " living\ncam ",
        cameraLabel: " リビング\t ",
      },
      1,
      10,
    );

    expect(result.count).toBe(1);
    expect(result.event.householdId).toBe(10);
    expect(result.event.cameraId).toBe("living cam");
    expect(result.event.cameraLabel).toBe("リビング");
    expect(await readFile(path.join(tempDir, result.event.file.replace(/^data\//, "")))).toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );

    expect(await service.listEvents(todayJst(), 2, 10)).toHaveLength(1);
    expect(await service.listEvents(todayJst(), 2, 99)).toHaveLength(0);
  });

  test("rejects non-JPEG data URLs", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-frame-"));
    const service = new FrameService({ dataDir: tempDir, framesDir: path.join(tempDir, "frames") });

    await expect(service.saveCapture({ image: "data:image/png;base64,AAAA" }, 1)).rejects.toThrow(
      "image must be jpeg data url",
    );
    await expect(service.saveCapture({ image: "data:image/jpeg;base64,AAAA" }, 1)).rejects.toThrow(
      "image must be jpeg",
    );
  });
});
