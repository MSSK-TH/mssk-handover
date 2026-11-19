#!/bin/bash
DIR=/opt/imagegen-shim/cookies
TARGET=/opt/imagegen-shim/web-cookie.txt

case "$1" in
  list)
    echo "号池："
    for f in "$DIR"/*.txt; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .txt)
      if cmp -s "$f" "$TARGET"; then mark="← 当前生效"; else mark=""; fi
      printf "  %-6s %7s bytes  %s %s\n" "$name" "$(stat -c%s "$f")" "$(stat -c%y "$f" | cut -d. -f1)" "$mark"
    done
    ;;
  a|b|c|d)
    if [ ! -f "$DIR/$1.txt" ]; then echo "没有 $1.txt"; exit 1; fi
    cp "$DIR/$1.txt" "$TARGET"; chmod 600 "$TARGET"
    docker restart imagegen-shim >/dev/null 2>&1
    echo "已切换到 $1，shim 已重启"
    ;;
  status)
    for f in "$DIR"/*.txt; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .txt)
      printf "%-4s " "$name"
      docker exec imagegen-shim node /app/ck-status.mjs "/app/cookies/$name.txt" 2>/dev/null | tr '\n' ' '
      echo
    done
    ;;
  *) echo "用法: $0 list|a|b|c|d|status" ;;
esac