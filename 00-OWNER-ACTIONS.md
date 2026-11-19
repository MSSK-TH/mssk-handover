# 00 · 需要 owner 提供的东西（agent 先跟他要齐，再动手）

> 这份是给 **agent 用来向 owner 索取资源** 的清单，也是给 **owner 自己核对** 的清单。
> 缺任何一项都不要开始部署——中途缺东西停下来，比返工便宜。

---

## A. 必须由 owner 提供（包里有替代品的不算）

| # | 项目 | 具体要求 | 为什么必须重取 |
|---|---|---|---|
| A1 | **新 VPS** | 境外，最低 2 核 4 GB，Ubuntu 22.04/24.04 或 Debian 12，root 或 sudo 权限，开放 22/80/443 | 原机器要下线 |
| A2 | **新域名**（控制台） | 例如 `api.example.com`，A 记录准备指向新机 | 旧域名跟着旧部署走，不能复用 |
| A3 | **新域名**（生图站） | 例如 `image.example.com`，A 记录指向同一台新机 | 同上 |
| A4 | **DNS 管理权限** | 能改上面两条 A 记录（Cloudflare / 阿里云 DNS / 其它） | 切换由 owner 手动做 |
| A5 | **ACME 邮箱** | 任意可用邮箱，Caddy 申请证书时用 | 新证书要用 |
| A6 | **加密包口令** | `05-SECRETS.enc` 的解压口令（线下传递，不要写进聊天） | 包里没有 |
| A7 | **网页版 Cookie 重新登录** | imagegen-shim 的网页版出图依赖浏览器登录态，换 IP 后大概率要重新登一次（见 `07-MIGRATION.md` 阶段 6 的排障） | Cookie 与 IP/设备绑定 |

> A2/A3 的域名如果 owner 还没买，可以先用**临时域名或直接 IP + 自签证书**跑通验收，
> 但上线前必须换成正式域名，否则客户端配置要改两次。

---

## B. 包里已经带了，不需要 owner 再提供

| 项目 | 在哪 |
|---|---|
| SQLite 数据库（用户 / 令牌 / 渠道 / 密钥 / 日志聚合） | `04-DATA/one-api.db` |
| 控制台前端产物（已构建，直接可跑） | `03-APP/console/` |
| 控制台前端源码改动（patch，供将来重建） | `03-APP/new-api-patch/` |
| image-web 程序与镜像 | `03-APP/image-web/` + `06-IMAGES/mssk-image-web-webp.tar.gz` |
| imagegen-shim 程序 | `03-APP/shim/` |
| shim 的网页版 Cookie、`.env` | `05-SECRETS/`（加密） |
| relay-keepalive 脚本 | `03-APP/keepalive/` |
| Caddy / compose / cron / 运维脚本 | `02-CONFIG/` |
| 额度快照脚本 | `02-CONFIG/tools/codex-quota.py` |
| 最近一份数据库备份 | `04-DATA/one-api.db.backup-latest` |

---

## C. 需要 owner 在部署过程中**亲自确认**的三件事

1. **DNS 什么时候切**。agent 把新机跑通、验收通过后停下来，由 owner 改 A 记录。
   切换前旧机器保持运行，切换后观察 24 小时再关旧机。
2. **网页版 Cookie 是否重新登录**。如果生图站出图报 401/403，需要 owner 登录一次
   ChatGPT 网页版并导出 Cookie（`07-MIGRATION.md` 阶段 6 有详细步骤）。
3. **是否启用自动升级**。默认关闭（版本冻结）。只有 owner 明确说"要升级 new-api"
   时才启用 `02-CONFIG/cron/new-api-autoupdate.disabled`。

---

## D. 交接完成后 owner 应该得到

- [ ] 两个域名可访问：控制台能登录、生图站能打开
- [ ] `sk-` 令牌能正常调用（`/v1/chat/completions` 返回 200）
- [ ] 控制台「概览」四档数值（今天 / 近 3 天 / 近 7 天 / 近 30 天）互不相同
- [ ] 订阅额度卡有数据（`codex-quota.json` 在更新）
- [ ] 生图站能出一张图
- [ ] `08-VERIFY/verify.sh` 全部通过
- [ ] 旧机器可以安全停机（owner 决定时间）
