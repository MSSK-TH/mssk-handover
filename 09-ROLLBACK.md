# 09 · 回滚与放弃迁移

> 原则：**每一步都有退路**。已经起好的容器随时可以停；数据库动过之前先备份。
> 回滚不是失败，是流程的一部分。

## 场景 1：容器起不来 / 起错了，还没动数据

```bash
# 停掉所有本包容器（不动宿主机的其它服务）
cd /opt/mssk/caddy          && docker compose down || true
cd /opt/mssk/shim           && docker compose down || true
cd /opt/mssk/image-web      && docker compose down || true
cd /opt/mssk/relay-keepalive && docker compose down || true
cd /opt/mssk/new-api        && docker compose down || true

# 此时数据库文件仍在 /opt/mssk/new-api/data/，没有任何损失
# 修好配置后重新按 07-MIGRATION.md 阶段 5~6 起来即可
```

## 场景 2：数据库被写坏了（升级/迁移过程中）

```bash
# 停 new-api（必须先停，避免写坏备份）
cd /opt/mssk/new-api && docker compose down

# 用包里带的备份恢复
cp /opt/mssk/new-api/data/one-api.db.backup-latest /opt/mssk/new-api/data/one-api.db
rm -f /opt/mssk/new-api/data/one-api.db-wal /opt/mssk/new-api/data/one-api.db-shm

# 校验
python3 -c "import sqlite3;print(sqlite3.connect('/opt/mssk/new-api/data/one-api.db').execute('pragma quick_check').fetchone())"
# 期望：('ok',)

cd /opt/mssk/new-api && docker compose up -d
```

> `one-api.db.backup-latest` 是**迁移那一刻**的备份。迁移之后新增的数据（新令牌、新日志）
> 会丢——这是在"丢全部 vs 丢一部分"之间做的取舍。

## 场景 3：DNS 已经切了，发现新机有问题

**这是最需要冷静的场景。**

```bash
# 立刻把 DNS 改回旧机器 IP（只有 owner 能做，agent 提醒他）
# 旧机器 24 小时内不要关，就是为了这一刻。
```

如果旧机器已经关了：

```bash
# 旧机器重启后，先确认它的服务是自启的
systemctl status docker
docker ps    # 应看到原来的 4 个容器
```

## 场景 4：生图不出图（最常见的"半成功"）

不用回滚，按这个顺序排查：

1. `docker logs imagegen-shim --tail 50` — 看是 Cookie 还是网络问题；
2. 用 `curl http://127.0.0.1:8899/...` 直接调 shim，绕开 new-api 判断是谁的问题；
3. 控制台 → 渠道 → 「Codex生图」→ 点「测试」，看报错；
4. Cookie 过期 → owner 重新登录导出（见 `07-MIGRATION.md` 阶段 6）；
5. 仍然不行 → 生图站可以降级为"只用原生出图"，把渠道里的网页版模型禁用。

**生图挂了不影响 `/v1` 文本调用**——这是两条独立链路，不要因为生图问题回滚整个迁移。

## 场景 5：整台新机搞废了

```bash
# 从零重来：停容器 → 删 /opt/mssk → 重新按 07-MIGRATION.md 从阶段 1 开始
# 包还在 /root 下，数据库还在包里，损失只是时间
```

## 永远不要做

| 动作 | 为什么 |
|---|---|
| `docker system prune -a` | 会把导入的自建镜像 `mssk/image-web:webp` 删掉，包里的 tar 是唯一副本 |
| 在线上直接改 `/opt/mssk/new-api/data/one-api.db` | 没有任何审计，写坏了无法回溯 |
| 关掉旧机器再切 DNS | 顺序反了，出问题没有退路 |
| 把 `05-SECRETS` 解密后的文件留在 `/tmp` | 明文凭据长期驻留 |
