#!/bin/bash
# 磁盘水位守护
#   80% 记日志 + 告警
#   90% 自动清理（监控备份 / docker 日志 / 系统日志 / apt 缓存）
WARN=80
CRIT=90
LOG=/var/log/disk-guard.log
ts() { date '+%Y-%m-%d %H:%M:%S'; }

usage() { df -P / | awk 'NR==2 {gsub("%","",$5); print $5}'; }

U=$(usage)
[ -z "$U" ] && exit 0

if [ "$U" -ge "$CRIT" ]; then
  echo "$(ts) CRIT ${U}% 开始自动清理" >> "$LOG"

  # 1) 监控备份：只保留最新 1 份
  ls -1t /opt/monitor/data/backup/backup-*.tgz 2>/dev/null | tail -n +2 | xargs -r rm -f

  # 2) docker json 日志超过 50M 的截断到 10M
  find /var/lib/docker/containers -name '*-json.log' -size +50M 2>/dev/null | while read -r f; do
    truncate -s 10M "$f"
  done

  # 3) 系统日志
  journalctl --vacuum-size=100M >/dev/null 2>&1

  # 4) apt 缓存
  apt-get clean >/dev/null 2>&1

  U2=$(usage)
  echo "$(ts) 清理完成 ${U}% -> ${U2}%" >> "$LOG"
  U=$U2
fi

if [ "$U" -ge "$WARN" ]; then
  echo "$(ts) WARN ${U}%" >> "$LOG"
fi

exit 0