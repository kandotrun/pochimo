import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthService, parseCookies, sessionCookie } from "./auth-service.ts";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

async function newAuthService() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pochimo-auth-"));
  return new AuthService({ dataDir: tempDir });
}

describe("AuthService", () => {
  test("creates first user, logs in, and resolves session token", async () => {
    const auth = await newAuthService();

    const user = auth.createFirstUser({ username: "kan@example.com", password: "password123" });
    const session = auth.login({ username: "kan@example.com", password: "password123" });

    expect(user.householdId).toBe(user.id);
    expect(session.token.length).toBeGreaterThan(20);
    expect(auth.getUserByToken(session.token)).toEqual({
      id: user.id,
      username: "kan@example.com",
      householdId: user.id,
    });
  });

  test("invite user joins creator household", async () => {
    const auth = await newAuthService();

    const owner = auth.createFirstUser({ username: "owner@example.com", password: "password123" });
    const invite = auth.createInvite(owner.id);
    const member = auth.createUserWithInvite({
      username: "member@example.com",
      password: "password123",
      inviteCode: invite.code,
    });

    expect(member.householdId).toBe(owner.householdId);
    expect(auth.listHouseholdUsers(owner.householdId).map((item: any) => item.username)).toEqual([
      "owner@example.com",
      "member@example.com",
    ]);
  });

  test("email login code requires invite after bootstrap", async () => {
    const auth = await newAuthService();

    auth.createFirstUser({ username: "owner@example.com", password: "password123" });
    const skipped = auth.createEmailLoginCode({ email: "new@example.com" });

    expect(skipped).toMatchObject({ email: "new@example.com", code: "", skipped: true });
  });

  test("cookie helpers parse and emit secure session cookie", () => {
    const cookie = sessionCookie("token value", Date.now() + 60_000);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(parseCookies({ headers: { cookie: "a=1; pet_session=token%20value" } })).toEqual({
      a: "1",
      pet_session: "token value",
    });
  });
});
