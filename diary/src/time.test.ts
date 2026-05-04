import { describe, expect, test } from "bun:test";
import { timestampJst, todayJst } from "./time.ts";

describe("JST date helpers", () => {
  test("formats date in Asia/Tokyo", () => {
    expect(todayJst(new Date("2026-05-04T15:00:00.000Z"))).toBe("2026-05-05");
  });

  test("formats timestamp with file-safe separators", () => {
    expect(timestampJst(new Date("2026-05-04T15:01:02.000Z"))).toBe("2026-05-05T00-01-02");
  });
});
