# 沙箱浏览器中文、终端输出与跨集群连接开发计划

## 范围

- 修复 `aiop-sandbox` Chromium 中文乱码。
- 修复 durable Pi Run 中沙箱 stdout/stderr 无法进入右侧终端。
- 增强 Lifecycle 503 错误详情。
- 验证并推动 cluster-pc1 execd 使用 Portal 可达的数据面入口；该项如需修改 AIOS Sandbox 服务，在对应仓库或部署配置实施。

## 开发步骤

1. **输出契约与桥接测试**
   - 修改 `packages/control-contracts/src/tool.ts`，增加结构化执行增量回调。
   - 修改 `packages/pi-runtime/src/pi/tool-bridge.ts`，将 Pi `onUpdate` 传入 governed runtime。
   - 补充 `tests/pi-runtime/tool-bridge.test.ts` 和 governance 测试。

2. **沙箱输出接线**
   - 修改 `src/agent/tools.ts`、`src/tools/governance.ts`，把当前调用的更新回调映射为 `ToolContext.onOutput`。
   - 保留既有非 durable agent loop 的 `onEvent` 行为，避免双发。
   - 补充 stdout、stderr、并发工具隔离和取消测试。

3. **SSE 与前端回归**
   - 验证 `tool_execution_update -> tool_output SSE -> Session Terminal`。
   - 补充 `tests/contracts/http-projection.test.ts`、`tests/frontend.test.ts`。
   - 验证切换会话时日志写入实际运行会话，不污染当前选中的其他会话。

4. **中文字体镜像**
   - 修改 `deploy/opensandbox/Dockerfile.allinone`，安装 Noto CJK/Emoji 和 fontconfig。
   - 修改 Makefile 镜像检查，增加 `fc-list :lang=zh` 断言。
   - 执行：

     ```bash
     make sandbox-image
     make sandbox-image-check
     make sandbox-image-push
     ```

5. **Lifecycle 错误详情**
   - 修改 `packages/sandbox-runtime/src/aios-http.ts`，在大小限制和脱敏前提下解析错误响应。
   - 补充 409/503 JSON 与非 JSON 错误响应测试。

6. **cluster-pc1 数据面验证**
   - 确认 AIOS Sandbox 对 cluster-pc1 返回的 execd endpoint 类型。
   - 将跨集群入口调整为可路由 Relay/Service，或由网络侧建立受控路由。
   - 验收：创建浏览器沙箱、执行 `echo`、启动 Chromium、打开预览、加载中文页面。

7. **166 部署与验收**
   - 使用 Make 目标构建并部署 AIoP Server/Web 和沙箱镜像。
   - 执行定向测试、完整测试、浏览器端到端测试。
   - 回滚点：AIoP Deployment 上一镜像和 `aiop-sandbox` 上一 digest。

## 验收标准

- 中文网页截图无方框乱码，`fc-list :lang=zh` 有结果。
- `printf 'a'; sleep 1; printf 'b'`：支持流式 Provider 时分段显示；AIOS buffered Provider 至少在命令结束后完整显示 `ab`。
- stderr 使用独立样式显示，不重复进入终端。
- 同时运行两个会话时输出不串线。
- cluster-pc1 沙箱命令不再出现访问远端 Pod IP 的 `no route to host`。
- Lifecycle 失败时 UI 展示可诊断原因，而非仅 `HTTP 503`。

## 预计影响文件

- `Makefile`
- `deploy/opensandbox/Dockerfile.allinone`
- `packages/control-contracts/src/tool.ts`
- `packages/pi-runtime/src/pi/tool-bridge.ts`
- `packages/sandbox-runtime/src/aios-http.ts`
- `src/agent/tools.ts`
- `src/tools/governance.ts`
- `src/server/http.ts`
- `web/src/App.tsx`（仅在回归发现会话归属问题时）
- 对应测试文件

## 风险

- 工作区已有同文件修改，必须基于当前 diff 增量编辑。
- AIOS buffered command API 无法提供真正逐行实时日志。
- cluster-pc1 数据面修复不属于 AIoP 单仓范围，部署前需要确认 AIOS Sandbox 修改入口。
