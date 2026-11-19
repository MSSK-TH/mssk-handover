# START HERE

你要把一套 **AI API 中转站 + 生图站**部署到一台新的 Linux VPS 上（单机全栈）。

这个仓库里只有**文档、配置和小代码**（约 1.4 MB）。
**大文件（前端产物 / 数据库 / 镜像 / 加密凭据）不在这里**，用一条命令拉取：

```bash
bash scripts/fetch-assets.sh          # 需要 gh CLI 已登录，或提供 GITHUB_TOKEN
```

拉下来会得到 4 个文件（合计约 121 MB），脚本会自动校验 sha256 并解到正确位置。

---

## 你现在按顺序做三件事

### 1. 拉齐资产

```bash
git clone <这个仓库地址> mssk-handover && cd mssk-handover
bash scripts/fetch-assets.sh
```

看到 `ALL ASSETS OK` 才能继续。

### 2. 读两页，别读多

| 读什么 | 给谁 | 用时 |
|---|---|---|
| `00-YOU-DO-THIS.md` | **给 owner（机器和域名的主人）** | 5 分钟 |
| `07-MIGRATION.md` | **给你（执行部署的人/agent）** | 通读一遍再动手 |

> `00-YOU-DO-THIS.md` 是给 owner 的 4 件事（买机器、放行端口、弄域名、切 DNS）。
> 如果 owner 已经准备好了，直接进 `07-MIGRATION.md` 的阶段 A。

### 3. 开始执行

按 `07-MIGRATION.md` 的 **阶段 A → B1…B8 → C** 走，遇到 `CHECKPOINT` 就停下来汇报。

遇到与文档不一致的输出，**停下问 owner**，不要自己猜着往下走。

---

## 一条硬规矩（先记住这一条）

> **不要在新机器上编译任何前端代码。**
> 前端产物已经在资产里（`console.tar.gz`），解包即用。
> 历史上在 1.6 GB 的机器上跑 `bun install && bun run build`，直接把机器压到 SSH 都连不上，只能重启实例。

其余禁止事项见 `07-MIGRATION.md` 附录 B。

---

## 仓库结构

```
START-HERE.md                  ← 你在看的这页
BOOTSTRAP-PROMPT.txt           ← 一段话，可直接发给执行方 agent
00-YOU-DO-THIS.md              ← owner 的 4 件事
00-OWNER-ACTIONS.md            ← agent 向 owner 索取资源用的清单
README-FIRST.md                ← 给执行方的第一页（术语 + 硬约束 + 导航）
01-INVENTORY/                  ← 目标形态、容器端口、cron 与数据来源
02-CONFIG/                     ← Caddyfile、5 份 compose、cron、运维脚本
   └ caddy/DOMAIN-AND-TLS-GUIDE.md   ← 域名与证书教程（owner 不懂时发给他）
03-APP/                        ← 生图站、生图执行层、保活代理、前端 patch
04-DATA/                       ← （空，数据库在资产里）
07-MIGRATION.md                ← ★ 执行主线：阶段 A / B1-B8 / C
08-VERIFY/                     ← 验收脚本 + 功能测试流程
09-ROLLBACK.md                 ← 出事怎么退
assets/MANIFEST.txt            ← 大文件清单与 sha256
scripts/fetch-assets.sh        ← 拉大文件
```

---

## 大文件清单（都在 Release 里，不在仓库里）

| 文件 | 大小 | 用途 |
|---|---|---|
| `console.tar.gz` | 18.4 MB | 控制台前端产物，解到 `/opt/mssk/console/` |
| `data-db.tar.gz` | 19.6 MB | 数据库 + WAL + 最近备份，解到 `/opt/mssk/new-api/data/` |
| `mssk-image-web-webp.tar.gz` | 83 MB | 生图站自建镜像（Docker Hub 没有），`docker load` 用 |
| `05-SECRETS.enc` | 18 KB | 加密凭据，口令由 owner 单独给 |

> 为什么大文件不放仓库：GitHub 单文件上限 100 MB，而且二进制进 git 会让每次 clone 变慢。
> 放 Release 附件，一条命令就能拉，还能按版本管理。
