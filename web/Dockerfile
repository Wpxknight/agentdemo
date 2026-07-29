FROM node:24-slim AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine

# 走 templates 目录：入口脚本 envsubst 后落到 conf.d（AIOP_FRAME_ANCESTORS 注入 CSP 嵌入白名单）
COPY web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
