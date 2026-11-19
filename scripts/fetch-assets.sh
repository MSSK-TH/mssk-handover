#!/usr/bin/env bash
# 拉取部署所需的大文件（GitHub Release 附件），校验并解包到正确位置。
#
# 用法：
#   bash scripts/fetch-assets.sh                       # 需要 gh CLI 已登录
#   GITHUB_TOKEN=github_pat_xxx bash scripts/fetch-assets.sh   # 没有 gh 时用只读令牌
#   GH_TOKEN=github_pat_xxx bash scripts/fetch-assets.sh       # 同上（gh 也认这个名字）
#   bash scripts/fetch-assets.sh --download-only        # 只下载，不解包
#
# 可用环境变量覆盖：
#   REPO=owner/repo    TAG=v1.0.0    DEST=/root/mssk-assets
set -euo pipefail

# 兼容 GH_TOKEN（gh CLI 优先读它）
if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then export GH_TOKEN="$GITHUB_TOKEN"; fi

REPO="${REPO:-MSSK-TH/mssk-handover}"
TAG="${TAG:-v1.0.0}"
DEST="${DEST:-/root/mssk-assets}"
DOWNLOAD_ONLY=0
[ "${1:-}" = "--download-only" ] && DOWNLOAD_ONLY=1

FILES=(
  "05-SECRETS.enc"
  "console.tar.gz"
  "data-db.tar.gz"
  "mssk-image-web-webp.tar.gz"
)

mkdir -p "$DEST"

echo "==> repo=$REPO tag=$TAG dest=$DEST"

download_with_gh() {
  gh release download "$TAG" --repo "$REPO" --dir "$DEST" --clobber \
     --pattern '*.tar.gz' --pattern '05-SECRETS.enc'
}

download_with_curl() {
  : "${GITHUB_TOKEN:?需要安装 gh CLI，或设置 GITHUB_TOKEN 环境变量（私有仓库的只读 token 即可）}"
  for f in "${FILES[@]}"; do
    echo "--> $f"
    curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
      "https://github.com/${REPO}/releases/download/${TAG}/${f}" \
      -o "${DEST}/${f}"
  done
}

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "==> 用 gh CLI 下载"
  download_with_gh
else
  echo "==> gh 不可用，改用 curl + GITHUB_TOKEN"
  download_with_curl
fi

echo "==> 校验 sha256"
MANIFEST="$(cd "$(dirname "$0")/.." && pwd)/assets/MANIFEST.txt"
if [ -f "$MANIFEST" ]; then
  if ( cd "$DEST" && sha256sum -c "$MANIFEST" >/dev/null 2>&1 ); then
    echo "    ALL ASSETS OK"
  else
    echo "    ⚠️ 校验失败，请删掉 $DEST 重新执行本脚本" >&2
    ( cd "$DEST" && sha256sum -c "$MANIFEST" || true )
    exit 1
  fi
else
  echo "    (未找到 assets/MANIFEST.txt，跳过校验)"
fi

if [ "$DOWNLOAD_ONLY" = "1" ]; then
  echo "==> 只下载，未解包。文件在 $DEST"
  ls -lh "$DEST"
  exit 0
fi

echo "==> 解包到目标位置"
# 控制台静态产物
mkdir -p /opt/mssk/console
tar xzf "$DEST/console.tar.gz" -C /opt/mssk/console
echo "    console  -> /opt/mssk/console ($(find /opt/mssk/console -type f | wc -l) files)"

# 数据库（若 owner 提供了更新的库，请手动覆盖 /opt/mssk/new-api/data/one-api.db）
mkdir -p /opt/mssk/new-api/data
tar xzf "$DEST/data-db.tar.gz" -C /opt/mssk/new-api/data
echo "    data     -> /opt/mssk/new-api/data"

# 镜像
echo "==> 导入镜像（需要 docker）"
if command -v docker >/dev/null 2>&1; then
  docker load -i "$DEST/mssk-image-web-webp.tar.gz"
  docker images | grep image-web || true
else
  echo "    ⚠️ 未检测到 docker，先装 docker 再手动执行："
  echo "       docker load -i $DEST/mssk-image-web-webp.tar.gz"
fi

cat <<EOF

==> 完成。凭据包在 $DEST/05-SECRETS.enc（未解，需 owner 给的口令）

下一步：
  1) 让 owner 确认域名/端口（见 00-YOU-DO-THIS.md）
  2) 打开 07-MIGRATION.md，从阶段 A 开始

EOF
