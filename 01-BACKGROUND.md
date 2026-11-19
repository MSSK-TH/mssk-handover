# 01 · 背景：这套系统是什么、装成什么样、数据从哪来

## 一、目标形态：单机全栈

```
                       ┌───────────────────────────────────────┐
  api.example.com      │  caddy  :80 / :443                    │
  image.example.com →  │   ├─ /v1/*     → keepalive:3002       │
                       │   │              → new-api:3001       │
                       │   ├─ /api/*    → new-api:3001         │
                       │   ├─ /static/* + 其余 → /srv/console  │
                       │   └─ image 域名 → image-web:8788      │
                       │                                       │
                       │  imagegen-shim :8899（只绑 127.0.0.1） │
                       │  cron: mssk-quota / disk-guard        │
                       └───────────────────────────────────────┘
```

没有第二台机器、没有跨机同步。所有组件同机，通过 `127.0.0.1` 互相通信。

## 二、五个组件分别是什么

| 组件 | 是什么 | 端口 | 内部细节 |
|---|---|---|---|
| **new-api** | 网关本体（Go，官方镜像 `calciumion/new-api:v1.0.0-rc.51`）。管 API 密钥、渠道、用户、日志、额度 | `127.0.0.1:3001` | 数据在 `data/one-api.db`（SQLite） |
| **console** | 控制台前端，**我们自己构建的静态产物**，不是镜像内置的 | 由 caddy 托管 | 放在 `/opt/mssk/console`，改 UI 靠替换文件 |
| **relay-keepalive** | 187 行 Node 脚本，SSE 保活代理（`3002 → 3001`） | host 网络 `3002` | **`/v1` 必经它**，否则长响应 ~100 秒被掐 |
| **image-web** | 生图站（Node + 自建镜像 `mssk/image-web:webp`） | `8788` | 镜像 Hub 上没有，靠包里的 tar 导入 |
| **imagegen-shim** | 生图执行层：原生模式（走 Codex 账号）+ 网页版模式（走浏览器 Cookie） | `127.0.0.1:8899` | Cookie 在 `shim/cookies/*.txt`，换 IP 可能要重登 |
| **caddy** | 唯一对外入口，80/443，同时服务两个域名 | host 网络 | 证书自动申请（Let's Encrypt） |

## 三、端口一览（新机最终态）

| 端口 | 监听 | 用途 | 是否对外 |
|---|---|---|---|
| 22 | sshd | 运维 | 对外（建议限源 IP） |
| 80 | caddy | ACME 验证 + HTTP 跳转 | 对外 |
| 443 | caddy | 控制台 + API + 生图站 | 对外 |
| 3001 | new-api | 网关 API | **仅 127.0.0.1** |
| 3002 | relay-keepalive | SSE 保活（caddy 内部用） | **仅本机** |
| 8788 | image-web | 生图站后端 | **仅本机**（由 caddy 暴露） |
| 8899 | imagegen-shim | 生图执行层 | **仅 127.0.0.1** |

## 四、目录布局（新机）

```
/opt/mssk/
├── caddy/            Caddyfile、data/（证书缓存，自动生成）
├── new-api/          docker-compose.yml、data/（one-api.db + WAL）
├── console/          控制台静态产物（来自 console.tar.gz）
├── image-web/        生图站程序（只读挂载进容器）
├── shim/             生图执行层程序 + cookies/
├── relay-keepalive/  保活脚本
├── secrets/          image-web.env、imagegen-shim.env（权限 600）
├── tools/            codex-quota.py、disk-guard.sh
├── scripts/          运维脚本（autoupdate 默认不用）
└── data/             生图结果与临时文件
```

## 五、数据来源（旧部署）

`data-db.tar.gz` 与 `05-SECRETS.enc` 里的东西来自旧部署，迁完即与新机无关：

| 数据 | 内容 | 说明 |
|---|---|---|
| `one-api.db` + `-wal` | 用户 / 令牌（`sk-` 密钥）/ 渠道（含上游 OAuth 凭据）/ 日志聚合 / 系统设置 | **必须成对替换**，只换 db 会丢最近写入 |
| `one-api.db.backup-latest` | 迁移那一刻的备份 | 出问题用它恢复 |
| `shim-cookies/*.txt` | ChatGPT 网页版登录态 | 换 IP 后可能失效，需重登 |
| `console.tar.gz` | 旧部署的控制台产物 | 已构建好，直接铺进 `/opt/mssk/console` |

## 六、cron（只装两条）

| 文件 | 频率 | 作用 | 是否安装 |
|---|---|---|---|
| `mssk-quota` | 每 10 分钟 | 读 DB 里的 Codex 渠道凭据 → 拉订阅额度 → 原子写入 `/opt/mssk/console/codex-quota.json` | ✅ 必须 |
| `disk-guard` | 每 10 分钟 | 磁盘水位检查 | ✅ 建议 |
| `new-api-autoupdate.disabled` | 每天 04:30 | 自动升级 new-api 镜像 | ❌ 不装（版本冻结） |

> 已废弃：原部署还有一个"每小时把 Codex OAuth 凭证推到另一台机器"的 `mssk-token-sync`。
> 单机部署不需要，包里没有。

## 七、域名与证书

| 域名 | 用途 | 证书 |
|---|---|---|
| `api.<你的域名>` | 控制台 + `/api` + `/v1` | Caddy 自动向 Let's Encrypt 申请 |
| `image.<你的域名>` | 生图站 | 同上 |

**不复用旧证书**（域名换了，旧证书无效）。新机用 Caddy 自动签发，零维护。
详细教程见 `02-CONFIG/caddy/DOMAIN-AND-TLS-GUIDE.md`。

## 八、旧机器上与本包无关的东西（不要搬）

- 代理 / 网络组件：sing-box、derper、microsocks、tailscaled、vnstat
- 其它业务遗留：windsurfapi、`/opt/webpipe`、`/opt/mssk/backup`
- 任何监控项目（如 `/opt/monitor`）

新机只装本包里的 5 个容器 + 2 个 cron。
