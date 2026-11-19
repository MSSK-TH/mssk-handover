# 证书方案

> **默认且唯一推荐：Caddy 自动申请 Let's Encrypt（下面的方案 A）。**
> 只有 owner 明确要求"隐藏源站 IP"或"必须走 Cloudflare"时，才考虑方案 B。
> 方案 C 只用于临时验收，上线前必须换掉。

## 方案 A（默认，推荐）：Caddy 自动申请 Let's Encrypt

前提：

1. 域名 A 记录已指向新机公网 IP；
2. 80 与 443 从公网可达（安全组/防火墙放行）；
3. `Caddyfile` 顶部的 `email` 填了真实邮箱。

`Caddyfile` 里两个站点都**没有写 `tls` 指令**，Caddy 会自动 HTTP-01 验证并签发。
首次启动后 10~60 秒内完成，证书缓存在 `caddy/data/`（容器内挂载到 `/data`）。

验证：

```bash
docker logs caddy 2>&1 | grep -i "certificate obtained"
curl -sI https://__DOMAIN_RELAY__ | head -3
```

失败最常见原因：DNS 还没生效、80 端口没开、或者用了 Cloudflare 代理（橙色云）但
Cloudflare 的 SSL 模式是 "Full (strict)" 而源站还没证书 → 先设 "Full" 或临时关代理。

## 方案 B：Cloudflare Origin 证书（如果 owner 坚持用 CF 代理）

1. Cloudflare 面板 → SSL/TLS → Origin Server → 生成证书（覆盖两个域名）；
2. 放到 `/opt/mssk/caddy/certs/`：
   ```
   __DOMAIN_RELAY__.crt / .key
   __DOMAIN_IMAGE__.crt / .key
   ```
3. `docker-compose.yml` 给 caddy 加一行挂载：
   ```yaml
   - /opt/mssk/caddy/certs:/certs:ro
   ```
4. `Caddyfile` 里给两个站点加：
   ```
   tls /certs/__DOMAIN_RELAY__.crt /certs/__DOMAIN_RELAY__.key
   ```
5. Cloudflare SSL 模式设为 **Full (strict)**。

> 旧部署用的是方案 B（证书文件在旧机器的 `/opt/mssk/caddy/certs/`）。
> 因为域名要换，那些证书对新域名无效，所以**包里没有带**。

## 方案 C：先用临时域名/IP + 自签证书跑验收

赶时间时可以：

```bash
# Caddyfile 里把两个域名临时改成
#   :443 { tls internal ... }
```

Caddy 会自动用内部 CA 签发，浏览器会报警——只用于 owner 验收，上线前必须换回正式域名。
