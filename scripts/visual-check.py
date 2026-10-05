"""Inspect the real packaged V4 UI via native Python Playwright CDP and measured Win32 windows."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import time
import uuid


def native_window(pid):
    """Find only our launched unpacked application's visible top-level HWND."""
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    if hasattr(user32, 'SetThreadDpiAwarenessContext'):
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    else:
        user32.SetProcessDPIAware()
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.restype = wintypes.UINT
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    handles = []

    @callback_type
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            handles.append(hwnd)
        return True

    assert user32.EnumWindows(visit, 0)
    assert len(handles) == 1, f'Expected one visible window owned by PID {pid}, found {len(handles)}'
    return user32, handles[0]


def measure_window(user32, hwnd):
    outer, client = wintypes.RECT(), wintypes.RECT()
    assert user32.GetWindowRect(hwnd, ctypes.byref(outer))
    assert user32.GetClientRect(hwnd, ctypes.byref(client))
    dpi = user32.GetDpiForWindow(hwnd)
    assert dpi >= 96
    return {'hwnd': int(hwnd), 'outerPixels': [outer.right - outer.left, outer.bottom - outer.top],
            'clientPixels': [client.right - client.left, client.bottom - client.top], 'dpi': dpi,
            'outerDIP': [(outer.right - outer.left) * 96 / dpi, (outer.bottom - outer.top) * 96 / dpi]}


def resize_owned_window(pid, width, height):
    """Actual outer-window pixels, verified with GetWindowRect; never emulate a DOM viewport."""
    user32, hwnd = native_window(pid)
    user32.ShowWindow(hwnd, 9)  # Restore only this owned window if maximized/minimized.
    assert user32.SetWindowPos(hwnd, None, 0, 0, width, height, 0x0004 | 0x0010), ctypes.get_last_error()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        actual = measure_window(user32, hwnd)
        if actual['outerPixels'] == [width, height]:
            assert 0 < actual['clientPixels'][0] <= width and 0 < actual['clientPixels'][1] <= height
            return user32, hwnd, actual
        time.sleep(0.05)
    raise AssertionError(f'Native size did not reach {width}x{height}: {actual}')


def wait_for_state(page, function, arg=None, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.evaluate(function, arg):
            return
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for the real page state')


def check_readability(page):
    result = page.evaluate('''() => {
      const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const metadata = '.meta, small, .field-note, .eyebrow, .status-badge, .ace-status, .thumbnail-message, .asset-details > summary, .dialog-header p, .key-values dt';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), failures = [];
      let body = 0, meta = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!node.textContent.trim() || !el || ['SCRIPT','STYLE','OPTION'].includes(el.tagName) || !visible(el)) continue;
        const auxiliary = Boolean(el.closest(metadata)), size = parseFloat(getComputedStyle(el).fontSize);
        if (auxiliary) meta++; else body++;
        if (size < (auxiliary ? 14 : 16)) failures.push({text:node.textContent.trim().slice(0,70),size,required:auxiliary?14:16});
      }
      const controls = [...document.querySelectorAll('button,input:not([type=checkbox]),textarea,select')].filter(visible);
      for (const el of controls) {
        if (parseFloat(getComputedStyle(el).fontSize) !== 16) failures.push({control:el.getAttribute('data-testid')||el.tagName,size:getComputedStyle(el).fontSize});
        if (el.getBoundingClientRect().height < 43) failures.push({control:el.getAttribute('data-testid')||el.tagName,height:el.getBoundingClientRect().height,required:44});
      }
      for (const el of document.querySelectorAll('h1,h2')) if (visible(el) && parseFloat(getComputedStyle(el).fontSize) !== (el.tagName === 'H1' ? 24 : 20)) failures.push({heading:el.textContent,size:getComputedStyle(el).fontSize});
      const overflow = [...document.querySelectorAll('.page-scroll,.project-list,.dialog,.dialog-body,.selector-columns,.candidate-list,.ordered-list,.entry-list,.asset-list,.api-list,.plan-groups')]
        .filter(visible).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => ({element:el.className,width:el.clientWidth,scroll:el.scrollWidth}));
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) overflow.push({element:'document',width:innerWidth,scroll:document.documentElement.scrollWidth});
      return {failures,overflow,bodyTexts:body,metadataTexts:meta,bodyFont:getComputedStyle(document.body).fontSize,
        sidebar:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,main:getComputedStyle(document.documentElement).backgroundColor};
    }''')
    assert result['bodyFont'] == '16px'
    assert result['bodyTexts'] > 0 and result['metadataTexts'] > 0
    assert not result['failures'], result['failures']
    assert not result['overflow'], result['overflow']
    assert result['sidebar'] == 'rgb(245, 246, 248)'
    assert result['main'] == 'rgb(255, 255, 255)'
    return result


def check_focus_escape(page, dialog, trigger, expect):
    expect(dialog).to_be_visible()
    assert page.locator('#root').evaluate('(el) => el.inert')
    focusable = dialog.locator('button:visible:enabled, input:visible:enabled, select:visible:enabled, textarea:visible:enabled, summary:visible')
    first, last = focusable.first, focusable.last
    last.focus(); page.keyboard.press('Tab'); expect(first).to_be_focused()
    assert first.evaluate('(el) => parseFloat(getComputedStyle(el).outlineWidth) >= 2'), 'Keyboard focus must have a visible outline'
    first.focus(); page.keyboard.press('Shift+Tab'); expect(last).to_be_focused()
    page.keyboard.press('Escape'); expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    assert not page.locator('#root').evaluate('(el) => el.inert')


def check_scroll(page, selector):
    element = page.locator(selector)
    assert element.evaluate('(el) => el.scrollHeight > el.clientHeight + 8'), f'Expected a natural scroll region: {selector}'
    element.evaluate('(el) => el.scrollTop = 0')
    element.hover(); page.mouse.wheel(0, 700)
    wait_for_state(page, '(selector) => document.querySelector(selector).scrollTop > 0', selector)
    amount = element.evaluate('(el) => el.scrollTop')
    element.evaluate('(el) => el.scrollTop = 0')
    return {'selector': selector, 'wheelScrollTop': amount}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, default=Path('dist/win-unpacked/油管视频生成.exe'), help='Actual V4 unpacked EXE (not development electron.exe or the NSIS wrapper)')
    parser.add_argument('--output', type=Path, default=Path('docs/screenshots'), help='Screenshot directory; filenames are v4-* with a unique run suffix, never overwrite history')
    parser.add_argument('--report', type=Path, help='Report parent inside PI_SCRATCH_DIR')
    parser.add_argument('--keep', action='store_true', help='Keep the synthetic fixture on success; failures always retain it')
    args = parser.parse_args()
    if os.name != 'nt' or not os.environ.get('PI_SCRATCH_DIR'):
        raise RuntimeError('Windows and PI_SCRATCH_DIR are required for real, isolated native-window checks')
    from playwright.sync_api import sync_playwright, expect
    workspace = Path(__file__).resolve().parents[1]
    common = runpy.run_path(str(workspace / 'scripts' / 'portable-smoke.py'))
    scratch = Path(os.environ['PI_SCRATCH_DIR']).resolve()
    executable = (workspace / args.exe).resolve()
    assert executable.is_file(), f'Package V4 separately before visual inspection: {executable}'
    product_version = common['executable_version'](executable)
    screenshots = (workspace / args.output).resolve()
    assert screenshots == (workspace / 'docs' / 'screenshots').resolve() or screenshots.is_relative_to(scratch), 'Screenshots may go only to docs/screenshots or scratch'
    screenshots.mkdir(parents=True, exist_ok=True)
    parent = common['scratch_child'](args.report, scratch) if args.report else scratch / 'v4-visual-reports'
    parent.mkdir(parents=True, exist_ok=True)
    report_dir = Path(tempfile.mkdtemp(prefix='run-', dir=parent))
    root = Path(tempfile.mkdtemp(prefix='v4-visual-profile-', dir=scratch))
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
    proc, browser, page, passed, stage = None, None, None, False, 'seed synthetic profile'
    errors, evidence, scrolls, windows = [], [], [], []
    try:
        helper = workspace / 'scripts' / 'v4-package-fixtures.mjs'
        subprocess.run(['node', str(helper), '--help'], cwd=workspace, capture_output=True, text=True, encoding='utf-8', check=True)
        seed = subprocess.run(['node', str(helper), '--mode', 'visual', '--root', str(root)], cwd=workspace, capture_output=True, text=True, encoding='utf-8', timeout=300, check=True)
        manifest = json.loads(seed.stdout.strip().splitlines()[-1])
        profile = common['scratch_child'](manifest['profile'], scratch)
        assert manifest['synthetic'] and profile.is_relative_to(root)
        endpoint = f'http://127.0.0.1:{common["free_port"]()}'
        env = common['clean_env'](root)
        with (report_dir / 'electron.log').open('w', encoding='utf-8') as log:
            proc = subprocess.Popen([str(executable), f'--user-data-dir={profile}', f'--remote-debugging-port={endpoint.rsplit(":", 1)[1]}', '--remote-debugging-address=127.0.0.1'], env=env, stdout=log, stderr=log)
            common['wait_for_cdp'](endpoint, proc)
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(endpoint)
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.wait_for_event('page')
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.wait_for_load_state('domcontentloaded')
                expect(page.get_by_test_id('nav-generation')).to_be_enabled(timeout=120000)
                initial = common['bootstrap'](page)
                assert page.title() == '油管视频生成' and initial['testMode'] is False and initial['settings']['version'] == 5
                assert not initial['apis'] and len(initial['assets']) == manifest['assets']
                assert Path(initial['settings']['mediaRoot']).resolve().is_relative_to(root)
                assert page.get_by_role('navigation', name='主导航').get_by_role('button').count() == 4
                assert not page.locator('[data-testid="nav-history"], [data-testid="nav-batch"], [data-testid="video-export"]').count()
                page.get_by_test_id('nav-settings').click()
                expect(page.get_by_role('heading', name='尚未添加 API', exact=True)).to_be_visible()
                user32, hwnd, measured = resize_owned_window(proc.pid, 1366, 768)
                page.wait_for_timeout(250)

                def capture(label, resolution):
                    readability = check_readability(page)
                    actual = measure_window(user32, hwnd)
                    assert actual['outerPixels'] == list(resolution), actual
                    viewport = page.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,outerWidth,outerHeight})')
                    assert abs(viewport['width'] * viewport['dpr'] - actual['clientPixels'][0]) <= 3, (actual, viewport)
                    assert abs(viewport['height'] * viewport['dpr'] - actual['clientPixels'][1]) <= 3, (actual, viewport)
                    file = screenshots / f'v4-{label}-{resolution[0]}x{resolution[1]}-{run_id}.png'
                    assert not file.exists(), f'Refusing to overwrite screenshot: {file}'
                    page.screenshot(path=str(file), full_page=False)
                    evidence.append({'state': label, 'file': str(file), 'native': actual, 'contentViewport': viewport, 'readability': readability})

                capture('settings-empty-apis', (1366, 768))
                # Adding synthetic credentials exercises the real API editor and real safeStorage. Never click Test or submit a cloud request.
                for provider in ['mureka', 'kie', 'reapi', 'sunor', 'siliconflow', 'acestep']:
                    page.get_by_test_id('api-add').click()
                    dialog = page.get_by_role('dialog', name='添加 API', exact=True)
                    dialog.get_by_test_id('api-provider').select_option(provider)
                    if provider == 'acestep':
                        # A test-only closed loopback port, NOT the user's ACE service at 8001. No connection is attempted.
                        dialog.get_by_test_id('api-local-url').fill(f'http://127.0.0.1:{common["free_port"]()}')
                    else:
                        dialog.get_by_test_id('api-key').fill(f'fixture-{provider}-visual-never-sent')
                    dialog.get_by_test_id('api-save').click(); expect(dialog).not_to_be_visible()
                data = common['bootstrap'](page)
                assert len(data['apis']) == 6 and len({api['provider'] for api in data['apis']}) == 6
                assert next(api for api in data['apis'] if api['provider'] == 'acestep')['hasKey'] is False
                assert next(api for api in data['apis'] if api['provider'] == 'acestep')['local']['baseUrl'] != 'http://127.0.0.1:8001'
                assert all(api['hasKey'] for api in data['apis'] if api['provider'] != 'acestep')
                expect(page.get_by_test_id('api-add')).to_be_disabled()
                for resolution in [(1366, 768), (1920, 1080)]:
                    stage = f'visual window {resolution[0]}x{resolution[1]}'
                    user32, hwnd, measured = resize_owned_window(proc.pid, *resolution)
                    page.wait_for_timeout(250)
                    windows.append(measured)
                    page.get_by_test_id('nav-library').click(); page.get_by_test_id('library-tab-audio').click()
                    expect(page.locator('.asset-list > article')).to_have_count(20)
                    scrolls.append(check_scroll(page, '.page-scroll'))
                    page.get_by_test_id('library-select-all').click()
                    capture('library-music', resolution)
                    page.get_by_role('button', name='下一页', exact=True).click()
                    expect(page.locator('.asset-list > article')).to_have_count(4)
                    assert page.locator('.asset-main input:checked').count() == 4
                    page.get_by_test_id('library-tab-image').click()
                    expect(page.locator('.asset-list > article')).to_have_count(3)
                    wait_for_state(page, "() => [...document.querySelectorAll('.library-thumbnail img')].every(i => i.complete && i.naturalWidth > 0)")
                    capture('library-images', resolution)
                    image_id = manifest['imageIds'][0]
                    trigger = page.get_by_test_id(f'asset-preview-{image_id}'); trigger.click()
                    dialog = page.get_by_role('dialog', name='查看图片', exact=True)
                    wait_for_state(page, "() => document.querySelector('.library-full-image')?.naturalWidth > 0")
                    capture('image-preview', resolution); check_focus_escape(page, dialog, trigger, expect)
                    page.get_by_test_id('library-tab-video').click()
                    expect(page.get_by_role('heading', name='暂无视频', exact=True)).to_be_visible()
                    capture('library-video-empty', resolution)

                    page.get_by_test_id('nav-composition').click()
                    page.get_by_test_id(f'composition-project-{manifest["compositionId"]}').click()
                    assert common['bootstrap'](page)['compositionProjects'][0]['draft']['audioIds'] == manifest['audioIds'], 'Library selection must not control composition'
                    trigger = page.get_by_test_id('composition-select-audio'); trigger.click()
                    dialog = page.get_by_role('dialog', name='选择音乐', exact=True)
                    expect(dialog.locator('.candidate-row')).to_have_count(20)
                    dialog.get_by_role('button', name='试听', exact=True).first.click()
                    wait_for_state(page, "() => document.querySelector('.selector-preview audio')?.readyState > 0")
                    dialog.locator('audio').evaluate('async media => {media.volume=0;await media.play();media.pause()}')
                    scrolls.append(check_scroll(page, '.dialog-body'))
                    capture('composition-audio-selector', resolution); check_focus_escape(page, dialog, trigger, expect)
                    trigger = page.get_by_test_id('composition-select-image'); trigger.click()
                    dialog = page.get_by_role('dialog', name='选择图片', exact=True)
                    expect(dialog.locator('.candidate-row')).to_have_count(3)
                    capture('composition-image-selector', resolution); check_focus_escape(page, dialog, trigger, expect)
                    page.get_by_test_id('composition-plan-button').click()
                    expect(page.get_by_test_id('composition-start')).to_be_enabled(timeout=120000)
                    page.get_by_test_id('composition-plan').scroll_into_view_if_needed()
                    capture('composition-plan', resolution)
                    trigger = page.get_by_test_id('composition-start'); trigger.click()
                    dialog = page.get_by_role('dialog', name='确认开始本批合成', exact=True)
                    capture('composition-confirmation-not-submitted', resolution); check_focus_escape(page, dialog, trigger, expect)
                    page.get_by_test_id('composition-minimum-minutes').fill('2')
                    expect(page.get_by_test_id('composition-start')).to_have_count(0)
                    page.get_by_test_id('composition-minimum-minutes').fill('1')
                    page.locator('.execution-section').scroll_into_view_if_needed()
                    capture('composition-empty-executions', resolution)

                    page.get_by_test_id('nav-generation').click()
                    page.get_by_test_id(f'generation-project-{manifest["generationId"]}').click()
                    page.get_by_test_id('generation-tab-audio').click()
                    expect(page.locator('.entry-list > article')).to_have_count(20)
                    scrolls.append(check_scroll(page, '.project-list')); scrolls.append(check_scroll(page, '.page-scroll'))
                    capture('generation-compact-list', resolution)
                    page.get_by_role('button', name='下一页', exact=True).click()
                    expect(page.locator('.entry-list > article')).to_have_count(6)
                    page.get_by_role('button', name='上一页', exact=True).click()
                    failed = page.get_by_test_id(f'entry-{manifest["failedEntryId"]}')
                    page.get_by_test_id(f'entry-expand-{manifest["failedEntryId"]}').click()
                    banner = failed.locator('.banner-error .banner-content')
                    expect(banner).to_have_text(manifest['longError'])
                    banner.scroll_into_view_if_needed(); capture('long-stored-error', resolution)
                    page.get_by_test_id(f'entry-expand-{manifest["failedEntryId"]}').click()
                    entry = page.get_by_test_id(f'entry-{manifest["entryId"]}')
                    page.get_by_test_id(f'entry-expand-{manifest["entryId"]}').click()
                    entry.get_by_role('checkbox').check()
                    for provider in ['mureka', 'kie', 'reapi', 'sunor', 'acestep']:
                        entry.get_by_test_id('entry-provider').select_option(provider)
                        entry.get_by_test_id('entry-prompt').fill('温暖的吉他与钢琴，人工验收草稿；不提交云服务或推理。')
                        if provider == 'kie':
                            entry.get_by_test_id('entry-lyrics').fill('[Verse]\n人工测试歌词\n不调用云服务')
                        if provider == 'acestep':
                            entry.get_by_test_id('entry-mode').select_option('instrumental')
                            entry.get_by_test_id('entry-input-mode').select_option('lyrics')
                        entry.get_by_test_id('entry-prompt').scroll_into_view_if_needed()
                        capture(f'generation-{provider}-entry', resolution)
                    trigger = page.get_by_test_id('generate-selected'); trigger.click()
                    dialog = page.get_by_role('dialog', name='确认本批生成请求', exact=True)
                    expect(dialog.get_by_test_id('confirm-action')).to_be_disabled()
                    capture('local-generation-confirmation-not-submitted', resolution); check_focus_escape(page, dialog, trigger, expect)
                    entry.get_by_test_id('entry-provider').select_option('mureka')
                    long_prompt = '长文本验收·人工草稿不会生成；' * 180
                    entry.get_by_test_id('entry-prompt').fill(long_prompt)
                    expect(entry.get_by_test_id('entry-prompt')).to_have_attribute('aria-invalid', 'true')
                    page.get_by_test_id('generate-selected').click()
                    expect(page.locator('[data-testid="generation-workspace"] > .banner-error')).to_be_visible()
                    entry.get_by_test_id('entry-prompt').scroll_into_view_if_needed(); capture('long-draft-validation-error', resolution)
                    assert entry.get_by_test_id('entry-prompt').input_value() == long_prompt
                    entry.get_by_test_id('entry-prompt').fill('验收草稿，保持完整文本，不生成。')
                    page.get_by_test_id('generation-tab-image').click()
                    page.get_by_test_id('entry-add').click()
                    expect(page.get_by_test_id('entry-prompt')).to_be_visible()
                    page.get_by_test_id('entry-prompt').fill('横向画面·人工图片草稿，不提交生图。')
                    page.locator('.entry-editor details > summary').click()
                    expect(page.get_by_label('画面尺寸')).to_have_value('1664x928')
                    capture('generation-image-entry', resolution)

                    page.get_by_test_id('nav-settings').click()
                    capture('settings-added-apis', resolution)
                    trigger = page.get_by_test_id('api-edit-acestep'); trigger.click()
                    dialog = page.get_by_role('dialog', name='编辑 ACE-Step 本地', exact=True)
                    expect(dialog.get_by_test_id('api-key')).to_have_value('')
                    dialog.get_by_test_id('api-local-url').scroll_into_view_if_needed()
                    capture('settings-local-editor', resolution); check_focus_escape(page, dialog, trigger, expect)
                    page.get_by_test_id('settings-tab-render').click()
                    expect(page.get_by_test_id('render-concurrency')).to_have_value('2')
                    capture('settings-render-resources', resolution)
                    page.get_by_test_id('settings-tab-storage').click(); capture('settings-storage', resolution)
                    assert len(common['bootstrap'](page)['requests']) == manifest['generationRequests']
                    assert not common['bootstrap'](page)['batches'], 'Visual inspection must never render or submit confirmation dialogs'
                    assert not errors, errors
                final = common['bootstrap'](page)
                assert len(final['requests']) == len(initial['requests']) and not final['batches']
                assert not (root / 'dev-flags-must-not-be-used').exists()
                (report_dir / 'report.json').write_text(json.dumps({'passed': True, 'version': '4.0.1', 'productVersion': product_version, 'executable': str(executable), 'fixture': str(root),
                    'windowUnit': 'native outer pixels', 'measuredWindows': windows, 'screenshots': evidence, 'scrollChecks': scrolls, 'pageErrors': errors,
                    'testMode': False, 'newGenerationRequests': 0, 'newExecutionBatches': 0, 'paidCalls': 0, 'actualInference': False}, ensure_ascii=False, indent=2), encoding='utf-8')
                page.close(); page = None
                browser.close(); browser = None
            proc.wait(timeout=30); assert proc.returncode == 0
        passed = True
        print(f'PASS: V4 native 1366x768/1920x1080 windows, 16px body/controls, >=14px metadata, no overflow, real media/selectors/scroll/focus/Escape/long errors. Report: {report_dir / "report.json"}')
    except Exception as error:
        if page:
            try:
                page.screenshot(path=str(report_dir / 'v4-visual-failure.png'))
            except Exception:
                pass
        (report_dir / 'report.json').write_text(json.dumps({'passed': False, 'stage': stage, 'fixture': str(root), 'error': str(error), 'screenshots': evidence, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'FAIL: {stage}; isolated fixture retained: {root}')
        raise
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass  # Preserve the original failure if Playwright already stopped.
        if proc and proc.poll() is None:
            subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True, check=False)
            proc.wait(timeout=20)
        if passed and not args.keep:
            shutil.rmtree(root)


if __name__ == '__main__':
    main()
