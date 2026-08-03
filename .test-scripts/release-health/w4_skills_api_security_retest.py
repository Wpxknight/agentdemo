#!/usr/bin/env python3
# Module: release-health
# Test: Skills API 权限、路径安全与真实文件内容回测
# Author: aios-tester
# Created: 2026-08-03
# Updated: 2026-08-03
# Usage: python .test-scripts/release-health/w4_skills_api_security_retest.py [BASE_URL]

from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import json
import sys

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else 'http://192.168.10.108:30083'
OUT = Path('/home/opt/develop/aicoding/aiop/dist/aios-team/chat-markdown-skills-deep-test/evidence')
OUT.mkdir(parents=True, exist_ok=True)
results = []

def request(path, method='GET', body=None, token=None):
    headers = {'content-type': 'application/json'}
    if token:
        headers['authorization'] = f'Bearer {token}'
    req = Request(f'{BASE_URL}{path}', method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urlopen(req, timeout=20) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {'raw': raw}

def check(case, condition, detail):
    results.append({'id': case, 'status': 'PASS' if condition else 'FAIL', 'detail': detail})

check('TC-API-UNAUTH-001', request('/v1/tools')[0] == 401, 'tools requires authentication')
check('TC-API-UNAUTH-002', request('/v1/skills/no-such-skill/files')[0] == 401, 'skill files requires authentication')
login_status, login = request('/auth/login', 'POST', {'tenantId': 'default', 'username': 'admin', 'password': 'admin-pass'})
token = login.get('token', '')
check('TC-API-AUTH-001', login_status == 200 and bool(token), {'login_status': login_status})
tools_status, tools = request('/v1/tools', token=token)
skills = [tool for tool in tools.get('tools', []) if tool.get('category') == 'skill']
skill_names = [skill.get('name') for skill in skills]
check('TC-API-SK-001', tools_status == 200 and len(skill_names) >= 1 and 'inspect' not in skill_names and 'kubectl-ops' not in skill_names, {'skills': skill_names})

for index, name in enumerate(skill_names):
    root_status, root = request(f'/v1/skills/{quote(name, safe="")}/files', token=token)
    skill_status, skill = request(f'/v1/skills/{quote(name, safe="")}/files?path=SKILL.md', token=token)
    check(f'TC-API-SK-ROOT-{index + 1}', root_status == 200 and isinstance(root.get('entries'), list), {'name': name, 'status': root_status, 'entry_count': len(root.get('entries', []))})
    check(f'TC-API-SK-BODY-{index + 1}', skill_status == 200 and bool(skill.get('content', '').strip()) and skill.get('path') == 'SKILL.md', {'name': name, 'status': skill_status, 'content_length': len(skill.get('content', ''))})

base_skill = skill_names[0] if skill_names else 'no-such-skill'
for index, malicious in enumerate(['../SKILL.md', '..%2FSKILL.md', '/etc/passwd', '%2e%2e%2fetc%2fpasswd', 'nested/../../SKILL.md']):
    status, body = request(f'/v1/skills/{quote(base_skill, safe="")}/files?path={malicious}', token=token)
    text = json.dumps(body, ensure_ascii=False)
    check(f'TC-API-SK-TRAVERSAL-{index + 1}', status in (400, 404) and 'root:' not in text and '/etc/passwd' not in text, {'path': malicious, 'status': status, 'body': body})

unknown_status, unknown = request('/v1/skills/does-not-exist/files?path=SKILL.md', token=token)
check('TC-API-SK-UNKNOWN-001', unknown_status == 404 and 'stack' not in json.dumps(unknown).lower(), {'status': unknown_status, 'body': unknown})
report = {'version': 'k8s-r194-api2bb7cc84-web9f3939d2-src3946a9c5c828', 'base_url': BASE_URL, 'cases': results}
(OUT / 'w4-skills-api-security-independent.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
failed = [item for item in results if item['status'] == 'FAIL']
for item in results:
    print(f"[{item['status']}] {item['id']} - {item['detail']}")
print(f'=== Result: {len(results) - len(failed)} PASS, {len(failed)} FAIL ===')
raise SystemExit(1 if failed else 0)
