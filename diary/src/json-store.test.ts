import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileExists, readJson, writeJson } from "./json-store.ts";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("json-store", () => {
  test("writes nested JSON and reads it back", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-json-"));
    const file = path.join(tempDir, "nested", "state.json");

    await writeJson(file, { ok: true, count: 2 });

    expect(await fileExists(file)).toBe(true);
    expect(await readJson(file, {})).toEqual({ ok: true, count: 2 });
  });

  test("returns fallback when file does not exist or is invalid", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-json-"));
    expect(await readJson(path.join(tempDir, "missing.json"), { fallback: true })).toEqual({ fallback: true });
  });
});
