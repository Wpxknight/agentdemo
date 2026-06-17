---
name: inspect
description: 集群健康巡检——按步骤检查节点、Pod、事件与资源水位
---

# 集群巡检

当用户要求"巡检"或排查集群健康时，按以下步骤执行（通过 kubectl 工具，指定目标集群）：

1. **节点**：`kubectl get nodes -o wide`，关注 NotReady / 磁盘压力。
2. **异常 Pod**：`kubectl get pods -A | grep -vE 'Running|Completed'`。
3. **近期事件**：`kubectl get events -A --sort-by=.lastTimestamp | tail -50`，关注 Warning。
4. **资源水位**：`kubectl top nodes` 与 `kubectl top pods -A --sort-by=memory | head`。
5. **汇总**：用简洁中文列出发现的问题、影响范围与建议处置（只读，不擅自变更）。

> 涉及变更类操作时，必须先说明再请求确认（生产集群默认需审批）。
