#!/usr/bin/env bash
# ============================================================================
# new-api 自动更新（带健康检查 + 自动回滚）
#   用法：
#     new-api-autoupdate.sh --check    只看有没有新版（默认）
#     new-api-autoupdate.sh --apply    有新版就升级（失败自动回滚镜像）
#   配置：/opt/mssk/scripts/new-api-update.conf
#   日志：/var/log/new-api-autoupdate.log
# ============================================================================
set -uo pipefail

DIR=/opt/mssk/new-api
CONF=/opt/mssk/scripts/new-api-update.conf
LOG=/var/log/new-api-autoupdate.log
STATE=/opt/mssk/scripts/.new-api-state
REPO=https://github.com/QuantumNous/new-api
HEALTH=http://127.0.0.1:3001/api/status
MODELS=http://127.0.0.1:3001/v1/models

MODE="${1:---check}"

# ---- 配置默认值 ----
AUTO_APPLY=1
KEEP_BACKUPS=5
MIN_MODELS=10
TOKEN_FILE=/opt/mssk/image-web/image-web.env

[ -f "$CONF" ] && . "$CONF"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

compose_image() { grep -m1 'image:' "$DIR/docker-compose.yml" | awk '{print $2}'; }
tag_of() { echo "${1##*:}"; }

# ---- 找最新 tag（用 git，Docker Hub API 在这台机上不通）----
latest_tag() {
  git ls-remote --tags --refs "$REPO" 'v1.0.0-rc.*' 2>/dev/null \
    | awk -F/ '{print $NF}' | grep -E '^v1\.0\.0-rc\.[0-9]+$' | sort -V | tail -1
}

# ---- 健康检查 ----
healthy() {
  local i
  for i in $(seq 1 24); do
    if curl -fsS -m 5 "$HEALTH" >/dev/null 2>&1; then
      local n
      n=$(curl -fsS -m 8 "$MODELS" -H "Authorization: Bearer $(grep -m1 '^RELAY_TOKEN=' "$TOKEN_FILE" | cut -d= -f2-)" 2>/dev/null \
          | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null || echo 0)
      if [ "${n:-0}" -ge "$MIN_MODELS" ]; then
        log "  健康检查通过：模型 $n 个"
        return 0
      fi
      log "  等待模型列表…（当前 $n）"
    fi
    sleep 5
  done
  return 1
}

prune_backups() {
  ls -1t "$DIR"/data/one-api.db.bak-* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
    rm -f "$f" && log "  清理旧备份 $(basename "$f")"
  done
}

CURRENT_IMG=$(compose_image)
CURRENT_TAG=$(tag_of "$CURRENT_IMG")
LATEST_TAG=$(latest_tag)

log "──────── 检查更新 ────────"
log "  当前: $CURRENT_TAG"
log "  最新: ${LATEST_TAG:-（取不到）}"

if [ -z "$LATEST_TAG" ]; then
  log "  ✗ 取不到上游 tag（网络问题？），本次跳过"
  exit 2
fi

if [ "$LATEST_TAG" = "$CURRENT_TAG" ]; then
  log "  ✓ 已是最新"
  echo "$LATEST_TAG" > "$STATE"
  exit 0
fi

log "  有新版：$CURRENT_TAG → $LATEST_TAG"

if [ "$MODE" != "--apply" ] || [ "$AUTO_APPLY" != "1" ]; then
  log "  （未启用自动升级，仅记录）"
  exit 0
fi

# ---- 备份 ----
TS=$(date +%Y%m%d-%H%M%S)
cp -a "$DIR/docker-compose.yml" "$DIR/docker-compose.yml.bak-$TS"
cp -a "$DIR/data/one-api.db" "$DIR/data/one-api.db.bak-$TS" 2>/dev/null
log "  已备份 compose + DB（$TS）"

# ---- 升级 ----
sed -i "s#image: calciumion/new-api:.*#image: calciumion/new-api:$LATEST_TAG#" "$DIR/docker-compose.yml"
cd "$DIR" || exit 1
if ! docker compose pull >/dev/null 2>&1; then
  log "  ✗ 拉镜像失败，回滚 compose"
  sed -i "s#image: calciumion/new-api:.*#image: calciumion/new-api:$CURRENT_TAG#" docker-compose.yml
  exit 3
fi
docker compose up -d >/dev/null 2>&1
log "  容器已重建，等待就绪…"

if healthy; then
  log "  ✅ 升级成功：$LATEST_TAG"
  echo "$LATEST_TAG" > "$STATE"
  prune_backups
  exit 0
fi

# ---- 回滚 ----
log "  ✗ 健康检查失败，回滚到 $CURRENT_TAG"
sed -i "s#image: calciumion/new-api:.*#image: calciumion/new-api:$CURRENT_TAG#" docker-compose.yml
docker compose up -d >/dev/null 2>&1
if healthy; then
  log "  ↺ 已回滚并恢复正常（$CURRENT_TAG）"
  exit 4
fi
log "  ‼ 回滚后仍不健康，需要人工介入（DB 备份：data/one-api.db.bak-$TS）"
exit 5
