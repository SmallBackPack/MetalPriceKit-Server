//
//  pages.ts
//  MetalPriceKit Server
//  后台的三个页面：看板、用户、配置控制台。
//
//  页面刻意做得很素：纯文字和表格，没有图表。
//  运营要看的是「有多少人、什么版本、哪里的人」，几个数字加几张表就够了，
//  画成图反而要多引一套图表库还得处理 CDN 不稳的问题。
//

import type { AdminStats, UserListResult } from "./stats.ts";
import type { BackupInfo } from "../configstore.ts";
import {
  escapeHtml,
  formatDateTime,
  formatNumber,
  formatRelative,
  layout,
  notice,
  type NavItem,
} from "./render.ts";

const NAV: NavItem[] = [
  { href: "/admin/dashboard", label: "看板", active: false },
  { href: "/admin/users", label: "用户", active: false },
  { href: "/admin/config", label: "配置", active: false },
];

function nav(active: string): NavItem[] {
  return NAV.map((item) => ({
    ...item,
    active: item.href === active || (active === "/admin/dashboard" && item.href === "/admin/dashboard"),
  }));
}

/** 登录页。 */
export function loginPage(error: string | null): string {
  const body = `
<div class="login-wrap">
  <h1>MetalPriceKit 后台</h1>
  ${notice("error", error ?? "")}
  <form method="post" action="/admin/login" class="login-form">
    <label for="token">管理口令</label>
    <input type="password" id="token" name="token" autocomplete="current-password" autofocus required>
    <button type="submit">进入</button>
  </form>
  <p class="hint">口令由服务端环境变量 <code>MPK_ADMIN_TOKEN</code> 决定。后台只监听本机，远程访问请走 SSH 隧道。</p>
</div>`;
  return layout({ title: "登录", nav: [], csrf: "", body, bare: true });
}

/** 看板。 */
export function dashboardPage(stats: AdminStats, csrf: string): string {
  const o = stats.overview;

  const kpis = [
    { label: "装机基数", value: o.installBase, hint: "累计注册过的装机数。卸载重装算同一个。" },
    { label: "30 天活跃装机", value: o.activeInstalls30d, hint: "近 30 天有访问的装机数。" },
    { label: "设备数", value: o.deviceCount, hint: "按 IDFV 去重的物理设备数。同机装多次算一台。" },
    { label: "今日活跃 (DAU)", value: o.dau, hint: "今天有访问的用户数。" },
    { label: "30 天活跃 (MAU)", value: o.mau, hint: "近 30 天访问过的不同用户数。" },
    { label: "今日新增", value: o.newToday, hint: "今天首次注册的装机数。" },
  ];

  const body = `
<h1>看板</h1>
<p class="muted">数据截至 ${escapeHtml(formatDateTime(stats.generatedAt))}</p>

<section class="kpis">
${kpis
  .map(
    (k) => `<div class="kpi">
    <div class="kpi-value">${escapeHtml(formatNumber(k.value))}</div>
    <div class="kpi-label">${escapeHtml(k.label)}</div>
    <div class="kpi-hint">${escapeHtml(k.hint)}</div>
  </div>`,
  )
  .join("\n")}
</section>

<div class="grid-2">
  <section>
    <h2>日活</h2>
    <p class="muted">最近 ${escapeHtml(stats.daily.length)} 天（UTC 日期）。</p>
    <table class="data">
      <thead><tr><th>日期</th><th class="num">活跃用户</th></tr></thead>
      <tbody>
${stats.daily
  .map((d) => `<tr><td>${escapeHtml(d.date)}</td><td class="num">${escapeHtml(formatNumber(d.dau))}</td></tr>`)
  .join("\n")}
      </tbody>
    </table>
  </section>

  <section>
    <h2>其他</h2>
    <table class="data">
      <tbody>
        <tr><td>7 天活跃装机</td><td class="num">${escapeHtml(formatNumber(o.activeInstalls7d))}</td></tr>
        <tr><td>7 天新增装机</td><td class="num">${escapeHtml(formatNumber(o.newLast7d))}</td></tr>
        <tr><td>累计启动次数</td><td class="num">${escapeHtml(formatNumber(o.totalSessions))}</td></tr>
      </tbody>
    </table>
    <p class="hint">
      客户端侧的页面访问、功能点击等埋点走第三方平台（友盟 / TalkData 等），
      本后台不重复采集，也不做埋点分析。
    </p>
  </section>
</div>

<div class="grid-2">
${breakdownSection("App 版本分布", stats.byVersion)}
${breakdownSection("地区分布（客户端上报的语言）", stats.byLocale)}
${breakdownSection("iOS 版本分布", stats.byOsVersion)}
${breakdownSection("设备型号分布", stats.byDeviceModel)}
</div>

<p class="hint">
  装机基数与设备数不是一个数：同一个用户换手机会多一个设备，
  但重装 App 不会多一个装机。
</p>`;

  return layout({ title: "看板", nav: nav("/admin/dashboard"), csrf, body });
}

function breakdownSection(title: string, rows: { label: string; count: number; share: number }[]): string {
  if (rows.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p class="muted">暂无数据</p></section>`;
  }
  return `<section>
  <h2>${escapeHtml(title)}</h2>
  <table class="data">
    <thead><tr><th>取值</th><th class="num">装机数</th><th class="num">占比</th></tr></thead>
    <tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${escapeHtml(r.label)}</td><td class="num">${escapeHtml(formatNumber(r.count))}</td><td class="num">${escapeHtml(r.share)}%</td></tr>`,
  )
  .join("\n")}
    </tbody>
  </table>
</section>`;
}

/** 用户列表。 */
export function usersPage(opts: {
  result: UserListResult;
  csrf: string;
  q: string;
  limit: number;
  offset: number;
}): string {
  const { result, q, limit, offset } = opts;

  const rows = result.rows
    .map(
      (u) => `<tr>
      <td><code>${escapeHtml(u.id)}</code></td>
      <td>${escapeHtml(u.nickname)}</td>
      <td>${escapeHtml(formatDateTime(u.createdAt))}</td>
      <td>${escapeHtml(formatRelative(u.lastSeenAt))}</td>
      <td class="num">${escapeHtml(formatNumber(u.sessionCount))}</td>
      <td>${escapeHtml(u.appVersion ?? "—")}</td>
      <td>${escapeHtml(u.osVersion ?? "—")}</td>
      <td>${escapeHtml(u.deviceModel ?? "—")}</td>
      <td>${escapeHtml(u.locale ?? "—")}</td>
    </tr>`,
    )
    .join("\n");

  const total = result.total;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  const pager: string[] = [];
  if (offset > 0) {
    pager.push(pageLink("/admin/users", q, Math.max(0, offset - limit), limit, "上一页"));
  }
  if (offset + limit < total) {
    pager.push(pageLink("/admin/users", q, offset + limit, limit, "下一页"));
  }

  const body = `
<h1>用户</h1>
<form method="get" action="/admin/users" class="searchbar">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="按昵称或用户 ID 搜索">
  <input type="hidden" name="limit" value="${escapeHtml(limit)}">
  <button type="submit">搜索</button>
  ${q ? `<a href="/admin/users">清除</a>` : ""}
  <a href="/admin/api/users.csv${q ? `?q=${encodeURIComponent(q)}` : ""}" class="csv">导出 CSV</a>
</form>

<p class="muted">共 ${escapeHtml(formatNumber(total))} 条，显示第 ${escapeHtml(from)}–${escapeHtml(to)} 条。</p>

<table class="data">
  <thead>
    <tr>
      <th>用户 ID</th><th>昵称</th><th>注册时间</th><th>最后活跃</th>
      <th class="num">启动次数</th><th>版本</th><th>系统</th><th>机型</th><th>语言</th>
    </tr>
  </thead>
  <tbody>
${rows || `<tr><td colspan="9" class="muted">没有匹配的用户</td></tr>`}
  </tbody>
</table>

<div class="pager">${pager.join("")}</div>`;

  return layout({ title: "用户", nav: nav("/admin/users"), csrf: opts.csrf, body });
}

function pageLink(href: string, q: string, offset: number, limit: number, label: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `<a href="${escapeHtml(href)}?${escapeHtml(params.toString())}">${escapeHtml(label)}</a>`;
}

export interface ConfigView {
  configVersion: number;
  updatedAt: string | null;
  filePath: string;
  /** 下发给客户端的字段字典（有序）。 */
  values: Record<string, unknown>;
  /** 客户端实际收到的内容。 */
  preview: Record<string, unknown>;
  backups: BackupInfo[];
}

/** 配置控制台。 */
export function configPage(opts: {
  view: ConfigView;
  csrf: string;
  message: string | null;
  error: string | null;
  warnings: string[];
}): string {
  const { view, csrf } = opts;

  const entries = Object.entries(view.values);
  const keys = entries.map(([k]) => k);

  const editorRows = entries
    .map(([key, value]) => {
      const type = typeOf(value);
      const text = displayValue(value);
      return `<tr>
      <td><code>${escapeHtml(key)}</code></td>
      <td>
        <select name="t">
${(["string", "number", "boolean", "json", "null"] as const)
  .map((t) => `<option value="${t}"${t === type ? " selected" : ""}>${t}</option>`)
  .join("")}
        </select>
      </td>
      <td><textarea name="v" rows="${type === "json" ? 4 : 1}" spellcheck="false">${escapeHtml(text)}</textarea></td>
      <td>
        <select name="op">
          <option value="keep">保留</option>
          <option value="delete">删除</option>
        </select>
      </td>
    </tr>`;
    })
    .join("\n");

  const body = `
<h1>通用字段下发</h1>
${notice("error", opts.error ?? "")}
${notice("ok", opts.message ?? "")}
${opts.warnings.map((w) => notice("warn", w)).join("\n")}

<p class="muted">
  配置版本 <strong>v${escapeHtml(view.configVersion)}</strong> ·
  最后修改 ${escapeHtml(formatDateTime(view.updatedAt))} ·
  文件 <code>${escapeHtml(view.filePath)}</code>
</p>

<form method="post" action="/admin/config/save" class="config-form">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input type="hidden" name="keys" value='${escapeHtml(JSON.stringify(keys))}'>

  <table class="data config-table">
    <thead>
      <tr><th>字段名</th><th>类型</th><th>值</th><th>操作</th></tr>
    </thead>
    <tbody>
${editorRows || `<tr><td colspan="4" class="muted">配置里还没有任何字段</td></tr>`}
    </tbody>
  </table>

  <h2>新增字段</h2>
  <div class="newrow">
    <input type="text" name="newKey" placeholder="字段名，例如 announceText">
    <select name="newType">
      <option value="string">string</option>
      <option value="number">number</option>
      <option value="boolean">boolean</option>
      <option value="json">json</option>
    </select>
    <input type="text" name="newValue" placeholder="值">
    <button type="submit" name="action" value="add" class="secondary">新增并保存</button>
  </div>

  <p class="submitrow"><button type="submit" name="action" value="save">保存全部修改</button></p>
</form>

<h2>下发预览</h2>
<p class="muted">这是客户端调用通用字段接口时实际收到的内容（版本号与下划线开头的元信息不会下发）。</p>
<pre class="preview">${escapeHtml(JSON.stringify(view.preview, null, 2))}</pre>

<h2>历史备份</h2>
${
  view.backups.length === 0
    ? `<p class="muted">还没有备份。每次保存会自动备份上一份。</p>`
    : `<table class="data">
  <thead><tr><th>备份文件</th><th>版本</th><th>时间</th><th class="num">大小</th><th></th></tr></thead>
  <tbody>
${view.backups
  .map(
    (b) => `<tr>
    <td><code>${escapeHtml(b.file)}</code></td>
    <td>v${escapeHtml(b.configVersion)}</td>
    <td>${escapeHtml(formatDateTime(b.savedAt))}</td>
    <td class="num">${escapeHtml(b.sizeBytes)} B</td>
    <td>
      <form method="post" action="/admin/config/restore" class="inline">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="backup" value="${escapeHtml(b.file)}">
        <button type="submit" class="secondary">回滚</button>
      </form>
    </td>
  </tr>`,
  )
  .join("\n")}
  </tbody>
</table>`
}
<p class="hint">回滚会恢复备份里的内容，但配置版本号继续 +1（不回退），否则客户端会以为本地缓存仍是最新的。</p>`;

  return layout({ title: "配置", nav: nav("/admin/config"), csrf, body });
}

/** 值的类型。控制台按类型给不同的编辑方式。 */
export function typeOf(value: unknown): "string" | "number" | "boolean" | "json" | "null" {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "json";
}

/** 编辑框里显示的值。 */
export function displayValue(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}
