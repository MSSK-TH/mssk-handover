# MSSK 中转站 · 交接部署包

把一套 **AI API 中转站 + 生图站**部署到一台全新的 Linux VPS 上（单机全栈）。
业务数据从旧部署一次性迁移过来。

---

## 一、给谁看什么（先看这张表，别乱翻）

| 你是谁 | 读这几份，按这个顺序 |
|---|---|
| **执行方（人或 agent）** | ① 本页 → ② `07-MIGRATION.md`（主线，边做边查） |
| **owner（机器与域名的主人）** | `00-YOU-DO-THIS.md`（只要 4 件事，约 30 分钟） |

**按需查阅**，不要预先通读：

| 情况 | 翻这份 |
|---|---|
| 想知道这套系统里各组件是什么 | `01-BACKGROUND.md` |
| 域名 / 证书卡住了（最常卡的地方） | `02-CONFIG/caddy/DOMAIN-AND-TLS-GUIDE.md` |
| 要测"功能真的能用吗" | `08-VERIFY/FUNCTIONAL-TEST.md` |
| 出事了 / 要回滚 | `09-ROLLBACK.md` |
| 要向 owner 索取东西 | `00-OWNER-ACTIONS.md` |
| 将来要改控制台前端 | `03-APP/new-api-patch/README.md` |

**不用读**：`02-CONFIG/` 下的配置文件（照着复制即可）、`04-DATA/README.md`（一句话说明）。

---

## 二、大文件不在仓库里，一条命令拉

仓库只有文档和配置（约 1.2 MB）。四个大文件走 Release：

```bash
export GH_TOKEN=<owner 给的只读令牌>
bash scripts/fetch-assets.sh
```

脚本会下载、校验 sha256、并自动解到 `/opt/mssk/`。看到 `ALL ASSETS OK` 才继续。

**公开部分**（脚本自动从 Release 拉，无需令牌）：

| 资产 | 大小 | 是什么 | 缺了会怎样 |
|---|---|---|---|
| `console.tar.gz` | 18.4 MB | 控制台前端产物 | 网站白屏 |
| `mssk-image-web-webp.tar.gz` | 83 MB | 生图站镜像（Hub 上没有） | 生图站起不来 |

**私有部分**（**不在仓库里**，owner 会发你一个 zip，解开后放到 `/root/mssk-private/`）：

| 什么 | 大小 | 是什么 | 备注 |
|---|---|---|---|
| `data-db.tar.gz` | 19.6 MB | 数据库 + WAL + 备份（含用户/令牌/渠道密钥） | 含敏感数据，绝不能进公开仓库 |
| `05-SECRETS.enc` | 18 KB | 加密凭据（生图配置 + 网页版 Cookie） | 解压口令由 owner 单独给 |

---

## 三、硬约束（违反会出事故，每条都有真实先例）

1. **不要在新机器上编译任何前端代码**。产物已在 `console.tar.gz` 里。
   历史上在生产机跑 `bun install && bun run build`，把 1.6 GB 的机器压到 SSH 都连不上，只能重启实例。
2. **不要改 new-api 镜像版本**，冻结在 `v1.0.0-rc.51`；不要启用 `new-api-autoupdate`。
3. **`/v1` 必须经过 `relay-keepalive:3002`**，不能直连 `3001`。
   直连的症状：短请求正常，生图和长对话在 ~100 秒被掐断。
4. **数据库必须 `one-api.db` 与 `one-api.db-wal` 成对替换**，只换 db 会丢最近写入。
5. **改任何配置前先备份**，并在对话里留下回滚命令。没有回滚命令不许改。
6. **DNS / 域名解析由 owner 手动改**，执行方不碰。
7. **不要把 `05-SECRETS` 的内容贴到聊天、日志、终端历史里**。
8. **测试请求要串行、有间隔**：文本 10 秒 / 流式 30 秒 / 生图 60 秒；失败最多重试 2 次。

---

## 四、执行顺序（一句话版）

```
阶段 A  确认东西齐了（4 样 + 机器硬指标 + 域名/端口状态）
阶段 B  B1 体检 → B2 拉仓库与资产 → B3 铺配置+凭据 → B4 填域名
        → B5 导镜像 → B6 起网关 → B7 起其余 4 个 → B8 cron+验收+功能测试
阶段 C  C1 停下等 owner 点头 → C2 换正式证书 → C3 通知客户端 → C4 收尾观察
```

每个 `CHECKPOINT` 都要停下来汇报，等 owner 确认。

---

## 五、机器要求

- 境外 VPS，**最低 2 核 4 GB**，系统盘 ≥ 20 GB
- Ubuntu 22.04/24.04 或 Debian 12
- root 或 sudo
- 放行 22 / 80 / 443（22 建议只放行 owner 的 IP）

5 个容器内存上限合计约 2.4 GB，2 GB 机器会 OOM。

---

## 六、仓库结构

```
README.md                       ← 本页（导航 + 硬约束）
BOOTSTRAP-PROMPT.txt            ← 一段话，owner 可直接发给执行方
00-YOU-DO-THIS.md               ← owner 的 4 件事
00-OWNER-ACTIONS.md             ← 执行方向 owner 索取东西的清单
01-BACKGROUND.md                ← 组件、端口、目录、数据来源、cron
02-CONFIG/                      ← Caddyfile、5 份 compose、cron、运维脚本
   └ caddy/DOMAIN-AND-TLS-GUIDE.md   ← 域名与证书教程（点击级）
03-APP/                         ← 生图站、生图执行层、保活代理、前端 patch
04-DATA/                        ← 空（数据库在 Release 资产里）
07-MIGRATION.md                 ← ★ 执行主线
08-VERIFY/                      ← 验收脚本 + 功能测试流程
09-ROLLBACK.md                  ← 回滚
assets/MANIFEST.txt             ← 资产 sha256 清单
scripts/fetch-assets.sh         ← 拉资产
```
