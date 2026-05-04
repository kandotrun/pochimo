import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AbService } from "./ab-service.ts";
import { readJson, writeJson } from "./json-store.ts";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

async function newAbService() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-ab-"));
  return new AbService({ dataDir: tempDir });
}

describe("AbService", () => {
  test("chooseVariant honors existing cookie and increments views", async () => {
    const service = await newAbService();

    const result = await service.chooseVariant({ ab_lp_visual: "dog-figure" });
    const state = await readJson<any>(path.join(tempDir, "ab-tests.json"), null);

    expect(result.variant.id).toBe("dog-figure");
    expect(result.shouldSetCookie).toBe(false);
    expect(state.tests.lp_visual.variants["dog-figure"].views).toBe(1);
  });

  test("recordConversion rejects unknown variants", async () => {
    const service = await newAbService();

    expect(await service.recordConversion("missing" as any)).toEqual({ ok: false });
  });

  test("summary picks winner after enough views", async () => {
    const service = await newAbService();
    await writeJson(path.join(tempDir, "ab-tests.json"), {
      tests: {
        lp_visual: {
          variants: {
            "dog-figure": { views: 100, conversions: 10 },
            "stair-illustration": { views: 100, conversions: 20 },
          },
        },
      },
    });

    const summary = await service.summary();

    expect(summary.winner?.id).toBe("stair-illustration");
  });
});
