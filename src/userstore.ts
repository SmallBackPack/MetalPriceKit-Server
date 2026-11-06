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
//  身份是「双标识」，两个数含义完全不同，不能混：
//  - deviceId：客户端存在 Keychain 里的 UUID。卸载重装还在 → 算「装机基数」。
//  - vendorId：IDFV。同一台设备的所有 App 共用，重装会变 → 算「设备数」。
//  两者都用 HMAC 哈希后入库（见 identity.ts），库里不留原始设备标识。
//

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { hashIdentifier } from "./identity.ts";

/** 客户端上报的设备信息。全部可选，缺了就留空，不猜。 */
export interface DeviceMeta {
  /** IDFV。 */
  vendorId?: string;
  appVersion?: string;
  appBuild?: string;
  osVersion?: string;
  deviceModel?: string;
  locale?: string;
  timeZone?: string;
}

export interface UserRecord {
  id: string;
  nickname: string;
  settings: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
  /** 累计上报次数，也就是「这个装机启动过多少次 App」。 */
  sessionCount: number;
  vendorId: string | null;
  appVersion: string | null;
  appBuild: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  locale: string | null;
  timeZone: string | null;
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

export interface UserStoreOptions {
  /** 设备标识哈希用的服务端 pepper。 */
  pepper: string;
}

export class UserStore {
  /** 对外只读暴露：后台的统计查询要直接读这张库。 */
  readonly db: DatabaseSync;
  private readonly pepper: string;

  constructor(db: DatabaseSync, opts: UserStoreOptions) {
    this.db = db;
    this.pepper = opts.pepper;
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

      -- 日活表：每个用户每天一行。
      -- 为什么不用 last_seen_at 现算 DAU：那是「最后一次在哪天」，
      -- 一个用户上周装、周五打开一次，今天再问「今天有几个人活跃」就答不出来了。
      -- 要回答「今天有几个人」，必须有「哪天活跃过」的事实记录。
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id  TEXT    NOT NULL,
        date     TEXT    NOT NULL,
        sessions INTEGER NOT NULL DEFAULT 0,
        first_at TEXT    NOT NULL,
        last_at  TEXT    NOT NULL,
        PRIMARY KEY (user_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_date ON user_activity(date);
    `);

    // device_id 列是后补的（早期版本用 id 存设备号，而 id 实际写入的是随机值，
    // 导致幂等查找永远查不到）。老库补列后再建唯一索引。
    if (!hasColumn(db, "users", "device_id")) {
      db.exec(`ALTER TABLE users ADD COLUMN device_id TEXT`);
    }

    // 设备与 App 的元信息列也是后补的。
    // 用循环补而不是一条 ALTER TABLE ... ADD COLUMN, x, y —— SQLite 不支持一次加多列。
    const metaColumns: [string, string][] = [
      ["vendor_id", "TEXT"],
      ["app_version", "TEXT"],
      ["app_build", "TEXT"],
      ["os_version", "TEXT"],
      ["device_model", "TEXT"],
      ["locale", "TEXT"],
      ["time_zone", "TEXT"],
      ["session_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [column, type] of metaColumns) {
      if (!hasColumn(db, "users", column)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
      }
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device ON users(device_id);`);
  }

  /**
   * 按 deviceId 找用户，找不到就建一个。
   * 幂等：同一 deviceId 反复调用返回同一个 userId。
   *
   * deviceId 入库前先哈希，库里不留原始设备标识。
   */
  findOrCreateByDevice(
    deviceId: string,
    meta: DeviceMeta = {},
  ): { user: UserRecord; isNewUser: boolean } {
    const hashed = hashIdentifier(this.pepper, deviceId);
    // vendorId（IDFV）同样哈希后才入库 —— 库里不留任何原始设备标识。
    // 没上报时保持 undefined，库里就是空字符串，不会被算进设备数。
    const safeMeta: DeviceMeta = {
      ...meta,
      vendorId: meta.vendorId ? hashIdentifier(this.pepper, meta.vendorId) : undefined,
    };

    const existing = this.db
      .prepare(`SELECT id FROM users WHERE device_id = ?`)
      .get(hashed) as { id: string } | undefined;

    if (existing) {
      this.updateMeta(existing.id, safeMeta);
      this.recordActivity(existing.id);
      const user = this.getUser(existing.id)!;
      return { user, isNewUser: false };
    }

    const now = new Date().toISOString();
    const id = `u_${randomBytes(4).toString("hex")}`;
    const nickname = `用户 ${id.slice(2, 6)}`;
    this.db
      .prepare(
        `INSERT INTO users (id, device_id, nickname, settings, created_at, last_seen_at, session_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(id, hashed, nickname, JSON.stringify({}), now, now);
    this.applyMeta(id, safeMeta);
    this.recordActivity(id);
    return { user: this.getUser(id)!, isNewUser: true };
  }

  /**
   * 刷新设备元信息。
   *
   * 每次 auth 都覆盖 —— 客户端升级了 App 版本、换了机型，都应该立刻反映在统计里，
   * 而不是保留第一次注册时的旧值。
   *
   * vendorId 特殊：IDFV 在「卸载重装」后会变。如果直接覆盖，
   * 设备数会被高估成「装了多少次」。所以 vendorId 为空时不清空旧值，
   * 而是有新值才覆盖 —— 保留最后一次见到的 IDFV。
   */
  private updateMeta(id: string, meta: DeviceMeta): void {
    const current = this.getUser(id);
    if (!current) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE users SET
           app_version = ?, app_build = ?, os_version = ?, device_model = ?,
           locale = ?, time_zone = ?,
           vendor_id = COALESCE(?, vendor_id),
           session_count = session_count + 1,
           last_seen_at = ?
         WHERE id = ?`,
      )
      .run(
        meta.appVersion ?? current.appVersion ?? "",
        meta.appBuild ?? current.appBuild ?? "",
        meta.osVersion ?? current.osVersion ?? "",
        meta.deviceModel ?? current.deviceModel ?? "",
        meta.locale ?? current.locale ?? "",
        meta.timeZone ?? current.timeZone ?? "",
        meta.vendorId ?? null,
        now,
        id,
      );
  }

  /** 建用户时写入元信息。 */
  private applyMeta(id: string, meta: DeviceMeta): void {
    this.db
      .prepare(
        `UPDATE users SET
           vendor_id = ?, app_version = ?, app_build = ?, os_version = ?,
           device_model = ?, locale = ?, time_zone = ?
         WHERE id = ?`,
      )
      .run(
        meta.vendorId ?? "",
        meta.appVersion ?? "",
        meta.appBuild ?? "",
        meta.osVersion ?? "",
        meta.deviceModel ?? "",
        meta.locale ?? "",
        meta.timeZone ?? "",
        id,
      );
  }

  /**
   * 记一条活跃事实：用户今天活跃过。
   *
   * 一天多次启动就在同一天的行上累加，不新增行 ——
   * DAU 要的是「当天有多少个不同的人」，同一用户当天来 10 次也只算 1 个 DAU。
   */
  recordActivity(userId: string, at: Date = new Date()): void {
    const date = at.toISOString().slice(0, 10);
    const iso = at.toISOString();
    this.db
      .prepare(
        `INSERT INTO user_activity (user_id, date, sessions, first_at, last_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(user_id, date) DO UPDATE SET
           sessions = sessions + 1,
           last_at = excluded.last_at`,
      )
      .run(userId, date, iso, iso);
  }

  getUser(id: string): UserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, nickname, settings, created_at, last_seen_at, session_count,
                vendor_id, app_version, app_build, os_version, device_model, locale, time_zone
         FROM users WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          nickname: string;
          settings: string;
          created_at: string;
          last_seen_at: string;
          session_count: number | null;
          vendor_id: string | null;
          app_version: string | null;
          app_build: string | null;
          os_version: string | null;
          device_model: string | null;
          locale: string | null;
          time_zone: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      nickname: row.nickname,
      settings: JSON.parse(row.settings) as Record<string, unknown>,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      sessionCount: row.session_count ?? 0,
      vendorId: nullIfEmpty(row.vendor_id),
      appVersion: nullIfEmpty(row.app_version),
      appBuild: nullIfEmpty(row.app_build),
      osVersion: nullIfEmpty(row.os_version),
      deviceModel: nullIfEmpty(row.device_model),
      locale: nullIfEmpty(row.locale),
      timeZone: nullIfEmpty(row.time_zone),
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
      // device_id 也存哈希：这张表同样不该出现原始设备标识。
      .run(hashToken(token), userId, hashIdentifier(this.pepper, deviceId), new Date(now).toISOString(), expiresAt);
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

  insertCrash(userId: string | null, payload: unknown): void {
    const id = `cr_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO crash_reports (id, user_id, payload, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, userId, JSON.stringify(payload), new Date().toISOString());
  }

  insertEvents(userId: string | null, sessionId: string | null, payload: unknown): void {
    const id = `ev_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO event_batches (id, user_id, session_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, sessionId, JSON.stringify(payload), new Date().toISOString());
  }
}

function formatStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** 空字符串统一当成「没有值」，避免统计里出现一堆空字符串分组。 */
function nullIfEmpty(value: string | null): string | null {
  if (value === null || value === "") return null;
  return value;
}

/** 表里有没有这一列。用于「早期版本缺列」的兼容补列。 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}
