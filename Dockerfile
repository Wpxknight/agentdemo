# aiop 后端镜像（HTTP+SSE 服务 / 调度器共用，入口参数区分）
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# 无 lockfile 时回退到 npm install
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 直接用 tsx 运行 TS（项目未做 tsc 产物，moduleResolution=Bundler）
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# skills 目录可选；存在则带上
COPY skills ./skills

# 以非 root 运行
USER node
EXPOSE 8080

# 默认起 HTTP 服务；调度器副本用 command: ["npm","run","scheduler"] 覆盖
CMD ["npm", "run", "serve"]
