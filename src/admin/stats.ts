//
//  stats.ts
//  MetalPriceKit Server
//  后台的统计查询。
//
//  这一层的存在意义是「把口径定死」。
//  装机基数、活跃装机、设备数、DAU、MAU —— 这五个数看起来都在数「人」，
//  但含义完全不同，混在一起报就会得出「我们有 10 万用户」这种谁也看不懂的话。
//  所以每条查询都在自己名字旁边写清楚它数的是什么。
//
//  数据来源两张表：
//  - users：装机基数、版本/地区分布、活跃装机。
//  - user_activity：日活。必须有它才能回答「今天有多少人用过」——
//    last_seen_at 只记「最后一次在哪天」，答不了「今天」。
//

import type { DatabaseSync } from "node:sqlite";

export interface Overview {
  /** 装机基数：累计注册过的装机数。卸载重装算同一个（Keychain 里的 UUID 不变）。 */
  installBase: number;
  /** 近 7 天有访问的装机数。 */
  activeInstalls7d: number;
  /** 近 30 天有访问的装机数。 */
  activeInstalls30d: number;
  /** 设备数：按 IDFV 去重的物理设备数。同机装过多次只算一台。 */
  deviceCount: number;
  /** 今日活跃用户数（DAU）。 */
  dau: number;
  /** 近 30 天活跃过的不同用户数（MAU）。 */
  mau: number;
  /** 今日新增装机数。 */
  newToday: number;
  /** 近 7 天新增装机数。 */
  newLast7d: number;
  /** 累计启动次数。 */
  totalSessions: number;
}

export interface BreakdownRow {
  label: string;
  count: number;
  /** 占装机基数的百分比，保留一位小数。 */
  share: number;
}

export interface DailyRow {
  date: string;
  dau: number;
}

export interface AdminStats {
  overview: Overview;
  /** 最近若干天的日活，按日期升序，缺失的日期补 0。 */
  daily: DailyRow[];
  byVersion: BreakdownRow[];
  byLocale: BreakdownRow[];
  byOsVersion: BreakdownRow[];
  byDeviceModel: BreakdownRow[];
  generatedAt: string;
}

export interface UserRow {
  id: string;
  nickname: string;
  createdAt: string;
  lastSeenAt: string;
  sessionCount: number;
  appVersion: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  locale: string | null;
}

export interface UserListResult {
  total: number;
  rows: UserRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 一次性把所有统计查出来。看板只调一次，不做十几次往返。 */
export function collectStats(db: DatabaseSync, opts: { days?: number } = {}): AdminStats {
  const days = Math.min(Math.max(opts.days ?? 14, 1), 90);
  const now = new Date();
  const today = utcDate(now);

  const installBase = count(db, `SELECT COUNT(*) AS n FROM users`);
  const activeInstalls7d = count(
    db,
    `SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`,
    [new Date(now.getTime() - 7 * DAY_MS).toISOString()],
  );
  const activeInstalls30d = count(
    db,
    `SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`,
    [new Date(now.getTime() - 30 * DAY_MS).toISOString()],
  );
  const deviceCount = count(
    db,
    `SELECT COUNT(DISTINCT vendor_id) AS n FROM users WHERE vendor_id IS NOT NULL AND vendor_id <> ''`,
  );
  const dau = count(db, `SELECT COUNT(*) AS n FROM user_activity WHERE date = ?`, [today]);
  const mau = count(
    db,
    `SELECT COUNT(DISTINCT user_id) AS n FROM user_activity WHERE date >= ?`,
    [utcDate(new Date(now.getTime() - 29 * DAY_MS))],
  );
  const newToday = count(db, `SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, [
    `${today}T00:00:00.000Z`,
  ]);
  const newLast7d = count(db, `SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, [
    new Date(now.getTime() - 7 * DAY_MS).toISOString(),
  ]);
  const totalSessions = count(db, `SELECT COALESCE(SUM(sessions), 0) AS n FROM user_activity`);

  const overview: Overview = {
    installBase,
    activeInstalls7d,
    activeInstalls30d,
    deviceCount,
    dau,
    mau,
    newToday,
    newLast7d,
    totalSessions,
  };

  return {
    overview,
    daily: dailySeries(db, days, now),
    byVersion: breakdown(db, "app_version", installBase),
    byLocale: breakdown(db, "locale", installBase),
    byOsVersion: breakdown(db, "os_version", installBase),
    byDeviceModel: breakdown(db, "device_model", installBase),
    generatedAt: now.toISOString(),
  };
}

/**
 * 日活序列。
 *
 * 缺失的日期补 0 —— 不补的话折线/列表会在「没人用的那天」直接断掉，
 * 看的人会以为数据丢了。
 */
export function dailySeries(db: DatabaseSync, days: number, now: Date): DailyRow[] {
  const from = utcDate(new Date(now.getTime() - (days - 1) * DAY_MS));
  const rows = db
    .prepare(`SELECT date, COUNT(*) AS n FROM user_activity WHERE date >= ? GROUP BY date`)
    .all(from) as { date: string; n: number }[];
  const map = new Map(rows.map((r) => [r.date, r.n]));

  const result: DailyRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = utcDate(new Date(now.getTime() - i * DAY_MS));
    result.push({ date, dau: map.get(date) ?? 0 });
  }
  return result;
}

/**
 * 按某个字段分组统计。
 *
 * 空值统一归到「未知」—— 客户端没上报的版本号是常态，
 * 散成十几个空字符串分组就没法看了。
 */
export function breakdown(db: DatabaseSync, column: string, total: number): BreakdownRow[] {
  // column 来自代码里的白名单，不接受外部输入。
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(${column}, ''), '未知') AS label, COUNT(*) AS n
       FROM users GROUP BY label ORDER BY n DESC LIMIT 12`,
    )
    .all() as { label: string; n: number }[];

  return rows.map((r) => ({
    label: r.label,
    count: r.n,
    share: total > 0 ? Math.round((r.n / total) * 1000) / 10 : 0,
  }));
}

/** 用户列表。支持按昵称或 userId 搜索。 */
export function listUsers(
  db: DatabaseSync,
  opts: { q?: string; limit?: number; offset?: number } = {},
): UserListResult {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.q ?? "").trim();

  const where = q ? `WHERE nickname LIKE ? OR id LIKE ?` : "";
  const params = q ? [`%${q}%`, `%${q}%`] : [];

  const total = count(db, `SELECT COUNT(*) AS n FROM users ${where}`, params);
  const rows = db
    .prepare(
      `SELECT id, nickname, created_at, last_seen_at, session_count,
              app_version, os_version, device_model, locale
       FROM users ${where}
       ORDER BY last_seen_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    id: string;
    nickname: string;
    created_at: string;
    last_seen_at: string;
    session_count: number | null;
    app_version: string | null;
    os_version: string | null;
    device_model: string | null;
    locale: string | null;
  }[];

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      nickname: r.nickname,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      sessionCount: r.session_count ?? 0,
      appVersion: nullIfEmpty(r.app_version),
      osVersion: nullIfEmpty(r.os_version),
      deviceModel: nullIfEmpty(r.device_model),
      locale: nullIfEmpty(r.locale),
    })),
  };
}

/** CSV 导出用的全量列表。上限保护 —— 导出百万行会把内存吃光。 */
export function listUsersForExport(db: DatabaseSync, q: string, cap = 20000): UserRow[] {
  return listUsers(db, { q, limit: cap, offset: 0 }).rows;
}

function count(db: DatabaseSync, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n: number } | undefined;
  return row?.n ?? 0;
}

function nullIfEmpty(value: string | null): string | null {
  if (value === null || value === "") return null;
  return value;
}
