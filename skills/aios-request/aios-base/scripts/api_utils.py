"""
API 公共工具层。
封装 HTTP 调用、分页、认证头构造、资源解析等跨脚本共享逻辑。
"""

import json
import sys
from typing import Callable, Optional, Tuple

import requests

from auth import get_auth_headers
from config import BASE_URL
from context import (
    get_current_project_id,
    get_default_project_id,
    get_default_tenant_id,
)


# ---------------------------------------------------------------------------
# 编码修复
# ---------------------------------------------------------------------------

def fix_stdout_encoding():
    """Windows 下将 stdout 重编码为 UTF-8，避免中文乱码。"""
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# HTTP 快捷方法
# ---------------------------------------------------------------------------

def api_get(url: str, headers: dict, params: dict = None, timeout: int = 15) -> dict:
    """GET 请求，返回解析后的 JSON。"""
    resp = requests.get(url, headers=headers, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def api_post(url: str, headers: dict, json: dict = None, params: dict = None,
             timeout: int = 15) -> dict:
    """POST 请求，返回解析后的 JSON。"""
    resp = requests.post(url, headers=headers, json=json, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def api_delete(url: str, headers: dict, params: dict = None, timeout: int = 15) -> dict:
    """DELETE 请求，返回解析后的 JSON。"""
    resp = requests.delete(url, headers=headers, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def api_put(url: str, headers: dict, json: dict = None, params: dict = None,
            timeout: int = 15) -> dict:
    """PUT 请求，返回解析后的 JSON。"""
    resp = requests.put(url, headers=headers, json=json, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# 认证头构造
# ---------------------------------------------------------------------------

def make_project_headers(extra: dict = None) -> dict:
    """用默认 project/tenant 构建认证头（缺失时不抛异常）。

    适用于 get_train_frameworks、get_dataset_list 等可选 project 的查询。
    """
    project_id = get_default_project_id()
    tenant_id = get_default_tenant_id()
    merged = {"projectId": str(project_id)} if project_id else {}
    if extra:
        merged.update(extra)
    return get_auth_headers(merged, tenant_id=tenant_id, require_tenant=False)


def make_current_project_headers(extra: dict = None) -> dict:
    """用当前 project 构建认证头（缺失时抛 ContextError）。

    适用于推理/训练/资源等必须有 project 上下文的操作。
    """
    project_id = get_current_project_id()
    merged = {"projectId": str(project_id)}
    if extra:
        merged.update(extra)
    return get_auth_headers(merged)


# ---------------------------------------------------------------------------
# 分页
# ---------------------------------------------------------------------------

def paginate_get(
    url: str,
    headers: dict,
    params: dict = None,
    *,
    record_keys: tuple = ("records", "list", "items"),
    start_page: int = 1,
    page_size: int = 50,
    timeout: int = 15,
) -> list:
    """自动翻页，拉取全部记录。

    自动注入 current/size/pageNum/pageSize 四个分页参数。
    按 record_keys 顺序提取每页记录，直到达到 total 或收到空页。
    """
    base_params = dict(params or {})
    all_records: list = []
    page = start_page

    while True:
        page_params = {
            **base_params,
            "current": page, "size": page_size,
            "pageNum": page, "pageSize": page_size,
        }
        resp = requests.get(url, headers=headers, params=page_params, timeout=timeout)
        resp.raise_for_status()
        data = resp.json().get("data", {})

        records: list = []
        for key in record_keys:
            records = data.get(key) or []
            if records:
                break

        all_records.extend(records)
        total = data.get("total", 0)
        if len(all_records) >= total or not records:
            break
        page += 1

    return all_records


def paginate_find(
    url: str,
    headers: dict,
    params: dict = None,
    *,
    match_fn: Callable,
    record_keys: tuple = ("records", "list", "items"),
    start_page: int = 1,
    page_size: int = 20,
    timeout: int = 15,
) -> Optional[dict]:
    """在分页结果中搜索第一条匹配记录（找到即停，不拉剩余页）。

    Args:
        match_fn: 接受一条 record，返回 True 表示匹配。
    """
    base_params = dict(params or {})
    page = start_page

    while True:
        page_params = {
            **base_params,
            "current": page, "size": page_size,
            "pageNum": page, "pageSize": page_size,
        }
        resp = requests.get(url, headers=headers, params=page_params, timeout=timeout)
        resp.raise_for_status()
        data = resp.json().get("data", {})

        records: list = []
        for key in record_keys:
            records = data.get(key) or []
            if records:
                break

        for record in records:
            if match_fn(record):
                return record

        total = data.get("total", 0)
        fetched = page * page_size
        if fetched >= total or not records:
            break
        page += 1

    return None


# ---------------------------------------------------------------------------
# 资源解析
# ---------------------------------------------------------------------------

def get_project_resource_groups(project_id: str) -> dict:
    """获取项目详情（包含 resourceGroup、resourceSpec 等）。"""
    headers = get_auth_headers({"projectId": str(project_id)})
    data = api_get(f"{BASE_URL}/upmstreeapi/projects/{project_id}", headers)
    return data.get("data", {})


def get_resource_ids(project_id: str) -> Tuple[str, int]:
    """查询项目的资源组 ID 和首选 GPU 规格 quotaId。

    Returns:
        (resource_group_id: str, resource_spec_quota_id: int)

    Raises:
        RuntimeError: 资源组或规格不可用。
    """
    project_data = get_project_resource_groups(project_id)

    resource_groups = project_data.get("resourceGroup", [])
    if not resource_groups:
        raise RuntimeError(
            f"项目 {project_id} 没有可用的资源组，请先在平台上配置。\n"
            f"项目详情：{json.dumps(project_data, ensure_ascii=False)}"
        )

    resource_group_id = resource_groups[0].get("id")
    if not resource_group_id:
        raise RuntimeError(f"无法从资源组数据中提取 id：{resource_groups[0]}")

    resource_specs = project_data.get("resourceSpec", [])
    if not resource_specs:
        raise RuntimeError(
            f"项目 {project_id} 没有可用的资源规格。\n"
            f"项目详情：{json.dumps(project_data, ensure_ascii=False)}"
        )

    gpu_specs = [s for s in resource_specs if s.get("specType") == "gpu"]
    chosen_spec = gpu_specs[0] if gpu_specs else resource_specs[0]
    resource_spec_id = chosen_spec.get("quotaId")
    if not resource_spec_id:
        raise RuntimeError(f"无法从资源规格数据中提取 quotaId：{chosen_spec}")

    print(
        f"[info] 使用资源组: {resource_groups[0].get('name')} ({resource_group_id})",
        file=sys.stderr,
    )
    print(
        f"[info] 使用资源规格: {chosen_spec.get('name')} (quotaId={resource_spec_id})",
        file=sys.stderr,
    )
    return str(resource_group_id), int(resource_spec_id)
