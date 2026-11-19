# 04-DATA

数据库不放在仓库里（含业务敏感数据，且体积大）。

它在 Release 附件 `data-db.tar.gz` 里，由 `scripts/fetch-assets.sh` 自动拉到
`/opt/mssk/new-api/data/`，内容：

- `one-api.db`            主库（用户 / 令牌 / 渠道 / 日志聚合）
- `one-api.db-wal`        WAL，**必须成对存在**，否则丢最近写入
- `one-api.db.backup-latest`  迁移那一刻的备份（出问题用它恢复）

若要换成 owner 当天导出的最新库，见 `07-MIGRATION.md` 的 B3。
