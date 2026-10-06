"""Launch the actual V4.0.4 NSIS portable EXE twice; isolated current profiles, no AI calls."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request


def scratch_child(path, scratch):
    target = Path(path).resolve()
    assert target != scratch and target.is_relative_to(scratch), f'Only children of PI_SCRATCH_DIR are allowed: {target}'
    return target


def executable_version(executable):
    """Read the selected EXE's PE product version, not package.json or an old screenshot."""
    version = ctypes.WinDLL('version', use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    version.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    version.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    ignored = wintypes.DWORD()
    size = version.GetFileVersionInfoSizeW(str(executable), ctypes.byref(ignored))
    assert size, f'No PE version resource: {executable}'
    data = ctypes.create_string_buffer(size)
    assert version.GetFileVersionInfoW(str(executable), 0, size, data)
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    assert version.VerQueryValueW(data, '\\', ctypes.byref(pointer), ctypes.byref(length))
    fields = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))
    assert fields[0] == 0xFEEF04BD
    result = [fields[4] >> 16, fields[4] & 0xFFFF, fields[5] >> 16, fields[5] & 0xFFFF]
    assert result == [4, 0, 4, 0], f'Expected V4.0.4 executable, got {result}'
    return result


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for_cdp(endpoint, proc, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(endpoint + '/json/version', timeout=1) as response:
                return json.load(response)
        except OSError:
            # NSIS may hand off to its owned child; a zero wrapper exit alone is not a startup verdict.
            if proc.poll() not in (None, 0):
                raise RuntimeError(f'Portable launcher exited: {proc.returncode}')
            time.sleep(0.25)
    raise RuntimeError('The isolated portable launcher did not expose a CDP window')


def endpoint_closed(endpoint, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(endpoint + '/json/version', timeout=0.5):
                pass
        except OSError:
            return True
        time.sleep(0.2)
    return False


def clean_env(root):
    env = dict(os.environ, MUSIC_CANVAS_E2E='1', MUSIC_CANVAS_TEST_DIR=str(root / 'dev-flags-must-not-be-used'), TEMP=str(root / 'launcher-temp'), TMP=str(root / 'launcher-temp'))
    Path(env['TEMP']).mkdir(exist_ok=True)
    for name in ('ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'):
        env.pop(name, None)
    return env


def bootstrap(page):
    return page.evaluate('window.canvas.bootstrap()')


def rename_current(page, name, expect):
    page.get_by_test_id('project-rename').click()
    dialog = page.get_by_role('dialog', name='重命名项目', exact=True)
    expect(dialog).to_be_visible()
    dialog.get_by_test_id('rename-input').fill(name)
    dialog.get_by_test_id('rename-save').click()
    expect(dialog).not_to_be_visible()
    expect(page.get_by_test_id('project-name')).to_have_text(name)


def create_drafts(page, expect):
    generation = []
    for suffix in ('A', 'B'):
        page.get_by_test_id('nav-generation').click()
        before = {p['id'] for p in bootstrap(page)['generationProjects']}
        page.get_by_test_id('generation-create').click()
        page.wait_for_function('async ids => (await window.canvas.bootstrap()).generationProjects.some(p => !ids.includes(p.id))', arg=list(before))
        project = next(p for p in bootstrap(page)['generationProjects'] if p['id'] not in before)
        expect(page.get_by_test_id(f'generation-project-{project["id"]}')).to_have_attribute('aria-current', 'true')
        rename_current(page, f'便携独立生成{suffix}', expect)
        page.get_by_test_id('entry-add').click()
        expect(page.get_by_test_id('entry-prompt')).to_be_visible()
        prompt = f'便携重启草稿 {suffix}：没有 API 也能保存；不生成、不付费。'
        page.get_by_test_id('entry-prompt').fill(prompt)
        entry = next(e for e in bootstrap(page)['entries'] if e['projectId'] == project['id'])
        generation.append({'id': project['id'], 'entryId': entry['id'], 'name': f'便携独立生成{suffix}', 'prompt': prompt})
    composition = []
    for index, suffix in enumerate(('A', 'B')):
        page.get_by_test_id('nav-composition').click()
        before = {p['id'] for p in bootstrap(page)['compositionProjects']}
        page.get_by_test_id('composition-create').click()
        page.wait_for_function('async ids => (await window.canvas.bootstrap()).compositionProjects.some(p => !ids.includes(p.id))', arg=list(before))
        project = next(p for p in bootstrap(page)['compositionProjects'] if p['id'] not in before)
        expect(page.get_by_test_id(f'composition-project-{project["id"]}')).to_have_attribute('aria-current', 'true')
        rename_current(page, f'便携独立合成{suffix}', expect)
        page.get_by_test_id('composition-minimum-minutes').fill(str(index + 1))
        composition.append({'id': project['id'], 'name': f'便携独立合成{suffix}', 'minimumSeconds': (index + 1) * 60})
    page.get_by_test_id('nav-settings').click()  # Navigation flushes the actual renderer autosave queue.
    expect(page.get_by_role('heading', name='尚未添加 API', exact=True)).to_be_visible()
    expected = {'generation': generation, 'composition': composition}
    page.wait_for_function('''async expected => {
      const data = await window.canvas.bootstrap();
      return expected.generation.every(item => data.entries.some(e => e.id === item.entryId && e.draft.prompt === item.prompt))
        && expected.composition.every(item => data.compositionProjects.some(p => p.id === item.id && p.draft.minimumSeconds === item.minimumSeconds));
    }''', arg=expected)
    return expected


def assert_drafts(page, expected, expect):
    data = bootstrap(page)
    assert data['settings']['version'] == 5 and data['testMode'] is False
    assert not data['apis'] and not data['requests'] and not data['batches'] and not data['assets']
    assert len(data['generationProjects']) == len(data['compositionProjects']) == 2
    for item in expected['generation']:
        project = next(p for p in data['generationProjects'] if p['id'] == item['id'])
        assert project['version'] == 1 and project['name'] == item['name']
        entry = next(e for e in data['entries'] if e['id'] == item['entryId'])
        assert entry['version'] == 1 and entry['draft']['prompt'] == item['prompt'] and 'count' not in entry['draft']
        assert not entry['draft'].get('provider') and not entry.get('requestId')
        page.get_by_test_id('nav-generation').click()
        page.get_by_test_id(f'generation-project-{item["id"]}').click()
        expand = page.get_by_test_id(f'entry-expand-{item["entryId"]}')
        if expand.get_attribute('aria-expanded') != 'true':
            expand.click()
        expect(page.get_by_test_id('entry-prompt')).to_have_value(item['prompt'])
        assert page.get_by_test_id('entry-provider').locator('option').count() == 1
    for item in expected['composition']:
        project = next(p for p in data['compositionProjects'] if p['id'] == item['id'])
        assert project['version'] == 1 and project['name'] == item['name']
        assert project['draft']['minimumSeconds'] == item['minimumSeconds']
        assert not project['draft']['audioIds'] and not project['draft']['imageIds'] and not project['batchIds']
        page.get_by_test_id('nav-composition').click()
        page.get_by_test_id(f'composition-project-{item["id"]}').click()
        expect(page.get_by_test_id('composition-minimum-minutes')).to_have_value(str(item['minimumSeconds'] // 60))
    page.get_by_test_id('nav-settings').click()
    expect(page.get_by_role('heading', name='尚未添加 API', exact=True)).to_be_visible()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, default=Path('dist/油管视频生成-4.0.4-Windows-x64.exe'))
    parser.add_argument('--output', type=Path, help='Report parent directory inside PI_SCRATCH_DIR; each run gets a new child')
    parser.add_argument('--keep', action='store_true', help='Keep the isolated profile even on success (failures always retain it)')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('This checks the actual Windows NSIS portable launcher')
    if not os.environ.get('PI_SCRATCH_DIR'):
        raise RuntimeError('PI_SCRATCH_DIR is required; no user profile or default media root is permitted')
    from playwright.sync_api import sync_playwright, expect
    workspace = Path(__file__).resolve().parents[1]
    scratch = Path(os.environ['PI_SCRATCH_DIR']).resolve()
    executable = (workspace / args.exe).resolve()
    assert executable.is_file(), f'Build/package V4 separately before this smoke: {executable}'
    product_version = executable_version(executable)
    output_parent = scratch_child(args.output, scratch) if args.output else scratch / 'v4-portable-reports'
    output_parent.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='run-', dir=output_parent))
    root = Path(tempfile.mkdtemp(prefix='v4-portable-profile-', dir=scratch))
    proc, browser, passed, expected, stage = None, None, False, None, 'seed current profile'
    try:
        helper = workspace / 'scripts' / 'v4-package-fixtures.mjs'
        subprocess.run(['node', str(helper), '--help'], cwd=workspace, check=True, capture_output=True, text=True, encoding='utf-8')
        seed = subprocess.run(['node', str(helper), '--mode', 'empty', '--root', str(root)], cwd=workspace, check=True, capture_output=True, text=True, encoding='utf-8', timeout=120)
        manifest = json.loads(seed.stdout.strip().splitlines()[-1])
        assert manifest['synthetic'] and manifest['version'] == '4.0.4'
        profile = scratch_child(manifest['profile'], scratch)
        assert profile.is_relative_to(root)
        env = clean_env(root)
        for attempt in range(2):
            stage = f'portable launch {attempt + 1}'
            # Only this owned synthetic profile: exercise both historical switch values on real startup.
            for settings_file in (profile / 'settings.json', profile / 'workbench' / 'settings' / 'current.json'):
                legacy = json.loads(settings_file.read_text(encoding='utf-8'))
                assert legacy['version'] == 5
                legacy['render']['staticVideo'] = attempt == 0
                settings_file.write_text(json.dumps(legacy, ensure_ascii=False), encoding='utf-8')
            endpoint = f'http://127.0.0.1:{free_port()}'
            with (output / f'launcher-{attempt + 1}.log').open('w', encoding='utf-8') as log:
                proc = subprocess.Popen([str(executable), f'--user-data-dir={profile}', f'--remote-debugging-port={endpoint.rsplit(":", 1)[1]}', '--remote-debugging-address=127.0.0.1'], env=env, stdout=log, stderr=log)
                wait_for_cdp(endpoint, proc)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(endpoint)
                    context = browser.contexts[0]
                    page = context.pages[0] if context.pages else context.wait_for_event('page')
                    page.wait_for_load_state('domcontentloaded')
                    expect(page.get_by_test_id('nav-generation')).to_be_enabled(timeout=60000)
                    assert page.title() == '油管视频生成'
                    data = bootstrap(page)
                    assert data['testMode'] is False and data['settings']['version'] == 5
                    assert 'staticVideo' not in data['settings']['render']
                    assert Path(data['settings']['mediaRoot']).resolve() == Path(manifest['mediaRoot']).resolve()
                    assert not data['apis'], 'A clean V4 installation must not pretend default APIs are added'
                    assert page.get_by_role('navigation', name='主导航').get_by_role('button').count() == 4
                    assert not page.locator('[data-testid="nav-history"], [data-testid="nav-batch"], [data-testid="video-export"]').count()
                    if attempt == 0:
                        assert not data['generationProjects'] and not data['compositionProjects'] and not data['entries']
                        expected = create_drafts(page, expect)
                    assert_drafts(page, expected, expect)
                    page.get_by_test_id('settings-tab-render').click()
                    expect(page.get_by_test_id('render-static-video')).to_have_count(0)
                    expect(page.get_by_text('静态画面缓存复用', exact=True)).to_have_count(0)
                    expect(page.get_by_text('静态图片连续编码完整画面', exact=False)).to_be_visible()
                    page.get_by_test_id('render-concurrency').fill('2')
                    page.get_by_test_id('render-threads').fill('2')
                    page.get_by_test_id('render-encoder').select_option('cpu')
                    page.get_by_test_id('render-save').click()
                    page.wait_for_function('async () => { const r = (await window.canvas.bootstrap()).settings.render; return r.concurrency === 2 && r.threads === 2 && r.encoder === "cpu" && !("staticVideo" in r) }')
                    page.screenshot(path=str(output / f'v4-portable-window-{attempt + 1}.png'))
                    assert not (root / 'dev-flags-must-not-be-used').exists()
                    page.close()  # All saves were flushed; this must be a clean app exit, not a forced kill.
                    browser.close(); browser = None
                proc.wait(timeout=45)
                assert proc.returncode == 0, proc.returncode
                assert endpoint_closed(endpoint), 'The first portable child must exit before the next launcher starts'
                proc = None
        disk = json.loads((profile / 'workbench' / 'settings' / 'current.json').read_text(encoding='utf-8'))
        assert disk['version'] == 5 and Path(disk['mediaRoot']).resolve().is_relative_to(root)
        assert disk['render'] == {'concurrency': 2, 'threads': 2, 'encoder': 'cpu'}
        report = {'passed': True, 'version': '4.0.4', 'productVersion': product_version, 'launches': 2, 'executable': str(executable), 'fixture': str(root), 'dualProjects': expected,
                  'emptyAddedApis': True, 'draftsRetained': True, 'legacyStaticTrueFalseIgnored': True, 'removedToggle': True, 'savedWithoutStaticField': True, 'testMode': False, 'generationRequests': 0, 'paidCalls': 0, 'actualInference': False}
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        passed = True
        print(f'PASS: actual V4 NSIS portable twice; independent A/B generation/composition drafts, empty APIs, clean restart. Report: {output / "report.json"}')
    except Exception as error:
        (output / 'report.json').write_text(json.dumps({'passed': False, 'stage': stage, 'fixture': str(root), 'error': str(error)}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'FAIL: {stage}; isolated fixture retained at {root}')
        raise
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass  # Playwright may already have closed its loop after a failed assertion.
        if proc and proc.poll() is None:
            subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True, check=False)
            proc.wait(timeout=20)
        if passed and not args.keep:
            shutil.rmtree(root)


if __name__ == '__main__':
    main()
