# aiop 后端镜像（HTTP+SSE 服务 / 调度器共用，入口参数区分）
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY tsconfig.packages.json ./
COPY scripts/build-packages.ts ./scripts/build-packages.ts
# 当前镜像直接用 tsx 运行 TS；tsx 在 devDependencies 中，因此需保留 dev 依赖。
RUN npm ci
RUN npm run build:packages

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 直接用 tsx 运行 TS（项目未做 tsc 产物，moduleResolution=Bundler）
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY --from=deps /app/packages ./packages
# scripts 含 mcp-echo-server.ts 等辅助脚本，供 MCP stdio server 冒烟验证。
COPY scripts ./scripts
# skills 目录需要运行时写入，用于 zip 技能导入。
COPY --chown=node:node skills ./skills

# 以非 root 运行
USER node
EXPOSE 8080

# 默认起 HTTP 服务；调度器副本用 command: ["npm","run","scheduler"] 覆盖
CMD ["npm", "run", "serve"]
