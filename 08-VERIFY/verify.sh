#!/usr/bin/env bash
# MSSK 中转站 · 新机验收脚本
# 用法：./verify.sh
# 退出码：0 = 全部通过；1 = 有失败项（按提示处理后再跑）

set -uo pipefail

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; SKIP=$((SKIP+1)); }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

CODEX_JSON=/opt/mssk/console/codex-quota.json
DB=/opt/mssk/new-api/data/one-api.db
DOMAIN_RELAY="${DOMAIN_RELAY:-}"
DOMAIN_IMAGE="${DOMAIN_IMAGE:-}"

hdr "1. 容器"
for c in new-api caddy relay-keepalive image-web imagegen-shim; do
  state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  if [ "$state" = "running" ]; then ok "容器 $c running"; else bad "容器 $c 状态=$state（docker logs $c --tail 50）"; fi
done

hdr "2. 端口与本地接口"
check_url() { # name url expect
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$2" 2>/dev/null)
  if [ "$code" = "$3" ]; then ok "$1 → $code"; else bad "$1 → $code（期望 $3）"; fi
}
check_url "new-api /api/status"        http://127.0.0.1:3001/api/status 200
check_url "keepalive(3002) 转发"        http://127.0.0.1:3002/api/status 200
check_url "image-web /api/health"      http://127.0.0.1:8788/api/health 200
check_url "caddy 本机 :80 控制台"        http://127.0.0.1:80/ 200

# shim：不同版本路径不同，任一个通就算过
shim_code=""
for p in /healthz /health /ck-status /; do
  c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:8899$p" 2>/dev/null)
  [ "$c" != "000" ] && shim_code="$p → $c" && break
done
if [ -n "$shim_code" ]; then ok "imagegen-shim 有响应（$shim_code）"; else bad "imagegen-shim 无响应（docker logs imagegen-shim --tail 50）"; fi

hdr "3. 数据库"
if [ -f "$DB" ]; then
  ok "one-api.db 存在（$(du -h "$DB" | cut -f1)）"
  [ -f "${DB}-wal" ] && ok "one-api.db-wal 存在（丢失它会丢最近写入）" || bad "缺少 one-api.db-wal"
  rows=$(python3 - "$DB" <<'PY' 2>/dev/null
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
print(c.execute('select count(*) from users').fetchone()[0],
      c.execute('select count(*) from tokens').fetchone()[0],
      c.execute('select count(*) from channels').fetchone()[0])
PY
)
  if [ -n "$rows" ]; then
    set -- $rows
    [ "$1" -ge 1 ] && ok "users=$1 tokens=$2 channels=$3" || bad "users 表为空，数据库可能没搬全"
  else
    bad "无法读取数据库表（sqlite3/python 缺失或文件损坏）"
  fi
else
  bad "找不到 $DB"
fi

hdr "4. 管理接口鉴权"
TOKEN=$(python3 - "$DB" <<'PY' 2>/dev/null
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
row=c.execute('select access_token from users where id=1').fetchone()
print((row[0] or '').strip() if row else '')
PY
)
if [ -n "$TOKEN" ]; then
  succ=$(curl -s -m 8 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/api/user/self | grep -o '"success":true' | head -1)
  [ -n "$succ" ] && ok "/api/user/self success=true" || bad "/api/user/self 未返回 success=true"
else
  bad "数据库里取不到 admin access_token"
fi

hdr "5. 控制台静态产物"
if [ -f /opt/mssk/console/index.html ]; then
  entry=$(grep -oE 'index\.[a-z0-9]+\.js' /opt/mssk/console/index.html | head -1)
  ok "index.html 存在，入口 $entry"
  [ -f "/opt/mssk/console/static/js/$entry" ] && ok "入口 JS 文件存在" || bad "入口 JS 缺失：static/js/$entry"
  [ -f /opt/mssk/console/static/image/wall-2.jpg ] && ok "壁纸文件存在" || skip "壁纸文件缺失（不影响功能，仅影响外观）"
else
  bad "缺少 /opt/mssk/console/index.html"
fi

hdr "6. 订阅额度快照"
if [ -f "$CODEX_JSON" ]; then
  pct=$(grep -o '"used_percent":[[:space:]]*[0-9.]*' "$CODEX_JSON" | head -1)
  [ -n "$pct" ] && ok "codex-quota.json 有效（$pct）" || bad "codex-quota.json 里没有 used_percent"
  age=$(( $(date +%s) - $(stat -c %Y "$CODEX_JSON") ))
  [ "$age" -lt 1200 ] && ok "快照新鲜（${age}s 前更新）" || skip "快照较旧（${age}s），等 cron 下一次"
else
  bad "codex-quota.json 不存在（阶段 7 的 cron 是否安装并成功跑过？）"
fi

hdr "7. cron"
for f in mssk-quota disk-guard; do
  [ -f "/etc/cron.d/$f" ] && ok "/etc/cron.d/$f 已安装" || bad "/etc/cron.d/$f 缺失"
done
[ -f /etc/cron.d/new-api-autoupdate ] && bad "new-api-autoupdate 被安装了（应禁用，版本冻结）" || ok "autoupdate 未启用（正确）"

hdr "8. 域名（DNS 切换后才有效）"
if [ -n "$DOMAIN_RELAY" ]; then
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$DOMAIN_RELAY/" 2>/dev/null)
  [ "$code" = "200" ] && ok "https://$DOMAIN_RELAY → 200" || skip "https://$DOMAIN_RELAY → $code（DNS 可能还没切）"
  code2=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$DOMAIN_IMAGE/" 2>/dev/null)
  [ "$code2" = "200" ] && ok "https://$DOMAIN_IMAGE → 200" || skip "https://$DOMAIN_IMAGE → $code2（DNS 可能还没切）"
else
  skip "未设置 DOMAIN_RELAY/DOMAIN_IMAGE，跳过域名检查（source /root/mssk.env 后再跑）"
fi

hdr "9. 端到端调用（可选，会消耗额度）"
if [ "${E2E:-0}" = "1" ]; then
  SK=$(python3 - "$DB" <<'PY' 2>/dev/null
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
row=c.execute("select key from tokens where status=1 order by id limit 1").fetchone()
print('sk-'+(row[0] if row else ''))
PY
)
  if [ "$SK" != "sk-" ]; then
    resp=$(curl -s -m 60 http://127.0.0.1:3002/v1/chat/completions \
      -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
      -d '{"model":"'"${E2E_MODEL:-gpt-4o-mini}"'","messages":[{"role":"user","content":"say OK"}],"max_tokens":5}')
    echo "$resp" | grep -q '"choices"' && ok "/v1/chat/completions 返回 choices" || bad "/v1 调用失败：$(echo "$resp" | head -c 200)"
  else
    skip "没有可用的 sk- 令牌"
  fi
else
  skip "端到端调用默认关闭；要跑：E2E=1 E2E_MODEL=<模型名> ./verify.sh"
fi

printf '\n\033[1m===== 结果：PASS=%d  FAIL=%d  SKIP=%d =====\033[0m\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] && printf '\033[32m全部通过，可以进入阶段 9（DNS 切换）。\033[0m\n' || printf '\033[31m有失败项，先修好再继续。\033[0m\n'
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
