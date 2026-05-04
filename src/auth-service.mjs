import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        created_by INTEGER NOT NULL,
        used_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        used_at TEXT,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(used_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `);
  }

  hasUsers() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0;
  }

  listUsers() {
    return this.db.prepare('SELECT id, username FROM users ORDER BY id ASC').all();
  }

  createFirstUser({ username, password }) {
    if (this.hasUsers()) throw new Error('user already exists');
    return this.#createUser({ username, password });
  }

  createUserWithInvite({ username, password, inviteCode }) {
    validateInviteCode(inviteCode);
    const invite = this.db.prepare('SELECT code, used_by FROM invites WHERE code = ?').get(inviteCode.trim());
    if (!invite || invite.used_by) throw new Error('invalid invite code');

    const user = this.#createUser({ username, password });
    this.db.prepare('UPDATE invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ?').run(user.id, invite.code);
    return user;
  }

  #createUser({ username, password }) {
    validateUsername(username);
    validatePassword(password);

    const passwordHash = hashPassword(password);
    const result = this.db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username.trim(), passwordHash);
    return { id: Number(result.lastInsertRowid), username: username.trim() };
  }

  login({ username, password }) {
    validateUsername(username);
    validatePassword(password);

    const user = this.db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username.trim());
    if (!user || !verifyPassword(password, user.password_hash)) throw new Error('invalid username or password');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);
    return { token, expiresAt, user: { id: user.id, username: user.username } };
  }

  logout(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  getUserByToken(token) {
    if (!token) return null;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

    return this.db.prepare(`
      SELECT users.id, users.username
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

  getPetProfile(userId) {
    return this.db.prepare('SELECT name, photo, updated_at AS updatedAt FROM pet_profiles WHERE user_id = ?').get(userId)
      || { name: '', photo: '', updatedAt: null };
  }

  savePetProfile(userId, { name = '', photo = '' }) {
    if (String(photo || '').length > 2_000_000) throw new Error('photo is too large');

    this.db.prepare(`
      INSERT INTO pet_profiles (user_id, name, photo, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        name = excluded.name,
        photo = excluded.photo,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, String(name || '').trim(), String(photo || ''));

    return this.getPetProfile(userId);
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
  return `pet_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return 'pet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
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

function validateInviteCode(inviteCode) {
  if (!String(inviteCode || '').trim()) throw new Error('invite code is required');
}
