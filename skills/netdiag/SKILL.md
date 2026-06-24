---
name: netdiag
description: 容器网络与节点网络排查——pod/svc/nodeport 不通、抓包、fabric/ovs 流表与节点健康诊断
---

# 网络排查（fabric / OVS 场景）

当用户反馈 **pod 不通 / svc 不通 / nodeport 不通 / DNS 解析失败 / 需要抓包 / 节点网络异常**
时，按下面的流程排查。本 skill 假设你运行在一个**特权 + 主机网络（hostNetwork）的运维沙箱**里
（部署见 `deploy/opensandbox/README.netdiag.md`），因此：

- shell 命令（`sbx__run_command`）直接跑在某个**节点的主机网络命名空间**里：`curl localhost:9013/...`、
  `fabric-admin`、`tcpdump`、`conntrack`、`netstat`、`ping`、`dig`、`nslookup` 都可用。
- `kubectl` 走 in-cluster ServiceAccount，可查资源、`exec` 进 fabric/ovs 容器看流表。

> 该沙箱只落在**一个**节点上。要在 pod/svc 的**对端节点**排查（如目标 pod 在另一节点），
> 用 `kubectl -n kube-system exec <对端节点的 fabric-node pod>` 进对端容器执行，或说明需要在对端节点起沙箱。

环境关键事实（来自 beyondFabric）：

| 项 | 值 |
| --- | --- |
| fabric-admin 路径 | `/opt/cni/bin/fabric-admin` |
| fabric-ctl HTTP 端口 | `9013`（`localhost:9013`） |
| OVS 默认桥名 | `boc0` |
| Pod MAC 注解 key | `kubernetes.customized/fabric-mac` |
| 容器接口名规则 | **MAC 去掉所有冒号** = OVS 端口名（如 `fa:b0:00:aa:bb:cc` → `fab000aabbcc`） |
| fabric DaemonSet | `fabric-node`（含 fabric-ctl/fabric-admin/ovs 命令）、`fabric-ovs`（容器名 `ovs`） |

> fabric 组件所在命名空间默认 `kube-system`，先确认：`kubectl get pod -A | grep -E 'fabric|ovs'`。

---

## 0. 先定位：流量经过哪条路径

- **Pod → ClusterIP Service**：由 **OVS 流表** 实现（看 `boc0` 流表）。
- **NodePort Service**：由 **iptables** 规则实现（看节点 iptables nat 表）。
- **Pod → Pod（跨/同节点）**：OVS 流表 + 路由；用 `route/exist` 接口判断路由是否存在。

先问清楚「源是谁、目标是谁、目标是 podIP / clusterIP / nodePort 哪一种」，再选下面的子流程。

---

## 1. Pod 网络不通排查

1. **拿到 pod 的 IP、MAC、所在节点**：
   ```
   kubectl get pod <pod> -n <ns> -o wide
   kubectl get pod <pod> -n <ns> -o jsonpath='{.metadata.annotations.kubernetes\.customized/fabric-mac}{"\n"}'
   ```
   也可用 fabric-ctl 反查（传 podIP 或 nodeIP）：
   ```
   curl -s "localhost:9013/ip/?ip=<podIP>" | jq .
   ```
   返回里有 `name/namespace/hostIP/macAddr/vlanID/gateway/ipType` 等。

2. **算出容器接口名（OVS 端口名）= MAC 去冒号**。例：`fa:b0:00:aa:bb:cc` → 端口 `fab000aabbcc`。

3. **查路由是否存在**（fabric-ctl）：
   ```
   curl -s "localhost:9013/route/exist?srcIP=<srcIP>&dstIP=<dstIP>&protocol=tcp&dstPort=<port>" | jq .
   ```
   参数：`srcIP/srcMac/srcPort/dstIP/dstMac/dstPort/protocol`。路由不存在 → 多半是 fabric 控制面没下发，结合下一步看流表。

4. **看 OVS 流表**（进 fabric-node 容器，或就近 ovs 命令）：
   ```
   kubectl -n kube-system exec <fabric-node-pod> -c fabric -- ovs-ofctl dump-flows boc0 | grep <端口名或IP>
   kubectl -n kube-system exec <fabric-node-pod> -c fabric -- ovs-vsctl show
   ```
   关注：该端口是否在桥上、是否有 in_port/dl_dst 匹配该 pod 的流、是否有 drop。

5. **必要时抓包**（在主机网络沙箱里直接抓，按容器接口名过滤）：
   ```
   tcpdump -ni <容器接口名> -c 50            # 抓某个 pod 接口
   tcpdump -ni any host <podIP> -c 50        # 按 IP 抓
   ```
   配合在源端 `ping <dstIP>` / `nc -vz <dstIP> <port>` 制造流量，看包是否到达、是否有回包。

6. **连接跟踪**（NAT/会话问题）：
   ```
   conntrack -L | grep <podIP>
   conntrack -E | grep <podIP>               # 实时事件
   ```

---

## 2. Service / NodePort 不通排查

1. **确认 endpoints 是否就绪**（先排除「没有后端」）：
   ```
   kubectl get svc <svc> -n <ns> -o wide
   kubectl get endpoints <svc> -n <ns> -o wide
   ```

2. **ClusterIP（走 OVS 流表）**：在源 pod 所在节点的 fabric-node 容器里看流表，确认有把 clusterIP
   DNAT/转发到后端 podIP 的流：
   ```
   kubectl -n kube-system exec <fabric-node-pod> -c fabric -- ovs-ofctl dump-flows boc0 | grep <clusterIP>
   ```

3. **NodePort（走 iptables）**：在节点主机网络沙箱里直接看 iptables nat 规则：
   ```
   iptables -t nat -nL --line-numbers | grep <nodePort>
   conntrack -L | grep <nodePort>
   ```
   关注 KUBE-/fabric- 链里是否有该 nodePort 的 DNAT 规则、是否命中后端。

4. **DNS（svc 名解析失败）**：
   ```
   nslookup <svc>.<ns>.svc.cluster.local
   dig <svc>.<ns>.svc.cluster.local
   kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
   ```

---

## 3. 基础环境 / 节点健康检查

1. **fabric 节点健康**（最先跑，最省事）：
   ```
   /opt/cni/bin/fabric-admin health show
   /opt/cni/bin/fabric-admin health show --show-errors-only
   /opt/cni/bin/fabric-admin version
   ```

2. **端到端网络探测**（全面，会起探测流量，耗时）：
   ```
   /opt/cni/bin/fabric-admin e2e network
   ```
   也可 `curl -s "localhost:9013/e2e/network" | jq .` / `localhost:9013/health/` / `localhost:9013/perf/`。

3. **fabric / ovs 组件状态**：
   ```
   kubectl get pod -A | grep -E 'fabric|ovs'
   kubectl -n kube-system get ds | grep -E 'fabric|ovs'
   kubectl -n kube-system logs <fabric-node-pod> -c fabric --tail=100
   ```

4. **节点防火墙 / 基础网络**：
   ```
   iptables -L -n | head -50
   nft list ruleset 2>/dev/null | head -50
   systemctl status firewalld 2>/dev/null || true
   ip a; ip r; netstat -tlnp | head
   ```

5. **fabric-admin 其他诊断子命令**（按需）：
   ```
   /opt/cni/bin/fabric-admin debug pod-info -p <pod> -n <ns>     # pod 网络信息
   /opt/cni/bin/fabric-admin trace flow ...                       # 链路 flow trace
   /opt/cni/bin/fabric-admin dump cache                           # 控制面缓存
   ```
   （`fabric-admin <子命令> -h` 看完整参数。）

---

## 汇总与安全约束

- 用简洁中文给出：**现象 → 定位到的环节（路由/流表/iptables/DNS/组件）→ 证据（命令输出关键行）→ 结论与建议**。
- 默认**只读排查**。抓包、`e2e network` 等会产生流量/负载的操作，先说明再执行。
- 任何**变更类**操作（改流表 `ovs-ofctl add/del-flow`、动 iptables、`fabric-admin health fix`、`dp-reload`、重启组件）
  **必须先说明影响并请求确认**；生产环境默认需审批。
- 引用 fabric 内部接口/命令时按上表事实使用，端口固定 `9013`、桥名 `boc0`、接口名=MAC 去冒号。
