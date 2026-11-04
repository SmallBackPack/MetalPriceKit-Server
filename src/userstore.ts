//
//  userstore.ts
//  MetalPriceKit Server
//  匿名用户、token、反馈、崩溃与埋点的持久化。
//
//  token 存哈希不存明文：库被拖走了也不能直接冒用某个用户。
//  deviceId 幂等：同一台设备重复注册拿到同一个 userId，符合「匿名用户」的定位。
//
//  v1 不做账号体系 —— 契约里 auth/anonymous 是唯一入口，
//  客户端不需要登录页，首启自动调一次即可。
//

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

export interface UserRecord {
  id: string;
  nickname: string;
  settings: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
}

export interface StoredToken {
  tokenHash: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** token 有效期 1 年。过期后客户端重新调 auth/anonymous 换新的即可，不需要 refresh 接口。 */
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class UserStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // 建表放在构造函数里：漏调 migrate 会让接口直接 500，
    // 这种错不该由调用方替我们记住。
    UserStore.migrate(db);
  }

  static migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        device_id    TEXT,
        nickname     TEXT NOT NULL,
        settings     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_tokens (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        device_id    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_tokens_device ON user_tokens(device_id);

      CREATE TABLE IF NOT EXISTS feedback (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        category   TEXT NOT NULL,
        content    TEXT NOT NULL,
        contact    TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        app_state  TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crash_reports (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_batches (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        session_id TEXT,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // device_id 列是后补的（早期版本用 id 存设备号，而 id 实际写入的是随机值，
    // 导致幂等查找永远查不到）。老库补列后再建唯一索引。
    if (!hasColumn(db, "users", "device_id")) {
      db.exec(`ALTER TABLE users ADD COLUMN device_id TEXT`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device ON users(device_id);`);
  }

  /**
   * 按 deviceId 找用户，找不到就建一个。
   * 幂等：同一 deviceId 反复调用返回同一个 userId。
   */
  findOrCreateByDevice(deviceId: string): { user: UserRecord; isNewUser: boolean } {
    const existing = this.db
      .prepare(`SELECT id FROM users WHERE device_id = ?`)
      .get(deviceId) as { id: string } | undefined;

    if (existing) {
      const user = this.getUser(existing.id)!;
      this.touchUser(user.id);
      return { user, isNewUser: false };
    }

    const now = new Date().toISOString();
    const id = `u_${randomBytes(4).toString("hex")}`;
    const nickname = `用户 ${id.slice(2, 6)}`;
    this.db
      .prepare(
        `INSERT INTO users (id, device_id, nickname, settings, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, deviceId, nickname, JSON.stringify({}), now, now);
    return { user: this.getUser(id)!, isNewUser: true };
  }

  getUser(id: string): UserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, nickname, settings, created_at, last_seen_at FROM users WHERE id = ?`,
      )
      .get(id) as
      | { id: string; nickname: string; settings: string; created_at: string; last_seen_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      nickname: row.nickname,
      settings: JSON.parse(row.settings) as Record<string, unknown>,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  touchUser(id: string): void {
    this.db
      .prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /** 部分更新：只覆盖传入的字段，没传的保持原值。 */
  updateUser(
    id: string,
    patch: { nickname?: string; settings?: Record<string, unknown> },
  ): UserRecord | null {
    const current = this.getUser(id);
    if (!current) return null;
    const nickname = patch.nickname ?? current.nickname;
    const settings = JSON.stringify(patch.settings ?? current.settings);
    this.db
      .prepare(`UPDATE users SET nickname = ?, settings = ?, last_seen_at = ? WHERE id = ?`)
      .run(nickname, settings, new Date().toISOString(), id);
    return this.getUser(id);
  }

  /** 签发 token。返回明文 token —— 只在这一刻存在，库里只留哈希。 */
  issueToken(userId: string, deviceId: string): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO user_tokens (token_hash, user_id, device_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(hashToken(token), userId, deviceId, new Date(now).toISOString(), expiresAt);
    return { token, expiresAt };
  }

  /** 校验 token，返回对应用户。过期或不存在都返回 null。 */
  resolveToken(token: string): UserRecord | null {
    const row = this.db
      .prepare(
        `SELECT user_id, expires_at FROM user_tokens WHERE token_hash = ?`,
      )
      .get(hashToken(token)) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    this.db
      .prepare(`UPDATE user_tokens SET last_used_at = ? WHERE token_hash = ?`)
      .run(new Date().toISOString(), hashToken(token));
    const user = this.getUser(row.user_id);
    if (user) this.touchUser(user.id);
    return user;
  }

  /** 同一用户签发过多少个 token（对应「设备数」）。 */
  deviceCount(userId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ?`)
      .get(userId) as { n: number };
    return row.n;
  }

  // ── 反馈 / 崩溃 / 埋点 ─────────────────────────────────────────

  insertFeedback(input: {
    userId: string | null;
    category: string;
    content: string;
    contact?: string;
    attachments?: unknown[];
    appState?: unknown;
  }): string {
    const id = `fb_${formatStamp(new Date())}_${randomBytes(2).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO feedback (id, user_id, category, content, contact, attachments, app_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.category,
        input.content,
        input.contact ?? "",
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(input.appState ?? {}),
        new Date().toISOString(),
      );
    return id;
  }

  insertCrash(userId: string | null, payload: unknown): string {
    const id = `cr_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO crash_reports (id, user_id, payload, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, userId, JSON.stringify(payload), new Date().toISOString());
    return id;
  }

  insertEvents(userId: string | null, sessionId: string | null, payload: unknown): string {
    const id = `ev_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO event_batches (id, user_id, session_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, sessionId, JSON.stringify(payload), new Date().toISOString());
    return id;
  }
}

function formatStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 表里有没有这一列。用于「早期版本缺列」的兼容补列。 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}
