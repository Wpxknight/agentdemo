#!/usr/bin/env python3
# Module: release-health
# Test: Skills 文件 API 与页面真实数据回测
# Author: aios-tester
# Created: 2026-08-03
# Updated: 2026-08-03
# Usage: python .test-scripts/release-health/w4_bug004_retest.py [BASE_URL]

from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import sys

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else 'http://192.168.10.108:30083'
OUT = Path('/home/opt/develop/aicoding/aiop/dist/aios-team/chat-markdown-skills-deep-test/evidence')
OUT.mkdir(parents=True, exist_ok=True)
result = {'version': 'k8s-r194-api2bb7cc84-web9f3939d2-src3946a9c5c828', 'base_url': BASE_URL, 'cases': [], 'console': [], 'pageerrors': [], 'http_errors': []}

def check(condition, case, detail):
    result['cases'].append({'id': case, 'status': 'PASS' if condition else 'FAIL', 'detail': detail})
    if not condition:
        raise AssertionError(f'{case}: {detail}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 960})
    page = context.new_page()
    page.on('console', lambda m: result['console'].append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: result['pageerrors'].append(str(e)))
    page.on('response', lambda r: result['http_errors'].append(f'{r.status} {r.url}') if r.status >= 400 else None)
    page.goto(BASE_URL, wait_until='networkidle', timeout=30000)
    page.locator('input[name=tenantId]').fill('default')
    page.locator('input[name=username]').fill('admin')
    page.locator('input[name=password]').fill('admin-pass')
    page.get_by_role('button', name='登录').click()
    page.get_by_role('heading', name='智能助手').wait_for(timeout=20000)
    page.get_by_role('button', name='技能').click()
    page.get_by_role('heading', name='技能管理').wait_for(timeout=15000)
    items = page.locator('.skill-list-item')
    item_count = items.count()
    names = items.all_inner_texts()
    check(item_count >= 1, 'TC-SK-001', {'skills': names})
    check('目录加载失败' not in page.locator('body').inner_text() and '读取失败' not in page.locator('body').inner_text(), 'TC-SK-002', 'initial Skill selection has no API load error')
    items.first.click()
    page.wait_for_timeout(1000)
    text = page.locator('body').inner_text()
    check('读取失败' not in text and '目录加载失败' not in text and len(text) > 500, 'TC-SK-003', text[-1200:])
    file_toggle = page.locator('button').filter(has_text='文件').last
    file_toggle.click()
    page.wait_for_timeout(300)
    tree_entries = page.locator('.skill-tree-node').count()
    check('当前文件' in page.locator('body').inner_text() and tree_entries >= 0, 'TC-SK-004', {'tree_entries': tree_entries, 'file_toggle': 'clicked'})
    page.screenshot(path=str(OUT / 'w4-bug004-independent.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.reload(wait_until='networkidle', timeout=30000)
    page.get_by_role('button', name='技能').click()
    page.get_by_role('heading', name='技能管理').wait_for(timeout=15000)
    check('目录加载失败' not in page.locator('body').inner_text() and '读取失败' not in page.locator('body').inner_text(), 'TC-SK-005', 'mobile reload has no Skill API error')
    page.screenshot(path=str(OUT / 'w4-bug004-mobile-independent.png'), full_page=True)
    browser.close()

result['console_relevant'] = [line for line in result['console'] if 'favicon' not in line and 'DevTools' not in line]
check(not result['http_errors'], 'TC-SK-006', {'http_errors': result['http_errors']})
check(not result['console_relevant'], 'TC-SK-007', {'console': result['console_relevant']})
check(not result['pageerrors'], 'TC-SK-008', {'pageerrors': result['pageerrors']})
(OUT / 'w4-bug004-independent.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
failed = [case for case in result['cases'] if case['status'] == 'FAIL']
for case in result['cases']:
    print(f"[{case['status']}] {case['id']} - {case['detail']}")
print(f"=== Result: {len(result['cases']) - len(failed)} PASS, {len(failed)} FAIL ===")
raise SystemExit(1 if failed else 0)
