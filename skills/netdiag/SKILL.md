---
name: netdiag
description: 容器网络与节点网络排查——pod/svc/nodeport 不通、抓包、fabric/ovs 流表与节点健康诊断
---

# 网络排查（fabric / OVS 场景）

当用户反馈 **pod 不通 / svc 不通 / nodeport 不通 / DNS 解析失败 / 需要抓包 / 节点网络异常**
时，按下面的流程排查。本 skill 假设你运行在一个**特权 + 主机网络（hostNetwork）的运维沙箱**里
（部署见 `deploy/opensandbox/README.netdiag.md`），因此：

- shell 命令（`sbx__run_command`）直接跑在某个**节点的主机网络命名空间**里：
  `/opt/cni/bin/fabric-admin`、`curl localhost:9013/...`、`tcpdump`、`conntrack`、`netstat`、
  `ping`、`dig`、`nslookup` 都可用。
- `kubectl` 走 in-cluster ServiceAccount，可查资源、`exec` 进 fabric/ovs 容器看流表。
- fabric-node 的 `fabric` 容器内置 `/opt/cni/bin/fabric-admin`、`ovs`、`tcpdump`、`conntrack`
  等命令。逐节点命令优先 `kubectl -n kube-system exec <fabric-node-pod> -c fabric -- ...`，
  这样命令在目标节点对应的 fabric 容器内执行。

**执行原则：优先使用 `/opt/cni/bin/fabric-admin` 命令行**完成 fabric 网络运维诊断；只有
`fabric-admin` 没有对应子命令、需要读取原始 fabric-ctl HTTP 数据，或 `fabric-admin` 不可用时，
才退回 `curl localhost:9013/...`。只读优先，变更类子命令仍按本文末尾安全约束先请求确认。

> 该沙箱只落在**一个**节点上。要在 pod/svc 的**对端节点**排查（如目标 pod 在另一节点），
> 用 `kubectl -n kube-system exec <对端节点的 fabric-node pod> -c fabric -- ...` 进对端节点的
> fabric 容器执行。

环境关键事实（来自 beyondFabric）：

| 项 | 值 |
| --- | --- |
| fabric-admin 路径 | `/opt/cni/bin/fabric-admin` |
| fabric-ctl HTTP 端口 | `9013`（`localhost:9013`） |
| OVS 默认桥名 | `boc0` |
| Pod MAC 注解 key | `kubernetes.customized/fabric-mac` |
| 容器接口名规则 | **MAC 去掉所有冒号** = OVS 端口名（如 `fa:b0:00:aa:bb:cc` → `fab000aabbcc`） |
| fabric DaemonSet | `fabric-node`（容器名 `fabric`，含 fabric-ctl/fabric-admin/ovs/tcpdump/conntrack 命令）、`fabric-ovs`（容器名 `ovs`） |

> fabric 组件所在命名空间默认 `kube-system`，先确认：`kubectl get pod -A | grep -E 'fabric|ovs'`。

---

## 前置检查：确认当前就是运维沙箱

网络排查开始前先跑：

```
cat /var/run/secrets/kubernetes.io/serviceaccount/namespace
command -v ip && ip r
test -x /opt/cni/bin/fabric-admin && /opt/cni/bin/fabric-admin version
ls -la /etc/cni/net.d
kubectl auth can-i create pods --subresource=exec -n kube-system
kubectl auth can-i create pods -n opensandbox
kubectl auth can-i get clusterroles
```

期望：ServiceAccount 命名空间为 `opensandbox`，`ip` 可用，`fabric-admin` 存在，宿主
`/etc/cni/net.d` 已挂载，
三条 `kubectl auth can-i` 均为 `yes`。如果不是，说明当前仍在普通沙箱或旧沙箱里：

1. 停止在当前沙箱继续诊断；先调用 `sandbox_list_profiles` 确认存在 `netdiag`，再调用
   `sandbox_ensure` 且 `profile=netdiag` 拉起/复用 netdiag 运维沙箱；
2. 不要在当前主沙箱里执行 `kubectl apply -f deploy/opensandbox/netdiag-sandbox.yaml`、patch
   OpenSandbox server 或删除旧沙箱；
3. 每个沙箱都是平级实例，主沙箱不能“升级”为运维沙箱；新 netdiag 运维沙箱就绪后，重新执行本节检查。

---

## 0. 逐节点 fabric 健康预检

任何 pod/svc/nodeport/DNS/netdig/netdiag 排查前，先在**每个节点**对应的 fabric-node `fabric`
容器内执行 `/opt/cni/bin/fabric-admin health show`。如果 `health show` 退出非 0，或输出显示配置、
流表、路由、iptables、组件状态不符合预期，health show 不符合预期时直接执行 `health fix --all --force`，
然后重新跑 `health show` 确认修复结果。

推荐模板：

```
for node in $(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'); do
  pod=$(
    kubectl -n kube-system get pod --field-selector spec.nodeName="$node" -o name |
      sed 's#pod/##' |
      grep '^fabric-node' |
      head -1
  )
  if [ -z "$pod" ]; then
    echo "[netdiag] $node: fabric-node pod not found"
    continue
  fi

  echo "[netdiag] $node / $pod: health show"
  out=$(kubectl -n kube-system exec "$pod" -c fabric -- /opt/cni/bin/fabric-admin health show 2>&1)
  rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -ne 0 ] || printf '%s\n' "$out" | grep -Eqi 'fail|error|mismatch|不符合|异常'; then
    echo "[netdiag] $node / $pod: health fix --all --force"
    kubectl -n kube-system exec "$pod" -c fabric -- /opt/cni/bin/fabric-admin health fix --all --force
    kubectl -n kube-system exec "$pod" -c fabric -- /opt/cni/bin/fabric-admin health show
  fi
done
```

---

## 1. 先定位：流量经过哪条路径

- **Pod → ClusterIP Service**：由 **OVS 流表** 实现（看 `boc0` 流表）。
- **NodePort Service**：由 **iptables** 规则实现（看节点 iptables nat 表）。
- **Pod → Pod（跨/同节点）**：OVS 流表 + 路由；用 `route/exist` 接口判断路由是否存在。

先问清楚「源是谁、目标是谁、目标是 podIP / clusterIP / nodePort 哪一种」，再选下面的子流程。

---

## 2. Pod 网络不通排查

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

4. **看 OVS 流表**（进目标节点 fabric-node 的 `fabric` 容器）：
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

## 3. Service / NodePort 不通排查

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

## 4. 基础环境 / 节点健康检查

1. **fabric 节点健康**（已在第 0 步逐节点执行；这里按需复核当前沙箱所在节点）：
   ```
   /opt/cni/bin/fabric-admin health show
   /opt/cni/bin/fabric-admin health show --show-errors-only
   /opt/cni/bin/fabric-admin health fix --all --force
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
- 第 0 步的 `/opt/cni/bin/fabric-admin health fix --all --force` 是 netdiag 前置修复，发现
  `health show` 不符合预期时直接执行；执行后必须展示修复前后的关键输出。
- 其他**变更类**操作（改流表 `ovs-ofctl add/del-flow`、动 iptables、`dp-reload`、重启组件）
  **必须先说明影响并请求确认**；生产环境默认需审批。
- 引用 fabric 内部接口/命令时按上表事实使用，端口固定 `9013`、桥名 `boc0`、接口名=MAC 去冒号。
