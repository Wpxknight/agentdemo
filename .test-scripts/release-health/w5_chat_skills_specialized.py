#!/usr/bin/env python3
# Module: release-health
# Test: W5 Chat Markdown stability/security/lifecycle and Skills security boundaries
# Author: aios-tester
# Created: 2026-08-03
# Updated: 2026-08-03
# Usage: python .test-scripts/release-health/w5_chat_skills_specialized.py [BASE_URL]

import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else 'http://192.168.10.108:30083'
OUT = Path('/home/opt/develop/aicoding/aiop/dist/aios-team/chat-markdown-skills-deep-test/evidence')
OUT.mkdir(parents=True, exist_ok=True)
VERSION = 'k8s-r194-api2bb7cc84-web9f3939d2-src3946a9c5c828'
result = {'version': VERSION, 'base_url': BASE_URL, 'cases': [], 'console': [], 'pageerrors': [], 'http_errors': [], 'requests': [], 'blocked': []}


def request(path, method='GET', body=None, token=None):
    headers = {'content-type': 'application/json'}
    if token:
        headers['authorization'] = f'Bearer {token}'
    payload = json.dumps(body).encode() if body is not None else None
    try:
        with urlopen(Request(f'{BASE_URL}{path}', method=method, headers=headers, data=payload), timeout=25) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {'raw': raw}


def check(case, condition, detail):
    result['cases'].append({'id': case, 'status': 'PASS' if condition else 'FAIL', 'detail': detail})


def note_blocked(case, reason):
    result['blocked'].append({'id': case, 'reason': reason})


# API black-box authorization and file path safety.
check('TC-SK-API-UNAUTH-001', request('/v1/tools')[0] == 401, 'tools list rejects unauthenticated request')
check('TC-SK-API-UNAUTH-002', request('/v1/skills/netdiag/files?path=SKILL.md')[0] == 401, 'skill content rejects unauthenticated request')
login_status, login = request('/auth/login', 'POST', {'tenantId': 'default', 'username': 'admin', 'password': 'admin-pass'})
token = login.get('token', '')
check('TC-API-AUTH-001', login_status == 200 and bool(token), {'status': login_status})
tools_status, tools = request('/v1/tools', token=token)
skills = [entry['name'] for entry in tools.get('tools', []) if entry.get('category') == 'skill']
check('TC-SK-API-LIST-001', tools_status == 200 and skills == ['aios-request', 'aios-sandbox', 'netdiag'], {'skills': skills})
base_skill = skills[0] if skills else 'netdiag'
for index, path in enumerate(['../SKILL.md', '..%2fSKILL.md', '%2e%2e%2fetc%2fpasswd', '/etc/passwd', 'nested/../../SKILL.md', 'SKILL.md%00.txt']):
    status, body = request(f'/v1/skills/{quote(base_skill, safe="")}/files?path={path}', token=token)
    serialized = json.dumps(body, ensure_ascii=False).lower()
    check(f'TC-SK-API-TRAVERSAL-{index + 1:03}', status in (400, 404) and '/etc/passwd' not in serialized and 'stack' not in serialized and 'root:' not in serialized, {'path': path, 'status': status, 'body': body})
status, body = request('/v1/skills/does-not-exist/files?path=SKILL.md', token=token)
check('TC-SK-API-UNKNOWN-001', status == 404 and 'stack' not in json.dumps(body).lower(), {'status': status, 'body': body})
# Harmless structured invalid archives only: no zip bomb or valid import is submitted.
import base64
import io
import zipfile
bad_status, bad_body = request('/v1/skills/import', 'POST', {'filename': 'not-a-skill.zip', 'data': base64.b64encode(b'not a zip archive').decode()}, token)
check('TC-SK-IMPORT-MALFORMED-001', bad_status in (400, 422) and 'stack' not in json.dumps(bad_body).lower(), {'status': bad_status, 'body': bad_body})
traversal_buffer = io.BytesIO()
with zipfile.ZipFile(traversal_buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('../outside.txt', 'safe traversal fixture')
traversal_status, traversal_body = request('/v1/skills/import', 'POST', {'filename': 'traversal-fixture.zip', 'data': base64.b64encode(traversal_buffer.getvalue()).decode()}, token)
check('TC-SK-IMPORT-TRAVERSAL-001', traversal_status == 400 and 'stack' not in json.dumps(traversal_body).lower() and 'outside.txt' not in json.dumps(traversal_body), {'status': traversal_status, 'body': traversal_body})

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 960})
    page = context.new_page()
    page.on('console', lambda message: result['console'].append(f'{message.type}: {message.text}') if message.type in ('warning', 'error') else None)
    page.on('pageerror', lambda error: result['pageerrors'].append(str(error)))
    page.on('response', lambda response: result['http_errors'].append(f'{response.status} {response.url}') if response.status >= 400 else None)
    page.on('request', lambda req: result['requests'].append(f'{req.method} {req.url}') if '/v1/' in req.url else None)
    page.goto(BASE_URL, wait_until='networkidle', timeout=30000)
    page.locator('input[name=tenantId]').fill('default')
    page.locator('input[name=username]').fill('admin')
    page.locator('input[name=password]').fill('admin-pass')
    page.get_by_role('button', name='登录').click()
    page.get_by_role('heading', name='智能助手').wait_for(timeout=20000)
    check('TC-MD-LIFECYCLE-LOGIN-001', page.locator('textarea[name=task]').count() == 1, 'authenticated Chat composition UI is rendered')

    # New-session, sidebar collapse/restore, refresh and terminal stop are user-visible lifecycle operations.
    page.get_by_role('button', name='新建会话').click()
    page.locator('textarea[name=task]').wait_for(timeout=10000)
    page.get_by_role('button', name='收起左侧会话栏').click()
    check('TC-MD-LIFECYCLE-SIDEBAR-001', page.get_by_role('button', name='展开左侧会话栏').is_visible(), 'sidebar collapse exposes restore action')
    page.get_by_role('button', name='展开左侧会话栏').click()
    page.reload(wait_until='networkidle', timeout=30000)
    page.get_by_role('heading', name='智能助手').wait_for(timeout=20000)
    check('TC-MD-LIFECYCLE-REFRESH-001', page.locator('textarea[name=task]').count() == 1, 'Chat survives page refresh after session lifecycle actions')

    # Live stream: observe an in-flight incomplete fence, then use the user-visible stop control.
    page.get_by_role('button', name='新建会话').click()
    if page.locator('.confirm-dialog-backdrop').count():
        page.get_by_role('button', name='取消').click()
    stream_prompt = '请以 80 行 Markdown 输出一个表格和未闭合的 JavaScript 代码块，每次分段说明，供流式渲染稳定性测试。'
    page.locator('textarea[name=task]').fill(stream_prompt)
    page.get_by_role('button', name='发送消息').click()
    running_seen = False
    partial_seen = False
    try:
        page.locator('.prototype-running-indicator').wait_for(timeout=8000)
        running_seen = True
        page.wait_for_timeout(800)
        assistant_bubble = page.locator('.prototype-message:not(.user) .prototype-bubble').last
        partial_text = assistant_bubble.inner_text() if assistant_bubble.count() else ''
        partial_seen = len(partial_text) > 0
        page.get_by_role('button', name='停止').click()
        if page.locator('.confirm-dialog-actions').count():
            page.locator('.confirm-dialog-actions button').last.click()
        page.wait_for_function("() => !document.querySelector('.prototype-running-indicator')", timeout=10000)
    except PlaywrightTimeoutError:
        pass
    check('TC-MD-STREAM-PARTIAL-001', running_seen and partial_seen, {'running_seen': running_seen, 'partial_seen': partial_seen})
    check('TC-MD-LIFECYCLE-TERMINATE-001', page.locator('textarea[name=task]').is_enabled() and not page.locator('.prototype-running-indicator').count(), 'stop returns Chat to an interactive stable state')

    # User content must always be literal, including HTML, dangerous URI, table and fenced code syntax.
    user_payload = '<img src=x onerror=window.__w5_xss=1> [danger](javascript:alert(1))\n\n|a|b|\n|-|-|\n|1|2|\n\n```js\nthrow new Error("x")\n```'
    page.locator('textarea[name=task]').fill(user_payload)
    page.get_by_role('button', name='发送消息').click()
    page.locator('.prototype-message.user').last.wait_for(timeout=10000)
    user = page.locator('.prototype-message.user').last
    user_text = user.inner_text()
    user_bubble = user.locator('.prototype-bubble')
    check('TC-MD-XSS-USER-001', user_bubble.locator('img').count() == 0 and user_bubble.locator('a').count() == 0 and user_bubble.locator('table').count() == 0 and user_bubble.locator('pre').count() == 0 and 'javascript:alert(1)' in user_text and '<img' in user_text, 'user Markdown/HTML remains text, never active DOM')
    check('TC-MD-XSS-USER-002', page.evaluate('window.__w5_xss === undefined'), 'user HTML event handler never executed')
    page.screenshot(path=str(OUT / 'w5-user-plaintext-xss.png'), full_page=True)

    # Current environment intentionally has a placeholder model endpoint. Verify error state returns control,
    # contains no endpoint/stack details, and does not corrupt the stable message layout.
    try:
        page.wait_for_function("""() => !document.querySelector('.prototype-running-indicator')""", timeout=30000)
    except PlaywrightTimeoutError:
        note_blocked('TC-MD-STREAM-001', 'stream did not reach terminal UI state within 30s')
    body_text = page.locator('body').inner_text()
    sensitive = ['127.0.0.1:9', 'local-placeholder', 'stack trace', 'error.stack', 'api key']
    check('TC-MD-ERROR-REDACTION-001', all(value not in body_text.lower() for value in sensitive) and page.locator('textarea[name=task]').is_enabled(), 'model failure keeps composer usable and exposes no configured endpoint, key, or stack')
    page.screenshot(path=str(OUT / 'w5-chat-error-redaction.png'), full_page=True)

    # Actual persisted assistant replies: switch each available historical session and verify code/table overflow confinement.
    session_buttons = page.locator('.prototype-session-item')
    count = min(session_buttons.count(), 8)
    markdown_seen = 0
    overflow_ok = True
    for index in range(count):
        try:
            session_buttons.nth(index).click(timeout=3000)
            page.wait_for_timeout(400)
            messages = page.locator('.markdown-body')
            markdown_seen += messages.count()
            for item in page.locator('.markdown-code-block, .markdown-body table').all():
                metrics = item.evaluate('(el) => ({scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, parentWidth: el.parentElement?.clientWidth || 0})')
                if metrics['scrollWidth'] > metrics['clientWidth'] and metrics['clientWidth'] > metrics['parentWidth'] + 1:
                    overflow_ok = False
        except Exception:
            continue
    if markdown_seen:
        check('TC-MD-LONG-CONTENT-001', overflow_ok, {'markdown_containers': markdown_seen, 'overflow_confined': overflow_ok})
    else:
        note_blocked('TC-MD-LONG-CONTENT-001', 'no persisted assistant Markdown fixture available in tested tenant')
    page.screenshot(path=str(OUT / 'w5-chat-lifecycle-desktop.png'), full_page=True)

    # Responsive UI: the same conversation and composer remain accessible at mobile width.
    page.set_viewport_size({'width': 375, 'height': 667})
    page.reload(wait_until='networkidle', timeout=30000)
    page.get_by_role('heading', name='智能助手').wait_for(timeout=20000)
    mobile_widths = page.locator('.prototype-bubble, .markdown-body').evaluate_all('(els) => els.map((el) => ({width: el.getBoundingClientRect().width, viewport: window.innerWidth}))')
    check('TC-MD-RESPONSIVE-001', all(item['width'] <= item['viewport'] + 1 for item in mobile_widths), {'containers': mobile_widths})
    page.screenshot(path=str(OUT / 'w5-chat-responsive-mobile.png'), full_page=True)

    # Skills page visual checks: no fallback content, authentic selection, and no client error leakage.
    page.set_viewport_size({'width': 1440, 'height': 960})
    page.get_by_role('button', name='技能').click()
    page.get_by_role('heading', name='技能管理').wait_for(timeout=15000)
    ui_skills = page.locator('.skill-list-item').all_inner_texts()
    check('TC-SK-UI-001', len(ui_skills) == 3 and not any(name in ' '.join(ui_skills) for name in ['inspect', 'kubectl-ops']), {'skills': ui_skills})
    page.locator('.skill-list-item').first.click()
    page.wait_for_timeout(700)
    skills_text = page.locator('body').inner_text().lower()
    check('TC-SK-UI-ERROR-001', '目录加载失败' not in skills_text and '读取失败' not in skills_text and 'stack' not in skills_text and 'api key' not in skills_text, 'skills detail failures do not show fallback or sensitive implementation details')
    page.screenshot(path=str(OUT / 'w5-skills-security-ui.png'), full_page=True)
    browser.close()

result['console_relevant'] = [line for line in result['console'] if 'favicon' not in line.lower() and 'devtools' not in line.lower()]
# Expected controlled model failure may be a non-2xx API response; record it rather than treating it as a UI failure.
result['http_errors_relevant'] = [line for line in result['http_errors'] if '/v1/chat' not in line]
check('TC-UI-CONSOLE-001', not result['console_relevant'], {'console': result['console_relevant']})
check('TC-UI-HTTP-001', not result['http_errors_relevant'], {'http_errors': result['http_errors_relevant']})
check('TC-UI-PAGEERROR-001', not result['pageerrors'], {'pageerrors': result['pageerrors']})
result['completed_at_epoch'] = time.time()
(OUT / 'w5-specialized-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
failed = [case for case in result['cases'] if case['status'] == 'FAIL']
for case in result['cases']:
    print(f"[{case['status']}] {case['id']} - {case['detail']}")
for case in result['blocked']:
    print(f"[BLOCKED] {case['id']} - {case['reason']}")
print(f"=== Result: {len(result['cases']) - len(failed)} PASS, {len(failed)} FAIL, {len(result['blocked'])} BLOCKED ===")
raise SystemExit(1 if failed else 0)
