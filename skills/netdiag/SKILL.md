---
name: netdiag
description: 容器网络与节点网络排查——pod/svc/nodeport 不通、抓包、fabric/ovs 流表与节点健康诊断
---

# 网络排查（fabric / OVS 场景）

用户反馈 **pod/svc/nodeport 不通、DNS 失败、需要抓包、节点网络异常** 时按本流程排查。
本 skill 运行在**特权 + hostNetwork 的运维沙箱**里（部署见 `deploy/opensandbox/README.netdiag.md`）：

- shell 命令直接跑在某个**节点的主机网络命名空间**：`fabric-admin`、`tcpdump`、`conntrack`、
  `iptables*`、`ping`、`dig` 等都可用。
- `kubectl` 走 in-cluster SA。fabric-node 的 `fabric` 容器内置 `/opt/cni/bin/fabric-admin`、`ovs`、`tcpdump`、`conntrack`
  等命令；沙箱本身只落在一个节点上，逐节点命令优先 `kubectl -n kube-system exec <fabric-node-pod> -c fabric -- ...`，
  让命令在目标/对端节点的 fabric 容器内执行。
- **优先使用 `/opt/cni/bin/fabric-admin` 命令行**；没有对应子命令或需要原始数据时才退回
  `curl localhost:9013/...`。只读优先，变更类操作按文末安全约束先确认。

环境关键事实（beyondFabric）：

| 项 | 值 |
| --- | --- |
| fabric-admin 路径 | `/opt/cni/bin/fabric-admin` |
| fabric-ctl HTTP 端口 | `9013`（`localhost:9013`） |
| OVS 默认桥名 | `boc0` |
| Pod MAC 注解 key | `kubernetes.customized/fabric-mac` |
| 容器接口名 = OVS 端口名 | **MAC 去掉所有冒号**（`fa:b0:00:aa:bb:cc` → `fab000aabbcc`） |
| fabric DaemonSet | `fabric-node`（容器 `fabric`，含 fabric-admin/ovs/tcpdump/conntrack）、`fabric-ovs`（容器 `ovs`） |

> fabric 组件命名空间默认 `kube-system`，先 `kubectl get pod -A | grep -E 'fabric|ovs'` 确认。

**iptables 检查铁律**：节点可能**同时存在 iptables-legacy 与 iptables-nft 两套规则**。凡是
本文出现 iptables 检查，`iptables-legacy` 和 `iptables-nft` 都要执行一遍（`iptables` 本身只是
其中一个的别名，单查会漏）：

```
for ipt in iptables-legacy iptables-nft; do
  command -v "$ipt" >/dev/null || continue
  echo "== $ipt =="
  $ipt -nvL INPUT | head -20; $ipt -nvL FORWARD | head -20
  $ipt -nvL | grep -E 'DROP|REJECT'                 # 带计数器，看 DROP 是否增长
  $ipt -t nat -nL --line-numbers | grep -E '<podIP>|<clusterIP>|<nodePort>'
done
```

---

## 前置：确认在 netdiag 运维沙箱

```
cat /var/run/secrets/kubernetes.io/serviceaccount/namespace   # 期望 opensandbox
test -x /opt/cni/bin/fabric-admin && /opt/cni/bin/fabric-admin version
ls /etc/cni/net.d && ip r
kubectl auth can-i create pods --subresource=exec -n kube-system   # 期望 yes
```

不满足 → 说明还在普通沙箱：用 `sandbox_list_profiles` 确认有 `netdiag`，再 `sandbox_ensure`
（`profile=netdiag`）拉起/复用运维沙箱后重查。不要在当前主沙箱里执行 `kubectl apply -f deploy/opensandbox/netdiag-sandbox.yaml`、
patch OpenSandbox server 或删除旧沙箱；每个沙箱都是平级实例，主沙箱不能“升级”为运维沙箱。

## 0. 逐节点 fabric 健康预检

任何排查前，先在**每个节点**的 fabric 容器里跑 `fabric-admin health show`；退出非 0 或输出有
fail/error/mismatch/异常，即 health show 不符合预期时直接执行 `health fix --all --force`，
再 `health show` 复核并展示前后关键输出：

```
for node in $(kubectl get nodes -o name | cut -d/ -f2); do
  pod=$(kubectl -n kube-system get pod --field-selector spec.nodeName="$node" -o name | grep pod/fabric-node | head -1 | cut -d/ -f2)
  [ -z "$pod" ] && { echo "[netdiag] $node: no fabric-node"; continue; }
  echo "== $node / $pod =="
  kubectl -n kube-system exec "$pod" -c fabric -- /opt/cni/bin/fabric-admin health show 2>&1 |
    grep -Eqi 'fail|error|mismatch|异常' &&
    kubectl -n kube-system exec "$pod" -c fabric -- /opt/cni/bin/fabric-admin health fix --all --force
done
```

## 1. 先定位路径

- **Pod → ClusterIP**：OVS 流表（`boc0`）。
- **NodePort**：iptables（nat 表，legacy + nft 都查）。
- **Pod → Pod**：OVS 流表 + 路由（`route/exist`）。

问清「源、目标、目标是 podIP/clusterIP/nodePort 哪种」再选子流程。

## 2. Pod 网络不通

1. **拿 IP/MAC/节点**：`kubectl get pod <pod> -n <ns> -o wide`；MAC 看
   `kubernetes.customized/fabric-mac` 注解，或 `curl -s "localhost:9013/ip/?ip=<podIP>" | jq .`。
2. **容器接口名 = MAC 去冒号**（即 OVS 端口名）。
3. **路由是否下发**：`curl -s "localhost:9013/route/exist?srcIP=..&dstIP=..&protocol=tcp&dstPort=.." | jq .`。
4. **OVS 流表**（目标节点 fabric 容器内）：
   `ovs-ofctl dump-flows boc0 | grep <端口名或IP>`、`ovs-vsctl show`——端口是否在桥上、有无 drop。
5. **抓包**（配合源端 `ping`/`nc -vz` 制造流量）：
   ```
   tcpdump -ni <容器接口名> -c 50
   tcpdump -ni any host <podIP> -c 50
   ```

   **抓包必须配数据路径图**（mermaid 代码块，上下两条泳道：上=请求链路、下=应答链路。
   应答是反向路径、可能走不同网卡，不能省略）：每跳一个节点，写清**哪个节点/Pod 的哪块网卡**
   （Pod eth0 → veth/OVS 端口 → boc0 → 节点物理网卡 → … → 目标Pod eth0）；抓完把结果标回
   图上（✓有包 / ✗缺包 / 未抓，✗ 挂 `miss` 类、未抓挂 `skip` 类）并在**第一个缺包点**节点里
   注明——丢包环节就在「最后见包点 → 第一个缺包点」之间。NodePort/ClusterIP 场景把 DNAT
   前后地址变化标在箭头上（`-->|DNAT: nodeIP:30080→10.244.2.8:80|`）。示例：

   ```mermaid
   flowchart TB
     subgraph REQ["请求链路 srcPod(10.244.1.5) ⇒ dstPod(10.244.2.8)"]
       direction LR
       q1["源Pod eth0 ✓"] --> q2["节点A veth:fab000aabbcc ✓"]
       q2 --> q3["节点A boc0 ✓"] --> q4["节点A ens192 ✓"]
       q4 --> q5["节点B ens192 ✓"] --> q6["节点B boc0 ✓"]
       q6 --> q7["节点B veth:fab000ddeeff ✓"] --> q8["目标Pod eth0 ✓"]
     end
     subgraph REP["应答链路 dstPod(10.244.2.8) ⇒ srcPod(10.244.1.5)"]
       direction LR
       r1["目标Pod eth0 ✓"] --> r2["节点B veth:fab000ddeeff ✓"]
       r2 --> r3["节点B boc0 ✓"] --> r4["节点B ens192 ✗<br/>第一个缺包点"]
       r4 --> r5["节点A ens192 ✗"] --> r6["节点A boc0 未抓"]
       r6 --> r7["节点A veth:fab000aabbcc 未抓"] --> r8["源Pod eth0 ✗"]
     end
     REQ ~~~ REP
     classDef miss fill:#fee2e2,stroke:#dc2626,color:#991b1b
     classDef skip fill:#f1f5f9,stroke:#94a3b8,color:#64748b,stroke-dasharray:4 3
     class r4,r5,r8 miss
     class r6,r7 skip
   ```

6. **conntrack**：`conntrack -L | grep <podIP>`；实时 `conntrack -E | grep <podIP>`。
7. **宿主侧必查：iptables / 路由 / 系统日志**。排查具体连通性问题（某 IP ping 不通、端口不通、
   时通时断）时，**源节点、目标节点及途经节点的 iptables 规则是必查项**（legacy + nft 两套都查，
   用开头的铁律片段），不能只看流表。另查：
   ```
   ip r; ip route get <dstIP>                    # 路由是否指向预期出口
   ip neigh | grep -E '<podIP>|<dstIP>'          # 邻居表 FAILED/INCOMPLETE
   dmesg -T | tail -50                           # 内核：netfilter/驱动/conntrack 表满
   journalctl -k --since "10 min ago" | tail -50
   journalctl -u kubelet --since "10 min ago" | tail -50
   ```
   跨节点在**对端节点**同样执行；DROP 命中、路由缺失、内核报错都要摘关键行作证据。

## 3. Service / NodePort 不通

1. **endpoints 是否就绪**：`kubectl get svc/endpoints <svc> -n <ns> -o wide`（先排除没后端）。
2. **ClusterIP**：源节点 fabric 容器里 `ovs-ofctl dump-flows boc0 | grep <clusterIP>`。
3. **NodePort**：iptables nat 规则（**legacy + nft 都查**，关注 KUBE-/fabric- 链的 DNAT）+
   `conntrack -L | grep <nodePort>`。
4. **DNS**：`nslookup/dig <svc>.<ns>.svc.cluster.local`；
   `kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide`。

## 4. 节点健康 / 集群巡检

1. **fabric 健康**：`fabric-admin health show [--show-errors-only]`，异常则 `health fix --all --force`。
2. **集群网络巡检 `/opt/cni/bin/fabric-admin e2e network`——仅当用户明确提出「检查/巡检集群
   网络」等集群级需求时执行**：它新建探测 pod 做端到端探测、不动现有负载，相对安全；点状问题
   不要主动跑。执行前告知会创建探测 pod 及耗时，执行后汇报结果并确认探测 pod 已清理。
3. **组件状态**：`kubectl get pod -A | grep -E 'fabric|ovs'`；
   `kubectl -n kube-system logs <fabric-node-pod> -c fabric --tail=100`。
4. **防火墙/路由/基础网络**：iptables（legacy + nft）、`nft list ruleset | head -50`、
   `systemctl status firewalld`、`ip a; ip r; ip route get <目标IP>; ip neigh | head -30`、`netstat -tlnp | head`。
5. **系统日志**：`dmesg -T | tail -80`、`journalctl -k / -u kubelet / -u containerd --since "30 min ago"`、
   `tail -100 /var/log/messages`。
6. **fabric-admin 其他子命令**（按需）：`debug pod-info -p <pod> -n <ns>`、`trace flow ...`、
   `dump cache`；参数看 `fabric-admin <子命令> -h`。

## 汇总与安全约束

- 汇报格式：**现象 → 定位环节（路由/流表/iptables/DNS/系统日志/组件）→ 证据（命令输出关键行）→ 结论与建议**。
- 做过抓包必附**数据路径图**：mermaid 上下双泳道（上请求/下应答）、网卡级路径、标注 ✓/✗/未抓 和第一个缺包点。
- 具体网络问题**必查相关节点 iptables**（legacy + nft 两套、filter + nat），并常规检查路由与系统日志。
- 默认只读。抓包等产生流量的操作先说明再执行；`e2e network` 仅限用户明确要求集群巡检时执行。
- 第 0 步的 `health fix --all --force` 是前置修复，发现异常直接执行并展示修复前后输出；
  其他**变更类**操作（改流表、动 iptables、`dp-reload`、重启组件）必须先说明影响并请求确认。
- 端口固定 `9013`、桥名 `boc0`、接口名 = MAC 去冒号。
