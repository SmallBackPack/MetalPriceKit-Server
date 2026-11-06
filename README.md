# MetalPriceKit Server

MetalPriceKit 金属价格 App 的配套后端。

- **技术栈**：Node.js 26 + TypeScript + Express 5 + SQLite（Node 内置 `node:sqlite`）
- **上游行情源**：metals.dev（免费档 100 次/月，**硬约束**）
- **对外接口**：路径混淆 + 响应加密 + 通用字段字典

> 客户端仓库（Swift）在本仓库之外的 `MetalPriceKit-main/`。
> 业务契约见客户端仓库的 `Docs/服务端API设计.md`；本仓库是它的实现。

---

## 快速开始

```bash
npm install

# 客户端联调用假数据模式：不请求上游、不消耗额度
cp .env.local.example .env.local    # Windows: copy
# 填上 MPK_SERVER_KEYS 后
powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 start
```

另开一个终端验证整条加解密链路：

```bash
node scripts/smoke.ts http://127.0.0.1:8787
```

> Node 26 可以**直接运行 `.ts` 文件**，不需要构建步骤，也不需要 tsx/ts-node。
> 这是当初选 Node 的原因之一：少三样东西。

完整的启停命令见下面「本地启停（Windows）」。

## 假数据模式（客户端联调）

```bash
MPK_MOCK=true                # 不请求上游，不消耗额度
MPK_POLL_INTERVAL_MS=15000   # 15 秒一轮，客户端能看到价格在动
```

上游免费档一个月只有 100 次请求 —— 联调打真实上游几天就烧光，
而额度要等下个月才重置。假数据模式下**接口形状、加密、字段全是真的**，
只有价格是模拟的，联调通过的部分切回真实数据后不用重测。

假数据有两处标记：`X-MPK-Mock: 1` 响应头 + `quotes[].dataSource: "mock"`。

切回真实数据：把 `MPK_MOCK` 改成 `false` 再 restart，客户端代码一行不用改。

## 本地启停（Windows）

`scripts/svc.ps1` 管四个动作：启动、停止、重启、看状态。进程是独立后台进程，关掉终端也不影响。

```powershell
cd F:\workspace\MetalSever\MetalPriceKit-Server

# 首次：准备环境变量（复制模板并填 key）
copy .env.local.example .env.local

# 启停
powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 start
powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 stop
powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 status
powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 logs -Tail 50
```

启动后：

| 地址 | 是什么 |
|---|---|
| `http://127.0.0.1:8787` | 行情接口（路径混淆后的那些） |
| `http://127.0.0.1:8787/admin` | 运营后台（口令见 `.env.local` 的 `MPK_ADMIN_TOKEN`） |
| `http://127.0.0.1:8787/health` | 探活 |

**配置全部从 `.env.local` 读**，脚本自己加载，不用每次手动设环境变量。
Node 也自动找 `F:\tools\node\node.exe`，不在 PATH 里也能跑。

### 不想用脚本时

```powershell
cd F:\workspace\MetalSever\MetalPriceKit-Server
$env:PATH = 'F:\tools\node;' + $env:PATH

# 关键：先加载 .env.local，否则缺 MPK_SERVER_KEYS 会启动失败
Get-Content .env.local -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    Set-Item -Path "env:$($matches[1].Trim())" -Value $matches[2].Trim()
  }
}

node src/index.ts
```

这条是**前台运行**（Ctrl+C 停），适合调试看堆栈。

### 两个容易踩的坑

1. **本地重启默认不重新拉上游**（`MPK_FETCH_ON_BOOT=false`）——
   启动时先从本地快照恢复，立即就能对外服务。
   额度一个月只有 100 次，每次启动都烧一次太浪费。
   想强制刷新一次：把 `.env.local` 里那行改成 `true` 再 restart。
2. **`.env.local` 默认是假数据模式**（`MPK_MOCK=true`，15 秒一轮）。
   要打真实上游就改成 `false` 再 restart —— 客户端代码一行不用改。

Linux 生产环境用 systemd，见 [`deploy/README.md`](deploy/README.md)：

```bash
sudo systemctl start|stop|restart|status metalpricekit-server
sudo journalctl -u metalpricekit-server -f
```

环境变量在 `/etc/metalpricekit-server.env`（模板 `deploy/env.example`）。

---

## 运营后台

服务端自带一个极简后台，两个用途：**看真实用户数**（匿名用户也统计得到）、
**改通用字段下发**（不用 SSH 上去手改文件）。

```bash
# 配置管理口令（没配则后台关闭，/admin 返回 503）
MPK_ADMIN_TOKEN=<随机串>
```

后台只在本机监听，远程走 SSH 隧道：

```bash
ssh -L 8787:127.0.0.1:8787 user@server
# 浏览器打开 http://127.0.0.1:8787/admin
```

**没有前端框架、没有构建步骤、没有额外依赖** —— 页面是服务端拼出来的 HTML，
操作都是原生表单提交。三个页面：看板、用户、配置。

匿名身份是**双标识**：`deviceId` = 客户端生成并存在 Keychain 的 UUID（算装机基数），
`vendorId` = IDFV（算设备数）。两者入库前都做 HMAC，**库里不留原始设备标识**。

详见 [`docs/后台使用说明.md`](docs/后台使用说明.md)。

---

## 目录结构

```
MetalPriceKit-Server/
├── config/                     配置（改文件即生效的部分放这）
│   ├── routes.json             混淆路径表 —— 逻辑名 → 对外路径
│   ├── metals.json             品种字典 + 上游符号映射（换供应商只改这里）
│   ├── currencies.json         货币白名单（上游给 174 个，含废弃币，必须过滤）
│   ├── holidays.json           金属市场休市日（伦敦本地日期）
│   └── remote-config.json      通用字段字典 —— 改完即生效，不用重启、不用发版
├── src/
│   ├── index.ts                进程入口
│   ├── app.ts                  HTTP 装配：路由、中间件、加密响应
│   ├── config.ts               集中读环境变量与配置文件
│   ├── crypto.ts               X25519 + HKDF-SHA256 + AES-256-GCM
│   ├── upstream.ts             metals.dev 适配层（唯一发上游请求的地方）
│   ├── collector.ts            定时采集 + 额度刹车
│   ├── market.ts               快照 → 契约结构（涨跌基准、市场状态、过期判定）
│   ├── store.ts                SQLite：额度计数 / 快照 / 每日收盘价
│   ├── userstore.ts            用户、token、反馈、崩溃、埋点、日活
│   ├── identity.ts             设备标识的 HMAC 哈希（pepper 管理）
│   ├── configstore.ts          通用配置：热加载 + 原子写 + 版本 + 备份回滚
│   ├── ratelimit.ts            进程内固定窗口限流
│   ├── logger.ts               单行 JSON 日志
│   └── admin/                  运营后台
│       ├── index.ts            路由装配
│       ├── auth.ts             管理口令 + 会话 cookie + CSRF
│       ├── stats.ts            统计查询（口径写在这一层）
│       ├── pages.ts            三个页面的 HTML
│       ├── render.ts           HTML 骨架与转义
│       └── assets/admin.css    样式（不引 UI 库）
├── scripts/
│   ├── smoke.ts                客户端侧参考实现 + 部署自检
│   ├── gen-routes.ts           生成新的混淆路径表
│   └── svc.ps1                 本地服务启停（start/stop/restart/status/logs）
├── deploy/                     部署产物（可直接复制）
│   ├── env.example             环境变量模板
│   ├── metalpricekit-server.service   systemd unit
│   ├── nginx.conf              Nginx 站点配置
│   └── backup.sh               SQLite 备份脚本
├── test/                       node:test，全部打本地假上游（不烧真额度）
└── docs/
    ├── 接口文档.md              ← 给客户端的接口参考（真实响应示例）
    ├── 客户端接入指南.md        ← Swift 端照着这份接（加密协议 + 代码）
    ├── 后台使用说明.md          ← 后台怎么用、改配置、口径解释
    └── 服务端部署与额度.md      ← 部署 + 额度账本 + 套餐建议
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动服务 |
| `npm run dev` | 带 `--watch` 的开发模式 |
| `npm test` | 跑全部测试（**不碰真实上游**） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke -- <url>` | 客户端侧参考实现，验证加解密链路 |
| `npm run gen:routes` | 生成新的混淆路径表（加 `--write` 才落盘） |

---

## 关键决策速查

| 决策 | 为什么 |
|---|---|
| 路径混淆，字段名不混淆 | URL 一眼看不出用途；但加密已经解决内容保密，字段名保持契约原样便于客户端开发 |
| X25519 ECDH + HKDF + AES-GCM | 服务端只一把长期私钥，客户端不用注册；每个客户端的会话密钥都不同；GCM 自带认证标签，篡改会解密失败而不是返回垃圾数据 |
| bootstrap 保持明文 | 客户端此时还没有密钥，解不开密文。只暴露公钥，泄露无害 |
| 涨跌基准用服务端自算的 `prevClose` | 上游 `/v1/latest` 不给涨跌。逐品种调 `spot` 拿官方昨收要 8 次/轮 —— 免费档 100 次/月扛不住 |
| 周末冻结时沿用上一交易日涨跌幅 | 照直算是 0.00%，用户会以为 App 坏了（契约文档点名了这个坑） |
| `isStale` 看服务端抓取时间 | 免费档轮询间隔以小时计，按上游时间戳 + 30 分钟判会导致所有品种永远过期 |
| 只用 `/v1/latest` | 一次请求顶 8 次。`/v1/metal/spot` 没有批量版 |
| 额度三重保护 | SQLite 记账（跨重启）+ 硬刹车 + `/usage` 对账（宁可多算不能少算） |
| 只下发 USD 基准价 | 服务端和客户端同时换算会产生两套口径，迟早对不上。顺序固定「先单位、后币种」 |
| 通用字段接口与结构化 `/v1/config` 并存 | 前者任意 `[key: Any]` 字典（改文件即生效），后者保持契约固定结构 |
| `price` 与 `baseUnit` 成对下发 | 客户端不该硬编码 `HG` 一定是吨 |
| `changeRate` 传原始小数 | `0.0123` = 1.23%，不乘 100、不下发格式化字符串 |
| 缺数据就是缺 | 不塞 0 兜底。缺一个品种列表就少一条 |
| 生产环境强制加密 | 没有客户端公钥就返回 400，不降级成明文 —— 否则加密形同虚设 |
| 假数据模式与真实源共用一个接口 | 联调时形状、加密、字段全真跑，只有价格是假的 —— 切回真实数据不用重测 |
| 假数据用独立的数据目录 | 采集器会写「当日收盘价」，假数据写进去会覆盖真实历史，把涨跌基准搞错 |
| 付费买的是请求配额，不是数据延迟 | 上游所有档位延迟都是 ≤60 秒。真正的瓶颈是我们的轮询频率被配额卡死 |
| 交易时段按伦敦本地时间判 | 金属现货的参照时区是 LBMA。用固定 UTC 边界会在夏令时切换时漂移一小时 |
| 只判「有把握的休市」 | 把开市判成休市会让用户错过行情；反过来只是少个提示，涨跌额沿用已兜住 |
| 配置单一来源 | `features` / `marketing` / `pollIntervalSeconds` 存在 `remote-config.json` 里，代码里不再存副本 |
| `pollIntervalSeconds` 与 `upstreamRefreshSeconds` 分开 | 前者是客户端轮询我们的间隔，后者是数据本身多久更新一次。混用一个字段必然被误读 |
| feedback / events 要 token | 对齐契约 §1.4 —— 反馈要能关联到人。崩溃上报是唯一允许匿名的例外 |
| 匿名身份用双标识 | `deviceId`（Keychain UUID）算装机基数，`vendorId`（IDFV）算设备数。只用一个都会算错 |
| 设备标识入库前做 HMAC | 库里不留原始设备标识。pepper 跟着数据库一起备份 |
| 后台不引前端框架 | 三个页面、表格加表单。引框架会多出一整套构建步骤，部署从「node src/index.ts」变成「先构建再启动」 |
| 后台页面零 JavaScript | 原生表单提交就够。少一层运行时，少一类故障 |
| 后台与客户端 token 完全隔离 | 客户端 token 几乎人手一个，跟运营权限混在一起，一个泄漏就等于后台敞开 |
| 登录限流只计失败次数 | 限流是防爆破的。成功登录也计数会把正常用户挡在门外 |
| 配置写入保持原有排版 | 在控制台改一个字段，版本库 diff 只有那一行 —— 看得出到底改了什么 |
| 配置版本号只增不减 | 客户端只认「版本号变大」才刷新缓存。回滚内容也不能回退版本号 |
| `pollIntervalSeconds` 设下限护栏 | 所有客户端加起来就是我们的 QPS，间隔过小会打爆服务端并让同出口 IP 的用户互相限流 |
| 埋点交给第三方平台 | 客户端侧用友盟 / TalkData，服务端不重复采集、不做埋点分析 |
| 统计口径写在代码注释里 | 装机基数 / 活跃装机 / 设备数 / DAU / MAU 是五个不同的数，混着报谁也看不懂 |

---

## 测试

```bash
npm test
```

83 个用例，全部走**本地假上游**（`test/fixture.ts` 内含真实响应样本）。
真实额度是真金白银，测试跑几轮就烧光了。

覆盖的关键行为：

- 路径混淆生效，语义路径 404
- 响应确实是密文，解开后结构与契约一致
- AAD 绑定方法与路径，密文跨接口搬运解不开
- 篡改密文会解密失败
- ETag 命中返回 304
- 同一 `deviceId` 幂等注册，库里存的是哈希不是原文
- 后台未登录拿不到数据，CSRF 拦住跨站提交
- 统计口径：装机基数 / 设备数 / DAU 各算各的
- 配置控制台：版本 +1、自动备份、护栏拦下过小的轮询间隔、回滚内容但版本不回退
- 额度用尽后不再向上游发请求
- 周末 / 节假日判定为休市，夏令时边界跟着伦敦时间走
- 周末冻结沿用上一交易日涨跌幅
- 浮点舍入不产生 `131.32499999999982` 这种噪声
- 没有客户端公钥拿不到明文，畸形公钥不会把服务打成 500
- feedback / events 缺 token 返回 401

---

## ⚠️ 上架前必须确认

**metals.dev 条款写的是 "publish rates on websites"，在 iOS App 内展示是否同等授权没有写明。**
这需要发邮件问清楚，是上架的硬门槛。

详见 `docs/服务端部署与额度.md` §〇。

---

## 相关文档

- **接口文档**（交给客户端的那份）：[`docs/接口文档.md`](docs/接口文档.md)
- **客户端接入**（Swift 端看这份）：[`docs/客户端接入指南.md`](docs/客户端接入指南.md)
- **运营后台**：[`docs/后台使用说明.md`](docs/后台使用说明.md)
- **部署与额度**：[`docs/服务端部署与额度.md`](docs/服务端部署与额度.md)
- **部署产物**：[`deploy/README.md`](deploy/README.md)
- 业务契约（客户端仓库）：`MetalPriceKit-main/Docs/服务端API设计.md`
