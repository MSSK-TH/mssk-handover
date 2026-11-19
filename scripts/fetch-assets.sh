#!/usr/bin/env bash
# 准备部署资产。
#
#   公开部分（从 Release 自动拉）：console.tar.gz、mssk-image-web-webp.tar.gz
#   私下部分（owner 单独给你）：  data-db.tar.gz、05-SECRETS.enc + 解密口令
#
# 用法：
#   bash scripts/fetch-assets.sh                 # 拉公开资产 + 解包到 /opt/mssk
#   bash scripts/fetch-assets.sh --download-only # 只拉到 $DEST，不解包
#
# 私有文件放这里（脚本会自动识别）：  /root/mssk-private/
#   data-db.tar.gz      数据库 + WAL + 备份
#   05-SECRETS.enc      加密凭据（口令问 owner 要）
#
# 可用环境变量：DEST=/root/mssk-assets  REPO=owner/repo  TAG=v1.0.0
set -euo pipefail

DEST="${DEST:-/root/mssk-assets}"
REPO="${REPO:-MSSK-TH/mssk-handover}"
TAG="${TAG:-v1.0.0}"
PRIVATE_DIR="${PRIVATE_DIR:-/root/mssk-private}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DOWNLOAD_ONLY=0
[ "${1:-}" = "--download-only" ] && DOWNLOAD_ONLY=1

PUBLIC_FILES=("console.tar.gz" "mssk-image-web-webp.tar.gz")
mkdir -p "$DEST"

# ---------- 1. 公开资产 ----------
echo "==> 从 Release 拉公开资产（repo=$REPO tag=$TAG）"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release download "$TAG" --repo "$REPO" --dir "$DEST" --clobber --pattern '*.tar.gz'
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  for f in "${PUBLIC_FILES[@]}"; do
    echo "--> $f"
    curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
      "https://github.com/${REPO}/releases/download/${TAG}/${f}" -o "$DEST/$f"
  done
else
  # 公开仓库不需要认证
  for f in "${PUBLIC_FILES[@]}"; do
    echo "--> $f"
    curl -fsSL "https://github.com/${REPO}/releases/download/${TAG}/${f}" -o "$DEST/$f"
  done
fi

echo "==> 校验公开资产 sha256"
MANIFEST="$HERE/../assets/MANIFEST.txt"
if [ -f "$MANIFEST" ]; then
  if ( cd "$DEST" && sha256sum -c "$MANIFEST" >/dev/null 2>&1 ); then
    echo "    ALL PUBLIC ASSETS OK"
  else
    echo "    ⚠️ 校验失败，删掉 $DEST 重跑" >&2
    ( cd "$DEST" && sha256sum -c "$MANIFEST" || true ); exit 1
  fi
fi

# ---------- 2. 私有资产（owner 私下给） ----------
echo "==> 检查私有资产：$PRIVATE_DIR"
HAVE_PRIVATE=1
for f in "data-db.tar.gz" "05-SECRETS.enc"; do
  if [ -f "$PRIVATE_DIR/$f" ]; then
    echo "    ✔ $f"
  else
    echo "    ✘ 缺少 $f"
    HAVE_PRIVATE=0
  fi
done
if [ "$HAVE_PRIVATE" = "0" ]; then
  cat >&2 <<EOF

⚠️ 私有资产还不全。这两样不能放在公开仓库里，必须由 owner 单独发给你：
     data-db.tar.gz     （数据库 + WAL + 备份）
     05-SECRETS.enc     （加密凭据，解压口令也由 owner 给你）

    放到 $PRIVATE_DIR/ 后重新执行本脚本。
     现在可以先继续 07-MIGRATION.md 的 B1（体检）、B2（只拉公开资产已经完成），
     等 owner 给你之后再回来做 B3。

EOF
fi

if [ "$DOWNLOAD_ONLY" = "1" ]; then
  echo "==> 只准备资产，未解包。位置：$DEST"
  ls -lh "$DEST" | sed '1d'
  exit 0
fi

# ---------- 3. 解包 ----------
echo "==> 解包公开资产"
mkdir -p /opt/mssk/console
tar xzf "$DEST/console.tar.gz" -C /opt/mssk/console
echo "    console -> /opt/mssk/console（$(find /opt/mssk/console -type f | wc -l) 文件）"

if command -v docker >/dev/null 2>&1; then
  echo "==> 导入生图镜像"
  docker load -i "$DEST/mssk-image-web-webp.tar.gz"
  docker images | grep image-web || true
else
  echo "    ⚠️ 未检测到 docker，装好后执行：docker load -i $DEST/mssk-image-web-webp.tar.gz"
fi

if [ "$HAVE_PRIVATE" = "1" ]; then
  echo "==> 解包数据库"
  mkdir -p /opt/mssk/new-api/data
  tar xzf "$PRIVATE_DIR/data-db.tar.gz" -C /opt/mssk/new-api/data
  chown -R 1000:1000 /opt/mssk/new-api/data 2>/dev/null || true
  echo "    data -> /opt/mssk/new-api/data"
fi

cat <<EOF

==> 完成
私有凭据包：$PRIVATE_DIR/05-SECRETS.enc（未解，口令由 owner 给，见 07-MIGRATION.md 的 B3）

下一步：打开 07-MIGRATION.md，从阶段 A 开始。

EOF
