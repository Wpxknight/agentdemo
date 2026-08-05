#!/usr/bin/env python3
# Module: skills
# Test: Skills 页面全量 UI/UE 回测
# Author: aios-tester
# Created: 2026-08-03
# Updated: 2026-08-03
# Usage: python .test-scripts/release-health/w4_skills_ui_full_retest.py [BASE_URL]

from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import sys

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else 'http://192.168.10.108:30083'
OUT = Path('/home/opt/develop/aicoding/aiop/dist/aios-team/chat-markdown-skills-deep-test/evidence')
OUT.mkdir(parents=True, exist_ok=True)
result = {'version': 'k8s-r194-api2bb7cc84-web9f3939d2-src3946a9c5c828', 'cases': [], 'console': [], 'pageerrors': [], 'http_errors': []}

def check(case, condition, detail):
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
    skills = page.locator('.skill-list-item')
    names = skills.all_inner_texts()
    check('TC-UI-SK-001', len(names) == 3 and all(x not in '\n'.join(names) for x in ('inspect', 'kubectl-ops')), {'skills': names})
    search = page.get_by_placeholder('搜索技能...')
    search.fill('netdiag')
    check('TC-UI-SK-SEARCH-001', page.locator('.skill-list-item').count() == 1 and 'netdiag' in page.locator('.skill-list-item').first.inner_text(), 'search returns a real matching Skill')
    search.fill('definitely-no-matching-skill')
    body = page.locator('body').inner_text()
    check('TC-UI-SK-SEARCH-002', page.locator('.skill-list-item').count() == 0 and '暂无可用技能' in body, 'no-match empty state rendered')
    search.fill('')
    page.locator('.skill-list-item').filter(has_text='netdiag').click()
    page.wait_for_timeout(600)
    body = page.locator('body').inner_text()
    check('TC-UI-SK-SELECT-001', 'netdiag' in body and '当前文件 SKILL.md' in body and '容器网络' in body, body[-1000:])
    page.get_by_role('button', name='目录').click()
    page.wait_for_timeout(300)
    body = page.locator('body').inner_text()
    check('TC-UI-SK-DIR-001', 'SKILL.md' in body and '目录加载失败' not in body and '读取失败' not in body, body[-800:])
    page.screenshot(path=str(OUT / 'w4-skills-ui-full-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.reload(wait_until='networkidle', timeout=30000)
    page.get_by_role('button', name='技能').click()
    page.get_by_role('heading', name='技能管理').wait_for(timeout=15000)
    body = page.locator('body').inner_text()
    check('TC-UI-SK-MOBILE-001', len(page.locator('.skill-list-item').all_inner_texts()) == 3 and '目录加载失败' not in body and '读取失败' not in body, 'mobile list and selected file render cleanly')
    page.screenshot(path=str(OUT / 'w4-skills-ui-full-mobile.png'), full_page=True)
    browser.close()

result['console_relevant'] = [x for x in result['console'] if 'favicon' not in x and 'DevTools' not in x]
check('TC-UI-SK-HEALTH-001', not result['http_errors'], {'http_errors': result['http_errors']})
check('TC-UI-SK-HEALTH-002', not result['console_relevant'], {'console': result['console_relevant']})
check('TC-UI-SK-HEALTH-003', not result['pageerrors'], {'pageerrors': result['pageerrors']})
(OUT / 'w4-skills-ui-full-independent.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
failed = [case for case in result['cases'] if case['status'] == 'FAIL']
for case in result['cases']:
    print(f"[{case['status']}] {case['id']} - {case['detail']}")
print(f"=== Result: {len(result['cases']) - len(failed)} PASS, {len(failed)} FAIL ===")
raise SystemExit(1 if failed else 0)
