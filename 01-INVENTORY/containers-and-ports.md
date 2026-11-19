# 01-2 · 容器、端口、挂载（原始状态 → 目标状态）

## 容器清单

| 容器名（原） | 镜像 | 端口 | 内存上限 | 新机容器名 |
|---|---|---|---|---|
| `new-api-aliyun` | `calciumion/new-api:v1.0.0-rc.51` | `127.0.0.1:3001→3000` | 900m | `new-api` |
| `caddy-aliyun` | `caddy:2-alpine` | host 网络，`80/9443` | 150m | `caddy` |
| `relay-keepalive` | `node:22-alpine` | host 网络，`3002` | 512m → 新机 256m | 同名 |
| `image-web-aliyun` | `mssk/image-web:webp`（**自建镜像**） | host 网络，`8788` | 640m | `image-web` |
| `imagegen-shim`（海外机） | `node:22-alpine` | `0.0.0.0:8899` | 无限制 → 新机 400m | 同名，改绑 `127.0.0.1:8899` |

> `mssk/image-web:webp` 不是公开镜像，Docker Hub 拉不到。包里 `06-IMAGES/` 带了它的
> `docker save` 产物；`03-APP/image-web/Dockerfile` 也能重建，但不建议（依赖版本会漂）。

## 端口占用（新机最终态）

| 端口 | 监听 | 用途 | 是否对外 |
|---|---|---|---|
| 22 | sshd | 运维 | 对外（建议限源 IP） |
| 80 | caddy | ACME 验证 + 跳转 | 对外 |
| 443 | caddy | 控制台 + API + 生图站 | 对外 |
| 3001 | new-api | 网关 API | **仅 127.0.0.1** |
| 3002 | relay-keepalive | SSE 保活（caddy 内部用） | **仅本机** |
| 8788 | image-web | 生图站后端 | **仅本机**（由 caddy 暴露） |
| 8899 | imagegen-shim | 生图执行层 | **仅 127.0.0.1** |

原海外机上的 `1080`(socks5)、`8443`、`20443`、`2087`、`2053`、`443/udp` 等属于
**与本站无关的代理/VPN 组件**（sing-box、derper、microsocks、tailscale），**不在本包范围内**，
不要搬到新机。

## 挂载与目录布局（新机）

```
/opt/mssk/
├── caddy/
│   ├── Caddyfile
│   ├── data/          ← caddy 自动签发的证书缓存（首次启动自动生成）
│   └── config/
├── new-api/
│   ├── docker-compose.yml
│   └── data/          ← one-api.db 及 WAL（关键数据）
├── console/           ← 控制台静态产物（来自 03-APP/console/）
├── image-web/         ← 生图站程序（ro 挂载进容器）
├── shim/              ← imagegen-shim 程序（ro 挂载进容器）
├── relay-keepalive/   ← 保活脚本
├── secrets/           ← 从 05-SECRETS 解出来的 env（权限必须 600）
├── tools/             ← codex-quota.py / disk-guard.sh 等
├── scripts/           ← 运维脚本（autoupdate 默认不用）
└── data/              ← image-web 的出图数据（生图结果、临时文件）
```

## 关键行为（不许改）

1. `/v1/*` → `127.0.0.1:3002`（keepalive）→ `127.0.0.1:3001`（new-api）。
   **不经过 keepalive 会丢长响应。**
2. `new-api` 只绑 `127.0.0.1:3001`，不对外。
3. 控制台是**静态目录**，不是容器；改 UI 靠替换 `/opt/mssk/console` 里的文件。
4. `codex-quota.json` 由 cron 每 10 分钟覆盖写一次，前端直接读这个文件。
