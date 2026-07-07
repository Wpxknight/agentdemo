"""
数据分析脚本 — 支持 8 种分析维度。

用法：
  python scripts/analyze_report.py --analysis <分析类型> [筛选参数...]

分析类型：
  top-consumers       任务资源消耗排行
  user-resource-stats 用户资源统计
  gpu-split-stats     加速卡切分统计
  health-report       健康状态报表
  task-status-dist    任务状态分布
  user-ranking        活跃度排行
  idle-detection      空闲资源检测
  project-overview    项目资源概览
"""

import argparse
import math
import sys
import os
from collections import defaultdict
from datetime import datetime, timedelta

from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


# ---------------------------------------------------------------------------
# 通用工具函数
# ---------------------------------------------------------------------------

def parse_percent(val) -> float:
    """将 "0.00%" 格式的字符串转为浮点数。"""
    if val is None:
        return 0.0
    s = str(val).replace("%", "").strip()
    try:
        return float(s)
    except (ValueError, TypeError):
        return 0.0


def parse_float(val) -> float:
    """安全地将字符串/数字转为 float。"""
    if val is None:
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def format_duration(ms) -> str:
    """将毫秒转为人类可读的时间字符串。"""
    if not ms or ms <= 0:
        return "0s"
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.1f}min"
    hours = minutes / 60
    if hours < 24:
        return f"{hours:.1f}h"
    days = hours / 24
    return f"{days:.1f}d"


# ---------------------------------------------------------------------------
# 数据拉取函数（直接调用 API，自动全量翻页）
# ---------------------------------------------------------------------------

def _post_json(url, headers, payload, timeout=15):
    resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _get_json(url, headers, params=None, timeout=15):
    resp = requests.get(url, headers=headers, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def fetch_all_tasks(headers, task_type=None, task_status=None,
                    start_time=None, end_time=None, user_name=None,
                    cluster_name=None, project_id=None, page_size=100):
    """全量拉取任务报表数据。"""
    all_items = []
    page = 1
    while True:
        payload = {
            "page": page,
            "limit": page_size,
            "sort": {"key": "startTime", "type": "DESC"},
            "filter": {
                "taskName": None,
                "taskType": task_type,
                "userName": user_name,
                "startTime": start_time,
                "endTime": end_time,
                "taskStatus": task_status,
                "clusterName": cluster_name,
                "projectId": project_id,
            },
        }
        body = _post_json(
            f"{BASE_URL}/aiosreportapi/report/management/tasks/list",
            headers, payload,
        )
        data = body.get("data") or {}
        items = data.get("items") or []
        total = data.get("total") or 0
        all_items.extend(items)
        if len(all_items) >= total or not items:
            break
        page += 1
    return all_items


def fetch_all_resources(headers, resource_type=None, cluster_name=None,
                        user_name=None, page_size=100):
    """全量拉取资源报表数据。"""
    all_items = []
    page = 1
    while True:
        payload = {
            "page": page,
            "limit": page_size,
            "sort": {"key": "resourceUsage", "type": "DESC"},
            "filter": {
                "clusterName": cluster_name,
                "resourceType": resource_type,
                "userName": user_name,
            },
        }
        body = _post_json(
            f"{BASE_URL}/aiosreportapi/report/management/resource/list",
            headers, payload,
        )
        data = body.get("data") or {}
        items = data.get("items") or []
        total = data.get("total", 0)
        all_items.extend(items)
        if len(all_items) >= total or not items:
            break
        page += 1
    return all_items


def fetch_accel_cards(headers, cluster_names=None):
    """拉取全部加速卡数据。"""
    all_items = []
    page = 1
    page_size = 100
    while True:
        payload = {
            "page": page,
            "pageSize": page_size,
            "clusterNames": cluster_names or [],
            "hostName": None, "cardVendor": None, "cardType": None,
            "cardStatus": None, "virtualized": None,
        }
        body = _post_json(
            f"{BASE_URL}/commonserverapi/common/cluster/accecard/manage/list",
            headers, payload,
        )
        data = body.get("data") or {}
        items = data.get("items") or []
        total = data.get("total") or 0
        all_items.extend(items)
        if len(all_items) >= total or not items:
            break
        page += 1
    info = data.get("info", {})
    return all_items, info


def fetch_resource_specs(headers):
    """拉取全部资源规格。"""
    body = _get_json(f"{BASE_URL}/bccapi/resource/specs/all", headers)
    return body.get("data", [])


def fetch_clusters(headers):
    """拉取集群列表。"""
    payload = {
        "category": 2, "clusterName": "", "currPageNum": 1,
        "pageSize": 9999, "sourceType": "", "version": "", "envId": 0,
    }
    body = _post_json(f"{BASE_URL}/bocapi/cluster/v3.0/listBaseInfo", headers, payload)
    return body.get("rows", [])


def fetch_nodes(headers):
    """拉取节点列表。"""
    body = _get_json(
        f"{BASE_URL}/bccapi/node/page/new", headers,
        params={"current": 1, "size": 999, "pageNum": 1, "pageSize": 999},
    )
    data = body.get("data") or {}
    page = data.get("page") or {}
    return {
        "summary": {
            "cpuTotal": data.get("cpuTotal"),
            "memoryTotal": data.get("memoryTotal"),
            "nodeNumTotal": data.get("nodeNumTotal"),
            "gpuNumTotal": data.get("gpuNumTotal"),
            "normalGpuNumTotal": data.get("normalGpuNumTotal"),
            "faultGpuNumTotal": data.get("faultGpuNumTotal"),
        },
        "nodes": page.get("list") or [],
    }


def fetch_overview(headers, path, cluster_name=""):
    """调用总览接口。"""
    payload = {"clusterName": cluster_name, "userId": "", "resourceGroupName": ""}
    body = _post_json(f"{BASE_URL}{path}", headers, payload)
    return body.get("data") or {}


def fetch_projects(headers, page_size=100):
    """全量拉取项目列表。"""
    all_projects = []
    page = 1
    while True:
        body = _get_json(
            f"{BASE_URL}/upmstreeapi/projects", headers,
            params={"projectName": "", "pageNum": page, "pageSize": page_size,
                    "creator": "", "startTime": "", "endTime": ""},
        )
        resp_data = body.get("data") or {}
        projects = resp_data.get("data") or []
        total = resp_data.get("total") or 0
        all_projects.extend(projects)
        if len(all_projects) >= total or not projects:
            break
        page += 1
    return all_projects


def fetch_project_detail(headers, project_id):
    """拉取项目详情。"""
    body = _get_json(f"{BASE_URL}/upmstreeapi/projects/{project_id}", headers)
    return body.get("data") or {}


# ---------------------------------------------------------------------------
# 分析函数
# ---------------------------------------------------------------------------

def analyze_top_consumers(headers, args):
    """需求 3：任务资源消耗排行。"""
    tasks = fetch_all_tasks(
        headers,
        start_time=args.start_time,
        end_time=args.end_time,
        task_type=args.task_type,
        cluster_name=args.cluster_name,
    )

    # 计算资源消耗指标
    scored = []
    for t in tasks:
        duration_ms = t.get("taskDuration", 0) or 0
        duration_h = duration_ms / (1000 * 3600)

        gpu_total = parse_float(t.get("gpu", {}).get("total"))
        cpu_total = parse_float(t.get("cpu", {}).get("total"))
        mem_total = parse_float(t.get("mem", {}).get("total"))

        # 综合消耗分 = GPU小时 + CPU小时 + 内存小时（不同权重）
        gpu_hours = gpu_total * duration_h
        cpu_hours = cpu_total * duration_h
        mem_hours = mem_total * duration_h
        composite = gpu_hours * 10 + cpu_hours + mem_hours * 0.5

        scored.append({
            "taskName": t.get("taskName"),
            "taskId": t.get("taskId"),
            "userName": t.get("userName"),
            "taskType": t.get("taskType"),
            "taskStatus": t.get("taskStatus"),
            "duration": format_duration(duration_ms),
            "durationMs": duration_ms,
            "gpuTotal": gpu_total,
            "cpuTotal": cpu_total,
            "gpuHours": round(gpu_hours, 2),
            "cpuHours": round(cpu_hours, 2),
            "compositeScore": round(composite, 2),
            "startTime": t.get("startTime"),
            "resourceGroupName": t.get("resourceGroupName"),
            "resourceSpecInfo": t.get("resourceSpecInfo"),
        })

    # 按综合消耗分降序
    scored.sort(key=lambda x: x["compositeScore"], reverse=True)
    top_n = scored[:args.top]

    output_result(
        success=True,
        message=f"资源消耗 Top {len(top_n)}（共 {len(tasks)} 个任务）",
        total=len(tasks),
        topN=args.top,
        data=top_n,
    )


def analyze_user_resource_stats(headers, args):
    """需求 2：用户/项目资源统计。"""
    # 资源快照
    resources_gpu = fetch_all_resources(headers, resource_type="GPU")
    resources_cpu = fetch_all_resources(headers, resource_type="CPU")

    # 任务数据聚合
    tasks = fetch_all_tasks(
        headers,
        start_time=args.start_time,
        end_time=args.end_time,
    )

    # 按用户聚合任务资源
    user_stats = defaultdict(lambda: {
        "taskCount": 0,
        "runningTasks": 0,
        "totalGpuHours": 0.0,
        "totalCpuHours": 0.0,
        "totalDurationMs": 0,
    })

    for t in tasks:
        user = t.get("userName", "unknown")
        s = user_stats[user]
        s["taskCount"] += 1
        if t.get("taskStatus") == "Running":
            s["runningTasks"] += 1

        duration_h = (t.get("taskDuration", 0) or 0) / (1000 * 3600)
        gpu_total = parse_float(t.get("gpu", {}).get("total"))
        cpu_total = parse_float(t.get("cpu", {}).get("total"))

        s["totalGpuHours"] += gpu_total * duration_h
        s["totalCpuHours"] += cpu_total * duration_h
        s["totalDurationMs"] += t.get("taskDuration", 0) or 0

    # 组合快照 + 聚合
    user_list = []
    for user, stats in sorted(user_stats.items(), key=lambda x: x[1]["totalGpuHours"], reverse=True):
        # 查找该用户的资源快照
        gpu_alloc = next((r for r in resources_gpu if r.get("userName") == user), None)
        cpu_alloc = next((r for r in resources_cpu if r.get("userName") == user), None)

        entry = {
            "userName": user,
            "taskCount": stats["taskCount"],
            "runningTasks": stats["runningTasks"],
            "totalDuration": format_duration(stats["totalDurationMs"]),
            "totalGpuHours": round(stats["totalGpuHours"], 2),
            "totalCpuHours": round(stats["totalCpuHours"], 2),
            "gpuAllocation": gpu_alloc.get("resourceAllocation", {}) if gpu_alloc else None,
            "gpuUsage": gpu_alloc.get("resourceUsage", "") if gpu_alloc else None,
            "cpuAllocation": cpu_alloc.get("resourceAllocation", {}) if cpu_alloc else None,
            "cpuUsage": cpu_alloc.get("resourceUsage", "") if cpu_alloc else None,
        }
        user_list.append(entry)

    output_result(
        success=True,
        message=f"共 {len(user_list)} 个用户的资源统计",
        totalUsers=len(user_list),
        totalTasks=len(tasks),
        data=user_list,
    )


def analyze_gpu_split_stats(headers, args):
    """需求 4：加速卡切分统计。"""
    cards, card_info = fetch_accel_cards(headers)
    specs = fetch_resource_specs(headers)

    # 规格统计
    gpu_specs = [s for s in specs if s.get("specType") == "gpu"]
    full_card_specs = [s for s in gpu_specs if s.get("isFullCard")]
    split_card_specs = [s for s in gpu_specs if not s.get("isFullCard")]

    # 物理卡统计
    total_cards = len(cards)
    virtualized_cards = [c for c in cards if c.get("hadVirtualization")]
    non_virtualized_cards = [c for c in cards if not c.get("hadVirtualization")]

    # 按卡型号分组
    by_type = defaultdict(list)
    for c in cards:
        by_type[c.get("cardType", "unknown")].append(c)

    card_details = []
    for card in cards:
        card_details.append({
            "cardName": card.get("cardName"),
            "hostName": card.get("hostName"),
            "cardType": card.get("cardType"),
            "cardMode": card.get("cardMode"),
            "hadVirtualization": card.get("hadVirtualization"),
            "utilization": card.get("utilization"),
            "memoryUtilization": card.get("memoryUtilization"),
            "temperature": card.get("temperature"),
            "power": card.get("power"),
            "taskNumber": card.get("taskNumber"),
        })

    spec_summary = []
    for s in gpu_specs:
        spec_summary.append({
            "id": s.get("id"),
            "name": s.get("name"),
            "gpuType": s.get("gpuType"),
            "aiCore": s.get("aiCore"),
            "aiMemory": s.get("aiMemory"),
            "isFullCard": s.get("isFullCard"),
        })

    output_result(
        success=True,
        message=f"GPU 切分统计：{total_cards} 张物理卡",
        cardInfo=card_info,
        summary={
            "totalPhysicalCards": total_cards,
            "virtualizedCards": len(virtualized_cards),
            "nonVirtualizedCards": len(non_virtualized_cards),
            "gpuSpecCount": len(gpu_specs),
            "fullCardSpecCount": len(full_card_specs),
            "splitCardSpecCount": len(split_card_specs),
        },
        specs=spec_summary,
        cards=card_details,
    )


def analyze_health_report(headers, args):
    """需求 5：健康状态报表。"""
    clusters = fetch_clusters(headers)
    node_data = fetch_nodes(headers)
    cards, card_info = fetch_accel_cards(headers)

    # 集群层
    cluster_results = []
    for c in clusters:
        cluster_results.append({
            "clusterId": c.get("clusterId"),
            "clusterName": c.get("clusterName"),
            "clusterStatus": c.get("clusterStatus"),
            "version": c.get("version"),
            "healthy": c.get("clusterStatus") == 1,
        })

    # 节点层
    node_results = []
    for n in node_data["nodes"]:
        status = n.get("status", "")
        sched = n.get("schedulingAble", 0)
        node_results.append({
            "nodeName": n.get("nodeName"),
            "nodeIp": n.get("nodeIp"),
            "clusterName": n.get("clusterName"),
            "status": status,
            "schedulingAble": sched,
            "cpuLimit": n.get("cpuLimit"),
            "memLimit": n.get("memLimit"),
            "gpuNum": n.get("gpuNum"),
            "healthy": status == "Ready" and sched == 1,
        })

    # 加速卡层
    card_results = []
    abnormal_cards = []
    for c in cards:
        card_status = c.get("cardStatus", -1)
        utilization = parse_percent(c.get("utilization"))
        temp = parse_float(c.get("temperature"))
        task_num = c.get("taskNumber", 0)

        is_abnormal = False
        reasons = []
        if card_status != 0:
            is_abnormal = True
            reasons.append(f"cardStatus={card_status}")
        if temp > 85:
            is_abnormal = True
            reasons.append(f"温度过高({temp}°C)")
        if utilization < 1 and task_num > 0:
            is_abnormal = True
            reasons.append(f"有任务但利用率为0%")

        entry = {
            "cardName": c.get("cardName"),
            "hostName": c.get("hostName"),
            "cardType": c.get("cardType"),
            "cardStatus": card_status,
            "utilization": c.get("utilization"),
            "memoryUtilization": c.get("memoryUtilization"),
            "temperature": c.get("temperature"),
            "power": c.get("power"),
            "taskNumber": task_num,
            "healthy": not is_abnormal,
        }
        if is_abnormal:
            entry["abnormalReasons"] = reasons
            abnormal_cards.append(entry)
        card_results.append(entry)

    unhealthy_nodes = [n for n in node_results if not n["healthy"]]
    unhealthy_clusters = [c for c in cluster_results if not c["healthy"]]

    output_result(
        success=True,
        message="健康状态报表"
               + (f"（{len(abnormal_cards)} 张异常卡）" if abnormal_cards else "（全部正常）"),
        summary={
            **node_data["summary"],
            "abnormalCards": len(abnormal_cards),
            "unhealthyNodes": len(unhealthy_nodes),
            "unhealthyClusters": len(unhealthy_clusters),
        },
        clusters=cluster_results,
        nodes=node_results,
        cards=card_results,
        abnormalCards=abnormal_cards,
    )


def analyze_task_status_dist(headers, args):
    """需求 6：任务状态分布。"""
    # 全量拉取所有任务
    tasks = fetch_all_tasks(headers)

    # 全局状态分布
    global_dist = defaultdict(int)
    # 按用户统计
    by_user = defaultdict(lambda: defaultdict(int))
    # 按任务类型统计
    by_type = defaultdict(lambda: defaultdict(int))

    for t in tasks:
        status = t.get("taskStatus", "Unknown")
        user = t.get("userName", "unknown")
        task_type = t.get("taskType", "unknown")

        global_dist[status] += 1
        by_user[user][status] += 1
        by_type[task_type][status] += 1

    # 平台总览数据补充
    task_stats = fetch_overview(
        headers,
        "/aiosreportapi/report/overview/signage/taskNumStatistics",
        cluster_name=args.cluster_name or "",
    )

    user_dist_list = []
    for user, dist in sorted(by_user.items(), key=lambda x: sum(x[1].values()), reverse=True):
        user_dist_list.append({
            "userName": user,
            "total": sum(dist.values()),
            **dict(dist),
        })

    type_dist_list = []
    for ttype, dist in sorted(by_type.items(), key=lambda x: sum(x[1].values()), reverse=True):
        type_dist_list.append({
            "taskType": ttype,
            "total": sum(dist.values()),
            **dict(dist),
        })

    output_result(
        success=True,
        message=f"任务状态分布（共 {len(tasks)} 个任务）",
        globalDist=dict(global_dist),
        totalTasks=len(tasks),
        byUser=user_dist_list,
        byType=type_dist_list,
        platformStats=task_stats.get("taskNum", []),
    )


def analyze_user_ranking(headers, args):
    """需求 7：活跃度排行。"""
    tasks = fetch_all_tasks(headers)

    user_agg = defaultdict(lambda: {
        "taskCount": 0,
        "totalDurationMs": 0,
        "totalGpuAllocated": 0.0,
        "totalCpuAllocated": 0.0,
        "typeCount": defaultdict(int),
    })

    for t in tasks:
        user = t.get("userName", "unknown")
        a = user_agg[user]
        a["taskCount"] += 1
        a["totalDurationMs"] += t.get("taskDuration", 0) or 0
        a["totalGpuAllocated"] += parse_float(t.get("gpu", {}).get("total"))
        a["totalCpuAllocated"] += parse_float(t.get("cpu", {}).get("total"))
        a["typeCount"][t.get("taskType", "unknown")] += 1

    # 排序维度
    sort_key = args.sort_by
    ranking = []
    for user, a in user_agg.items():
        ranking.append({
            "userName": user,
            "taskCount": a["taskCount"],
            "totalDuration": format_duration(a["totalDurationMs"]),
            "totalDurationMs": a["totalDurationMs"],
            "totalGpuAllocated": round(a["totalGpuAllocated"], 2),
            "totalCpuAllocated": round(a["totalCpuAllocated"], 2),
            "typeDistribution": dict(a["typeCount"]),
        })

    if sort_key == "duration":
        ranking.sort(key=lambda x: x["totalDurationMs"], reverse=True)
    elif sort_key == "gpu":
        ranking.sort(key=lambda x: x["totalGpuAllocated"], reverse=True)
    elif sort_key == "cpu":
        ranking.sort(key=lambda x: x["totalCpuAllocated"], reverse=True)
    else:
        ranking.sort(key=lambda x: x["taskCount"], reverse=True)

    output_result(
        success=True,
        message=f"活跃度排行（共 {len(ranking)} 个用户，按 {sort_key} 排序）",
        sortBy=sort_key,
        totalUsers=len(ranking),
        data=ranking,
    )


def analyze_idle_detection(headers, args):
    """需求 8：空闲资源检测。"""
    tasks = fetch_all_tasks(headers, task_status="Running")

    idle_threshold = args.idle_threshold
    duration_threshold_ms = args.duration_threshold * 3600 * 1000  # 小时 → 毫秒

    idle_tasks = []
    for t in tasks:
        duration_ms = t.get("taskDuration", 0) or 0
        gpu_usage = parse_percent(t.get("gpu", {}).get("usage"))
        cpu_usage = parse_percent(t.get("cpu", {}).get("usage"))
        mem_usage = parse_percent(t.get("mem", {}).get("usage"))

        # 判断是否疑似空闲：所有使用率低于阈值，且运行时间超过阈值
        all_low = gpu_usage < idle_threshold and cpu_usage < idle_threshold and mem_usage < idle_threshold
        long_running = duration_ms > duration_threshold_ms

        if all_low and long_running:
            gpu_total = parse_float(t.get("gpu", {}).get("total"))
            cpu_total = parse_float(t.get("cpu", {}).get("total"))
            mem_total = parse_float(t.get("mem", {}).get("total"))

            idle_tasks.append({
                "taskName": t.get("taskName"),
                "taskId": t.get("taskId"),
                "userName": t.get("userName"),
                "taskType": t.get("taskType"),
                "taskStatus": t.get("taskStatus"),
                "duration": format_duration(duration_ms),
                "durationMs": duration_ms,
                "gpuUsage": t.get("gpu", {}).get("usage"),
                "cpuUsage": t.get("cpu", {}).get("usage"),
                "memUsage": t.get("mem", {}).get("usage"),
                "gpuTotal": gpu_total,
                "cpuTotal": cpu_total,
                "memTotal": mem_total,
                "startTime": t.get("startTime"),
                "resourceGroupName": t.get("resourceGroupName"),
            })

    # 按运行时长降序
    idle_tasks.sort(key=lambda x: x["durationMs"], reverse=True)

    # 汇总浪费资源
    wasted_gpu = sum(t["gpuTotal"] for t in idle_tasks)
    wasted_cpu = sum(t["cpuTotal"] for t in idle_tasks)
    wasted_mem = sum(t["memTotal"] for t in idle_tasks)

    output_result(
        success=True,
        message=f"检测到 {len(idle_tasks)} 个疑似空闲任务（共 {len(tasks)} 个运行中）"
               + (f"，浪费 GPU {wasted_gpu:.2f}、CPU {wasted_cpu:.2f}、内存 {wasted_mem:.2f}" if idle_tasks else ""),
        detectionConfig={
            "idleThreshold": f"{idle_threshold}%",
            "durationThreshold": f"{args.duration_threshold}h",
        },
        runningTasks=len(tasks),
        idleCount=len(idle_tasks),
        wastedResources={
            "gpu": round(wasted_gpu, 2),
            "cpu": round(wasted_cpu, 2),
            "memory": round(wasted_mem, 2),
        },
        data=idle_tasks,
    )


def analyze_project_overview(headers, args):
    """需求 9：项目资源概览。"""
    projects = fetch_projects(headers)

    project_list = []
    for p in projects:
        pid = p.get("projectId")
        try:
            detail = fetch_project_detail(headers, pid)
        except Exception:
            detail = {}

        # 资源配额
        specs = detail.get("resourceSpec", [])
        quota_summary = []
        for s in specs:
            use = s.get("useNum", 0)
            total = s.get("totalNum", 0)
            quota_summary.append({
                "name": s.get("name"),
                "specType": s.get("specType"),
                "gpuType": s.get("gpuType"),
                "useNum": use,
                "totalNum": total,
                "utilization": f"{use}/{total}",
            })

        # 资源组
        rgs = detail.get("resourceGroup", [])
        rg_names = [rg.get("name") for rg in rgs]

        # 成员
        member_data = detail.get("member", {})
        members = [
            {"name": m.get("name"), "joinTime": m.get("joinTime")}
            for m in member_data.get("list", [])
        ]

        project_list.append({
            "projectId": pid,
            "projectName": p.get("projectName"),
            "describes": p.get("describes") or detail.get("describes", ""),
            "creator": p.get("creator"),
            "memberNum": p.get("memberNum"),
            "members": members,
            "resourceGroups": rg_names,
            "quota": quota_summary,
            "createTime": p.get("createTime"),
        })

    output_result(
        success=True,
        message=f"项目资源概览（共 {len(project_list)} 个项目）",
        totalProjects=len(project_list),
        data=project_list,
    )


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

ANALYSIS_TYPES = {
    "top-consumers": ("任务资源消耗排行", analyze_top_consumers),
    "user-resource-stats": ("用户资源统计", analyze_user_resource_stats),
    "gpu-split-stats": ("加速卡切分统计", analyze_gpu_split_stats),
    "health-report": ("健康状态报表", analyze_health_report),
    "task-status-dist": ("任务状态分布", analyze_task_status_dist),
    "user-ranking": ("活跃度排行", analyze_user_ranking),
    "idle-detection": ("空闲资源检测", analyze_idle_detection),
    "project-overview": ("项目资源概览", analyze_project_overview),
}


def main():
    parser = argparse.ArgumentParser(description="数据分析脚本")
    parser.add_argument("--analysis", required=True, choices=ANALYSIS_TYPES.keys(),
                        help="分析类型")
    # 通用筛选参数
    parser.add_argument("--start-time", default=None, help="开始时间（YYYY-MM-DD HH:MM:SS）")
    parser.add_argument("--end-time", default=None, help="结束时间（YYYY-MM-DD HH:MM:SS）")
    parser.add_argument("--cluster-name", default=None, help="集群名称筛选")
    parser.add_argument("--task-type", default=None, help="任务类型筛选")
    parser.add_argument("--user-name", default=None, help="用户名筛选")
    # top-consumers 专用
    parser.add_argument("--top", type=int, default=10, help="Top N（默认 10）")
    # user-ranking 专用
    parser.add_argument("--sort-by", default="taskCount",
                        choices=["taskCount", "duration", "gpu", "cpu"],
                        help="活跃度排序维度（默认 taskCount）")
    # idle-detection 专用
    parser.add_argument("--idle-threshold", type=float, default=5.0,
                        help="空闲使用率阈值%%（默认 5）")
    parser.add_argument("--duration-threshold", type=float, default=1.0,
                        help="空闲最短运行时长/小时（默认 1）")
    args = parser.parse_args()

    headers = make_admin_headers({"Content-Type": "application/json;charset=UTF-8"})

    label, fn = ANALYSIS_TYPES[args.analysis]
    fn(headers, args)


if __name__ == "__main__":
    main()
