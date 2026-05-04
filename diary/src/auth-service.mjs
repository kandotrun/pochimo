import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const SESSION_DAYS = 30;

export class AuthService {
  constructor({ dataDir }) {
    this.db = new DatabaseSync(path.join(dataDir, 'auth.sqlite'));
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        household_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS pet_profiles (
        user_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        photo TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS household_settings (
        household_id INTEGER PRIMARY KEY,
        mischief_email_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        created_by INTEGER NOT NULL,
        used_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        used_at TEXT,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(used_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS login_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        invite_code TEXT,
        expires_at INTEGER NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email, expires_at);
    `);

    this.#ensureColumn('users', 'household_id', 'INTEGER');
    this.db.prepare('UPDATE users SET household_id = id WHERE household_id IS NULL').run();
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  hasUsers() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0;
  }

  listUsers() {
    return this.db.prepare('SELECT id, username, household_id AS householdId FROM users ORDER BY id ASC').all();
  }

  listHouseholdUsers(householdId) {
    return this.db.prepare('SELECT id, username FROM users WHERE household_id = ? ORDER BY id ASC').all(Number(householdId));
  }

  createFirstUser({ username, password }) {
    if (this.hasUsers()) throw new Error('user already exists');
    return this.#createUser({ username, password });
  }

  createUserWithInvite({ username, password, inviteCode }) {
    validateInviteCode(inviteCode);
    const invite = this.db.prepare(`
      SELECT invites.code, invites.used_by, users.household_id AS householdId
      FROM invites
      JOIN users ON users.id = invites.created_by
      WHERE invites.code = ?
    `).get(inviteCode.trim());
    if (!invite || invite.used_by) throw new Error('invalid invite code');

    const user = this.#createUser({ username, password, householdId: invite.householdId });
    this.db.prepare('UPDATE invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ?').run(user.id, invite.code);
    return user;
  }

  #createUser({ username, password, householdId = null }) {
    validateUsername(username);
    validatePassword(password);

    const passwordHash = hashPassword(password);
    const result = this.db.prepare('INSERT INTO users (username, password_hash, household_id) VALUES (?, ?, ?)').run(username.trim(), passwordHash, householdId);
    const id = Number(result.lastInsertRowid);
    if (householdId == null) this.db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(id, id);
    return { id, username: username.trim(), householdId: householdId || id };
  }

  createEmailLoginCode({ email, inviteCode = '' }) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedInvite = String(inviteCode || '').trim();

    const user = this.db.prepare('SELECT id FROM users WHERE username = ?').get(normalizedEmail);
    if (!user && this.hasUsers()) {
      if (!normalizedInvite) return genericSkippedLoginCode(normalizedEmail);
      const invite = this.db.prepare('SELECT code, used_by FROM invites WHERE code = ?').get(normalizedInvite);
      if (!invite || invite.used_by) return genericSkippedLoginCode(normalizedEmail);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.db.prepare('DELETE FROM login_codes WHERE expires_at < ? OR consumed_at IS NOT NULL').run(Date.now());
    this.db.prepare('INSERT INTO login_codes (email, code_hash, invite_code, expires_at) VALUES (?, ?, ?, ?)')
      .run(normalizedEmail, hashPassword(code), normalizedInvite || null, expiresAt);

    return { email: normalizedEmail, code, expiresAt };
  }

  verifyEmailLoginCode({ email, code, inviteCode = '' }) {
    const normalizedEmail = normalizeEmail(email);
    validateLoginCode(code);
    const normalizedInvite = String(inviteCode || '').trim();

    const rows = this.db.prepare(`
      SELECT id, code_hash AS codeHash, invite_code AS inviteCode, expires_at AS expiresAt
      FROM login_codes
      WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY id DESC
      LIMIT 5
    `).all(normalizedEmail, Date.now());
    const loginCode = rows.find(row => String(row.inviteCode || '') === normalizedInvite && verifyPassword(code, row.codeHash));
    if (!loginCode) throw new Error('invalid or expired code');

    this.db.prepare('UPDATE login_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?').run(loginCode.id);

    let user = this.db.prepare('SELECT id, username, household_id AS householdId FROM users WHERE username = ?').get(normalizedEmail);
    if (!user) {
      if (!this.hasUsers()) {
        user = this.#createEmailUser({ email: normalizedEmail });
      } else {
        user = this.#createEmailUserWithInvite({ email: normalizedEmail, inviteCode: normalizedInvite });
      }
    }

    return this.#createSession(user);
  }

  #createEmailUser({ email, householdId = null }) {
    const result = this.db.prepare('INSERT INTO users (username, password_hash, household_id) VALUES (?, ?, ?)')
      .run(email, 'email-code-login', householdId);
    const id = Number(result.lastInsertRowid);
    if (householdId == null) this.db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(id, id);
    return { id, username: email, householdId: householdId || id };
  }

  #createEmailUserWithInvite({ email, inviteCode }) {
    validateInviteCode(inviteCode);
    const invite = this.db.prepare(`
      SELECT invites.code, invites.used_by, users.household_id AS householdId
      FROM invites
      JOIN users ON users.id = invites.created_by
      WHERE invites.code = ?
    `).get(inviteCode.trim());
    if (!invite || invite.used_by) throw new Error('invalid invite code');

    const user = this.#createEmailUser({ email, householdId: invite.householdId });
    this.db.prepare('UPDATE invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ?').run(user.id, invite.code);
    return user;
  }

  login({ username, password }) {
    validateUsername(username);
    validatePassword(password);

    const user = this.db.prepare('SELECT id, username, password_hash, household_id AS householdId FROM users WHERE username = ?').get(username.trim());
    if (!user || !verifyPassword(password, user.password_hash)) throw new Error('invalid username or password');

    return this.#createSession(user);
  }

  #createSession(user) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);
    return { token, expiresAt, user: { id: user.id, username: user.username, householdId: user.householdId } };
  }

  logout(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  getUserByToken(token) {
    if (!token) return null;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

    return this.db.prepare(`
      SELECT users.id, users.username, users.household_id AS householdId
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `).get(token, Date.now()) || null;
  }

  createInvite(createdBy) {
    const code = randomBytes(12).toString('base64url');
    this.db.prepare('INSERT INTO invites (code, created_by) VALUES (?, ?)').run(code, createdBy);
    return this.getInvite(code);
  }

  getInvite(code) {
    return this.db.prepare(`
      SELECT invites.code, invites.created_at AS createdAt, invites.used_at AS usedAt,
             creator.username AS createdBy, used.username AS usedBy
      FROM invites
      JOIN users creator ON creator.id = invites.created_by
      LEFT JOIN users used ON used.id = invites.used_by
      WHERE invites.code = ?
    `).get(code) || null;
  }

  listInvites(userId) {
    return this.db.prepare(`
      SELECT invites.code, invites.created_at AS createdAt, invites.used_at AS usedAt,
             used.username AS usedBy
      FROM invites
      LEFT JOIN users used ON used.id = invites.used_by
      WHERE invites.created_by = ?
      ORDER BY invites.created_at DESC
      LIMIT 20
    `).all(userId);
  }

  getPetProfile(userId, householdId = userId) {
    const own = this.db.prepare('SELECT name, photo, updated_at AS updatedAt FROM pet_profiles WHERE user_id = ?').get(userId);
    if (own?.name?.trim()) return own;

    const shared = this.db.prepare(`
      SELECT pet_profiles.name, pet_profiles.photo, pet_profiles.updated_at AS updatedAt
      FROM users
      JOIN pet_profiles ON pet_profiles.user_id = users.id
      WHERE users.household_id = ? AND pet_profiles.name != ''
      ORDER BY users.id ASC
      LIMIT 1
    `).get(Number(householdId));

    return shared || own || { name: '', photo: '', updatedAt: null };
  }

  savePetProfile(userId, { name = '', photo = '' }, householdId = userId) {
    if (String(photo || '').length > 2_000_000) throw new Error('photo is too large');

    const householdUsers = this.listHouseholdUsers(householdId);
    const targetUserIds = householdUsers.length ? householdUsers.map(user => user.id) : [userId];
    const stmt = this.db.prepare(`
      INSERT INTO pet_profiles (user_id, name, photo, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        name = excluded.name,
        photo = excluded.photo,
        updated_at = CURRENT_TIMESTAMP
    `);

    for (const targetUserId of targetUserIds) {
      stmt.run(targetUserId, String(name || '').trim(), String(photo || ''));
    }

    return this.getPetProfile(userId, householdId);
  }

  getHouseholdSettings(householdId) {
    const row = this.db.prepare(`
      SELECT household_id AS householdId, mischief_email_enabled AS mischiefEmailEnabled, updated_at AS updatedAt
      FROM household_settings
      WHERE household_id = ?
    `).get(Number(householdId));

    return {
      householdId: Number(householdId),
      mischiefEmailEnabled: row ? Boolean(row.mischiefEmailEnabled) : true,
      updatedAt: row?.updatedAt || null
    };
  }

  saveHouseholdSettings(householdId, patch = {}) {
    const current = this.getHouseholdSettings(householdId);
    const mischiefEmailEnabled = patch.mischiefEmailEnabled == null
      ? current.mischiefEmailEnabled
      : Boolean(patch.mischiefEmailEnabled);

    this.db.prepare(`
      INSERT INTO household_settings (household_id, mischief_email_enabled, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(household_id) DO UPDATE SET
        mischief_email_enabled = excluded.mischief_email_enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(Number(householdId), mischiefEmailEnabled ? 1 : 0);

    return this.getHouseholdSettings(householdId);
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    if (index === -1) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `pet_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return 'pet_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, encoded) {
  const [scheme, salt, key] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;

  const actual = Buffer.from(scryptSync(password, salt, 64).toString('base64url'));
  const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateUsername(username) {
  if (!String(username || '').trim()) throw new Error('username is required');
}

function validatePassword(password) {
  if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
}

function normalizeEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('valid email is required');
  return normalized;
}

function validateLoginCode(code) {
  if (!/^\d{6}$/.test(String(code || '').trim())) throw new Error('code must be 6 digits');
}

function validateInviteCode(inviteCode) {
  if (!String(inviteCode || '').trim()) throw new Error('invite code is required');
}

function genericSkippedLoginCode(email) {
  return {
    email,
    code: '',
    expiresAt: Date.now() + 10 * 60 * 1000,
    skipped: true
  };
}
