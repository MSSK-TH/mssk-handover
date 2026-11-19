# 01-3 · cron、数据、域名与证书（原始状态）

## cron（原阿里云机器 `/etc/cron.d/`）

| 文件 | 频率 | 作用 | 新机是否安装 |
|---|---|---|---|
| `mssk-quota` | 每 10 分钟 | 读 DB 里的 Codex 渠道凭证 → 拉订阅额度 → 原子写入 `/opt/mssk/console/codex-quota.json` | ✅ **必须**（已改为直连） |
| `disk-guard` | 每 10 分钟 | 磁盘水位检查与清理 | ✅ 建议 |
| `new-api-autoupdate` | 每天 04:30 | 自动升级 new-api 镜像到最新 | ❌ **不装**（版本冻结） |
| ~~`mssk-token-sync`~~ | — | （旧部署遗留）跨机推送凭证 | ❌ **不需要**：单机同库，无需推送 |

安装方法见 `02-CONFIG/cron/README.md`。

## 数据

| 数据 | 原位置 | 体积 | 包里 |
|---|---|---|---|
| 主数据库 | `/opt/mssk/new-api/data/one-api.db` | 119 MB | `04-DATA/one-api.db` |
| WAL（必须一起搬，否则丢最近写入） | 同目录 `-wal` | 1.1 MB | `04-DATA/one-api.db-wal` |
| 最近一份备份 | 同目录 `one-api.db.bak-*` | 108 MB | `04-DATA/one-api.db.backup-latest` |
| 更老的备份 ×2 | 同目录 | 238 MB | ❌ 不带 |
| new-api 运行日志 | `/opt/mssk/new-api/data/logs` | 100 MB | ❌ 不带（新机从零记） |
| 出图数据 | `/opt/mssk/data` | — | ❌ 不带（历史图片不需要迁移） |

**数据库里有**：用户表、令牌（`sk-` 密钥）、渠道（含上游密钥，如 Codex OAuth JSON）、
日志聚合、系统设置。**这些就是"换机还能继续用"的核心**，绝对不能丢。

## 域名与证书

| 域名 | 用途 | 证书 |
|---|---|---|
| `relay.<旧域名>` | 控制台 + `/api` + `/v1` | 旧部署用 Cloudflare Origin 证书；**新域名不复用旧证书**，由 Caddy 自动申请 |
| `image.<旧域名>` | 生图站 | 同上 |

**新机不用旧证书**：域名换了，证书必须重新签。新机默认让 Caddy 自动向 Let's Encrypt 申请
（要求域名 A 记录已指向新机、且 80/443 公网可达）。若 owner 坚持用 Cloudflare Origin 证书，
见 `02-CONFIG/caddy/README-CERT.md`。

## 旧机器上与本包无关的东西（不要搬）

- 海外机上的 `sing-box` / `derper` / `microsocks` / `tailscaled` / `vnstat`：代理与网络组件
- 海外机上的 `windsurfapi`、`/opt/webpipe`、`/opt/mssk/backup`：其它业务的遗留
- 国内机上的 `/opt/monitor`（另一个监控项目）、`new-api-autoupdate` 的历史日志

新机只装本包里的 5 个容器 + 2 个 cron，不要顺手把别的服务也搬过去。
