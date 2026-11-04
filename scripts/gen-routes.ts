//
//  scripts/gen-routes.ts
//  MetalPriceKit Server
//  生成新的混淆路径表。
//
//  为什么需要它：路径是公开信息，抓包就能看到。
//  「/v1/quotes」一眼就知道是行情接口，爬虫顺着就能把数据扒走。
//  换成无意义随机串之后，接口用途看不出来，爬虫得先逆向 App 才知道该看什么。
//
//  用法：
//   node scripts/gen-routes.ts           只打印，不落盘
//   node scripts/gen-routes.ts --write   直接覆盖 config/routes.json
//
//  ⚠️ 换路径 = 客户端要同步更新，否则 App 直接 404。
//    轮换时机建议配合客户端发版，不要在生产环境单独动。
//

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROUTES_FILE = resolve(ROOT, "config/routes.json");

/** 逻辑名 → 路径模板。bootstrap 不参与随机：客户端必须能预先知道它在哪。 */
const SHAPES: Record<string, string> = {
  bootstrap: "/v1/mpk-bootstrap",
  quotes: "/v1/{8}-{6}",
  metals: "/v1/{8}-{6}",
  fx: "/v1/{8}-{6}",
  config: "/v1/{8}-{6}",
  fields: "/v1/{8}-{6}",
  auth: "/v1/{8}-{6}",
  profile: "/v1/{8}-{6}",
  feedback: "/v1/{8}-{6}",
  crash: "/v1/{8}-{6}",
  events: "/v1/{8}-{6}",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** 只用小写字母，长度固定 —— 路径短、好记、看不出含义。 */
function randomSegment(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function generate(): Record<string, string> {
  const routes: Record<string, string> = {};
  const used = new Set<string>();
  for (const [name, template] of Object.entries(SHAPES)) {
    if (!template.includes("{")) {
      routes[name] = template;
      continue;
    }
    let path = "";
    // 极小概率撞车，重试即可。
    do {
      path = template
        .replace("{8}", randomSegment(8))
        .replace("{6}", randomSegment(6));
    } while (used.has(path));
    used.add(path);
    routes[name] = path;
  }
  return routes;
}

const routes = generate();

if (process.argv.includes("--write")) {
  const existing = JSON.parse(readFileSync(ROUTES_FILE, "utf8")) as Record<string, unknown>;
  const merged = { ...existing, routes };
  writeFileSync(ROUTES_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`已写入 ${ROUTES_FILE}`);
} else {
  console.log(JSON.stringify({ routes }, null, 2));
  console.log("\n加 --write 才会落盘。");
}
