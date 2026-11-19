# cron 安装位置与说明

新机上把本目录的三个文件装到 `/etc/cron.d/`：

| 文件 | 是否启用 | 作用 |
|---|---|---|
| `mssk-quota` | ✅ 必须 | 每 10 分钟生成 `codex-quota.json`（控制台订阅额度卡的数据源） |
| `disk-guard` | ✅ 建议 | 每 10 分钟检查磁盘水位 |
| `new-api-autoupdate.disabled` | ❌ 默认不装 | 每天自动升级 new-api 镜像，会破坏版本冻结；仅 owner 要求升级时启用 |

安装：

```bash
install -m 644 mssk-quota /etc/cron.d/mssk-quota
install -m 644 disk-guard /etc/cron.d/disk-guard
# 需要时再装：
# install -m 644 new-api-autoupdate.disabled /etc/cron.d/new-api-autoupdate
systemctl reload cron 2>/dev/null || systemctl reload crond 2>/dev/null || true
```

**已移除的 cron**：原阿里云上还有一个 `mssk-token-sync`（每小时把 Codex OAuth 凭证推到
另一台机器给 imagegen-shim 用）。单机合并后两端在同一台机器、共用同一个数据库，
这条同步没有必要，因此不在包里。若你将来又拆成两台，需要自己重建这条链路。