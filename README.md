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

export METALS_DEV_API_KEY=<你的 metals.dev key>
export MPK_SERVER_KEYS=$(node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))")

npm start
```

另开一个终端验证整条加解密链路：

```bash
node scripts/smoke.ts http://127.0.0.1:8787
```

> Node 26 可以**直接运行 `.ts` 文件**，不需要构建步骤，也不需要 tsx/ts-node。
> 这是当初选 Node 的原因之一：少三样东西。

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
│   ├── userstore.ts            用户、token、反馈、崩溃、埋点
│   ├── configstore.ts          通用配置热加载
│   ├── ratelimit.ts            进程内固定窗口限流
│   └── logger.ts               单行 JSON 日志
├── scripts/
│   ├── smoke.ts                客户端侧参考实现 + 部署自检
│   └── gen-routes.ts           生成新的混淆路径表
├── deploy/                     部署产物（可直接复制）
│   ├── env.example             环境变量模板
│   ├── metalpricekit-server.service   systemd unit
│   ├── nginx.conf              Nginx 站点配置
│   └── backup.sh               SQLite 备份脚本
├── test/                       node:test，全部打本地假上游（不烧真额度）
└── docs/
    ├── 客户端接入指南.md        ← Swift 端照着这份接
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
| 交易时段按伦敦本地时间判 | 金属现货的参照时区是 LBMA。用固定 UTC 边界会在夏令时切换时漂移一小时 |
| 只判「有把握的休市」 | 把开市判成休市会让用户错过行情；反过来只是少个提示，涨跌额沿用已兜住 |
| 配置单一来源 | `features` / `marketing` / `pollIntervalSeconds` 存在 `remote-config.json` 里，代码里不再存副本 |
| `pollIntervalSeconds` 与 `upstreamRefreshSeconds` 分开 | 前者是客户端轮询我们的间隔，后者是数据本身多久更新一次。混用一个字段必然被误读 |
| feedback / events 要 token | 对齐契约 §1.4 —— 反馈要能关联到人。崩溃上报是唯一允许匿名的例外 |

---

## 测试

```bash
npm test
```

55 个用例，全部走**本地假上游**（`test/fixture.ts` 内含真实响应样本）。
真实额度是真金白银，测试跑几轮就烧光了。

覆盖的关键行为：

- 路径混淆生效，语义路径 404
- 响应确实是密文，解开后结构与契约一致
- AAD 绑定方法与路径，密文跨接口搬运解不开
- 篡改密文会解密失败
- ETag 命中返回 304
- 同一 `deviceId` 幂等注册
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

- 客户端接入（**Swift 端看这份**）：[`docs/客户端接入指南.md`](docs/客户端接入指南.md)
- 部署与额度：[`docs/服务端部署与额度.md`](docs/服务端部署与额度.md)
- 业务契约（客户端仓库）：`MetalPriceKit-main/Docs/服务端API设计.md`
