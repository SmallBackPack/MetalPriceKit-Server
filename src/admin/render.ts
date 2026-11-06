//
//  render.ts
//  MetalPriceKit Server
//  后台页面的 HTML 骨架。
//
//  为什么自己拼 HTML 而不是引框架：
//  后台一共三个页面（看板 / 用户 / 配置），内容是表格和表单。
//  组件化和状态管理用不上。为了这三页引入 React/Vue 会多出一整套构建步骤
//  （vite/esbuild + node_modules + dist 产物），部署从「node src/index.ts」
//  变成「先构建再启动」—— 对后台来说是净负担。
//  页面结构简单到可以直接写成字符串，浏览器原生就能处理表单提交，
//  连 JS 都可以不要。
//
//  所有插值一律走 escapeHtml：nickname 是用户可控内容，
//  直接拼进 HTML 就是存储型 XSS。
//

export interface NavItem {
  href: string;
  label: string;
  active: boolean;
}

/** HTML 文本转义。 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 整页骨架。
 *
 * csrf 作为 meta 标签塞进页面：表单提交时原样带回，服务端跟 cookie 比对。
 * 跨站攻击者读不到我们的页面，也就填不出这个值 —— 这是 CSRF 防护的前提。
 */
export function layout(opts: {
  title: string;
  nav: NavItem[];
  csrf: string;
  body: string;
  /** 登录页没有导航也没有 csrf。 */
  bare?: boolean;
}): string {
  const navHtml = opts.bare
    ? ""
    : `<nav class="nav">${opts.nav
        .map(
          (item) =>
            `<a href="${escapeHtml(item.href)}" class="${item.active ? "active" : ""}">${escapeHtml(item.label)}</a>`,
        )
        .join("")}<form method="post" action="/admin/logout" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}"><button type="submit" class="linklike">退出</button></form></nav>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${escapeHtml(opts.csrf)}">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(opts.title)} · MetalPriceKit 后台</title>
<link rel="stylesheet" href="/admin/static/admin.css">
</head>
<body${opts.bare ? ' class="bare"' : ""}>
<header class="topbar">
  <span class="brand">MetalPriceKit 后台</span>
  ${navHtml}
</header>
<main>
${opts.body}
</main>
</body>
</html>`;
}

/** 千分位。数字大了以后不带分隔符根本读不出量级。 */
export function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** 把 ISO 时间转成「本地时区的年月日时分」。后台看的是运营的本地时间，不是 UTC。 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间。看「最后活跃」时比绝对时间直观。 */
export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "刚刚";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDateTime(iso);
}

/** 提示条。 */
export function notice(kind: "ok" | "error" | "warn", message: string): string {
  if (!message) return "";
  return `<div class="notice ${kind}">${escapeHtml(message)}</div>`;
}
