# 生图站运行镜像：在官方 node:22-alpine 基础上预装 sharp（图片转 WebP 用）
# 注意：sharp 装在 /deps，不放进 /app —— 因为 /app 是只读挂载，会覆盖镜像里的内容
FROM node:22-alpine

RUN mkdir -p /deps && cd /deps \
 && npm init -y >/dev/null 2>&1 \
 && npm install sharp --registry=https://registry.npmmirror.com --omit=dev --no-audit --no-fund 2>&1 | tail -3

ENV NODE_PATH=/deps/node_modules

WORKDIR /app
CMD ["node", "server.mjs"]
