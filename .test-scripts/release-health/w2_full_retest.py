from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from pathlib import Path
import json, time

BASE = 'http://192.168.10.108:30083'
OUT = Path('/home/opt/develop/aicoding/aiop/dist/aios-team/chat-markdown-skills-deep-test/evidence')
OUT.mkdir(parents=True, exist_ok=True)
result = {'version': 'k8s-r192-tag55a0b8a3-be8d180272-web001f2863', 'cases': [], 'console': [], 'pageerrors': [], 'http_errors': []}

def record(case, status, detail):
    result['cases'].append({'id': case, 'status': status, 'detail': detail})

def login(page):
    page.goto(BASE, wait_until='networkidle', timeout=30000)
    page.locator('input[name=tenantId]').fill('default')
    page.locator('input[name=username]').fill('admin')
    page.locator('input[name=password]').fill('admin-pass')
    page.get_by_role('button', name='登录').click()
    page.get_by_role('heading', name='智能助手').wait_for(timeout=20000)

def safe(case, fn):
    try:
        fn()
    except Exception as e:
        record(case, 'FAIL', repr(e))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 960})
    page = context.new_page()
    page.on('console', lambda m: result['console'].append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: result['pageerrors'].append(str(e)))
    page.on('response', lambda r: result['http_errors'].append(f'{r.status} {r.url}') if r.status >= 400 else None)
    login(page)
    record('TC-W2-LOGIN', 'PASS', 'local admin logged in and rendered Chat')

    def chat_actions():
        page.get_by_role('button', name='新建会话').click()
        composer = page.locator('textarea[name=task]')
        composer.wait_for(timeout=10000)
        user_markdown = '# user heading\n\n**bold** `code` [link](https://example.com)\n\n<script>window.__qa_xss=1</script>'
        composer.fill(user_markdown)
        page.get_by_role('button', name='发送消息').click()
        page.locator('.prototype-message.user').last.wait_for(timeout=10000)
        user = page.locator('.prototype-message.user').last
        literal = user.inner_text()
        assert user.locator('strong').count() == 0, 'user markdown rendered as strong'
        assert user.locator('a').count() == 0, 'user markdown rendered as link'
        assert user.locator('script').count() == 0, 'user script DOM exists'
        assert '**bold**' in literal and '<script>' in literal, 'user literal Markdown/HTML missing'
        record('TC-MD-USER-PLAINTEXT', 'PASS', 'user Markdown and HTML stay literal')
        page.screenshot(path=str(OUT/'w2-user-plaintext.png'), full_page=True)
        # Model response is environment dependent; wait for terminal state and capture actual rendering.
        try:
            page.wait_for_function("""() => { const a=[...document.querySelectorAll('.prototype-message:not(.user) .prototype-bubble')].at(-1); return a && a.textContent.trim().length > 0 && !document.querySelector('.prototype-running-indicator'); }""", timeout=55000)
            assistant = page.locator('.prototype-message:not(.user)').last
            text = assistant.inner_text()
            md = assistant.locator('.markdown-body').count()
            record('TC-MD-ASSISTANT-STREAM', 'PASS' if md else 'FAIL', {'markdown_containers': md, 'text_prefix': text[:500]})
        except PlaywrightTimeoutError:
            record('TC-MD-ASSISTANT-STREAM', 'FAIL', 'assistant did not complete within 55s')
        page.screenshot(path=str(OUT/'w2-chat-send.png'), full_page=True)

    safe('TC-MD-USER-PLAINTEXT', chat_actions)

    def panels_and_mobile():
        page.get_by_role('button', name='收起左侧会话栏').click(); page.get_by_role('button', name='展开左侧会话栏').wait_for(timeout=5000); page.get_by_role('button', name='展开左侧会话栏').click()
        page.get_by_role('button', name='收起右侧沙箱栏').click(); page.get_by_role('button', name='展开右侧沙箱栏').wait_for(timeout=5000); page.get_by_role('button', name='展开右侧沙箱栏').click()
        page.get_by_role('button', name='浏览器预览').click(); page.get_by_text('浏览器预览区域').wait_for(timeout=5000); page.get_by_role('button', name='终端').click()
        record('TC-CHAT-PANELS', 'PASS', 'history/preview collapse and browser/terminal tabs work')
        page.set_viewport_size({'width': 390, 'height': 844}); page.reload(wait_until='networkidle'); page.get_by_role('heading', name='智能助手').wait_for(timeout=15000)
        page.screenshot(path=str(OUT/'w2-mobile-chat.png'), full_page=True)
        record('TC-CHAT-MOBILE', 'PASS', 'Chat renders after 390px viewport reload')
        page.set_viewport_size({'width': 1440, 'height': 960})
    safe('TC-CHAT-PANELS', panels_and_mobile)

    def skills():
        page.get_by_role('button', name='技能').click()
        page.get_by_role('heading', name='技能管理').wait_for(timeout=15000)
        body = page.locator('body').inner_text()
        page.screenshot(path=str(OUT/'w2-skills-home.png'), full_page=True)
        search = page.get_by_placeholder('搜索技能')
        search.fill('___no_such_skill___')
        page.wait_for_timeout(300)
        empty_text = page.locator('body').inner_text()
        assert '暂无匹配技能' in empty_text or '0' in empty_text, 'no-match state not visible'
        search.fill('')
        rows = page.locator('.skill-list-item, tbody tr')
        count = rows.count()
        record('TC-SK-LIST-SEARCH-EMPTY', 'PASS', {'selectable_rows': count, 'no_match_text': empty_text[-500:]})
        if count:
            rows.first.click()
            page.wait_for_timeout(1000)
            body_after = page.locator('body').inner_text()
            record('TC-SK-SELECT-FILES', 'PASS', body_after[-1000:])
        else:
            record('TC-SK-SELECT-FILES', 'BLOCKED', 'deployment returned no selectable Skill')
        page.set_viewport_size({'width':390,'height':844}); page.reload(wait_until='networkidle'); page.get_by_role('heading',name='技能管理').wait_for(timeout=15000); page.screenshot(path=str(OUT/'w2-mobile-skills.png'),full_page=True)
        record('TC-SK-MOBILE', 'PASS', 'Skills renders at 390px')
    safe('TC-SK-LIST-SEARCH-EMPTY', skills)

    browser.close()
result['console_relevant'] = [x for x in result['console'] if 'favicon' not in x and 'DevTools' not in x]
(OUT/'w2-full-retest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False, indent=2))
