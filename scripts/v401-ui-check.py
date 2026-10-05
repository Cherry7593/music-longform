"""Targeted V4.0.1 Electron UI checks on an existing synthetic fixture; no paid calls or video rendering."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright, expect
import importlib.util

helper_spec = importlib.util.spec_from_file_location('portable_helpers', Path(__file__).with_name('portable-smoke.py'))
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
free_port, wait_for_cdp, endpoint_closed = helper.free_port, helper.wait_for_cdp, helper.endpoint_closed


def wait(check, timeout=20):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError('Condition did not become true')


def state(page):
    return page.evaluate('async () => JSON.parse(JSON.stringify(await window.canvas.bootstrap()))')


def comp(page, project_id):
    return next(p for p in state(page)['compositionProjects'] if p['id'] == project_id)


def selected_names(dialog):
    return [text.split('. ', 1)[1] for text in dialog.locator('.ordered-list > li > span').all_text_contents()]


def open_selector(page, kind):
    page.get_by_test_id(f'composition-select-{kind}').click()
    dialog = page.get_by_role('dialog', name='选择音乐' if kind == 'audio' else '选择图片', exact=True)
    expect(dialog).to_be_visible()
    return dialog


def full_checks(page, fixture, output, report):
    groups, projects, composition = fixture['groups'], fixture['projects'], fixture['composition']
    baseline = state(page)
    assert baseline['testMode'] is False
    before_a, before_b = comp(page, composition['a'])['draft'], comp(page, composition['b'])['draft']
    # Rename through real IPC; filter remains keyed by the original project ID.
    page.evaluate('arg => window.canvas.updateGenerationProject(arg.id, {name:arg.name})', {'id': projects['a'], 'name': '改名后的生成A'})
    wait(lambda: any(p['name'] == '改名后的生成A' for p in state(page)['generationProjects']))
    dialog = open_selector(page, 'audio')
    assert dialog.get_by_placeholder('搜索素材名称').count() == 0
    options = dialog.get_by_test_id('selector-source').locator('option')
    labels = options.all_text_contents()
    assert any('改名后的生成A' in text for text in labels)
    assert any(projects['b'] in text and '同名生成项目' in text for text in labels)
    assert any(projects['deleted'] in text and '已删除' in text for text in labels)
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['a'])
    expect(dialog.get_by_role('heading', name='可选素材 · 25', exact=True)).to_be_visible()
    first = dialog.locator('.candidate-name > strong').all_text_contents()
    assert len(first) == 20
    dialog.get_by_role('button', name='下一页', exact=True).click()
    candidate_names = first + dialog.locator('.candidate-name > strong').all_text_contents()
    initial_names = selected_names(dialog)
    dialog.get_by_test_id('selector-select-all').click()
    expected = initial_names + [name for name in candidate_names if name not in initial_names]
    assert selected_names(dialog) == expected and len(expected) == 26
    dialog.get_by_test_id('selector-select-all').click()
    assert selected_names(dialog) == expected
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['b'])
    assert len(dialog.locator('.candidate-row').all()) == 4  # shared asset plus three B-only assets
    assert selected_names(dialog) == expected
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['a'])
    dialog.get_by_label('按使用状态筛选').select_option('used')
    assert len(dialog.locator('.candidate-row').all()) == 1
    dialog.get_by_test_id('selector-deselect-all').click()
    assert len(selected_names(dialog)) == 25
    dialog.get_by_label('按使用状态筛选').select_option('all')
    dialog.get_by_test_id('selector-select-all').click()
    assert len(selected_names(dialog)) == 26
    # A selected item becomes unavailable while this dialog is open.
    missing = Path(fixture['missing']['audio']['file']).resolve()
    assert missing.is_relative_to(Path(fixture['root']).resolve())
    hidden = missing.with_suffix('.fixture-hidden')
    missing.rename(hidden)
    page.evaluate('() => window.canvas.refreshAssets()')
    wait(lambda: not next(a for a in state(page)['assets'] if a['id'] == fixture['missing']['audio']['id'])['available'])
    dialog.get_by_test_id('selector-deselect-all').click()
    assert selected_names(dialog) == [initial_names[0]]
    dialog.get_by_test_id('selector-select-all').click()
    assert len(selected_names(dialog)) == 25
    assert 'a-audio-25' not in selected_names(dialog)
    # Source filters do not make local/historical/deleted-project materials disappear.
    for source, expected_count in [('import', 1), ('unassigned', 1), ('project:' + projects['deleted'], 1)]:
        dialog.get_by_test_id('selector-source').select_option(source)
        assert dialog.locator('.candidate-row').count() == expected_count
        assert len(selected_names(dialog)) == 25
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['a'])
    dialog.locator('.ordered-list').get_by_role('button', name='替换', exact=True).first.click()
    expect(dialog.get_by_test_id('selector-select-all')).to_be_disabled()
    expect(dialog.get_by_test_id('selector-deselect-all')).to_be_disabled()
    expect(dialog.get_by_test_id('selector-clear-all')).to_be_disabled()
    dialog.get_by_role('button', name='取消替换', exact=True).click()
    page.screenshot(path=str(output / 'selection.png'))
    dialog.get_by_role('button', name='取消', exact=True).click()
    assert comp(page, composition['a'])['draft'] == before_a
    assert comp(page, composition['b'])['draft'] == before_b
    hidden.rename(missing)
    page.evaluate('() => window.canvas.refreshAssets()')
    wait(lambda: next(a for a in state(page)['assets'] if a['id'] == fixture['missing']['audio']['id'])['available'])
    report['checks'].append('source IDs/rename/same-name/deleted/multi-origin/legacy/import; cross-page stable unique selection, usage intersection, unavailable deselection, replacement isolation and Cancel unchanged')

    # Apply only audio to A, without changing image or B.
    dialog = open_selector(page, 'audio')
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['a'])
    dialog.get_by_test_id('selector-select-all').click()
    expected_audio = selected_names(dialog)
    dialog.get_by_test_id('selector-apply').click()
    wait(lambda: len(comp(page, composition['a'])['draft']['audioIds']) == 26)
    a = comp(page, composition['a'])['draft']
    names_by_id = {asset['id']: asset['name'] for asset in state(page)['assets']}
    assert [names_by_id[i] for i in a['audioIds']] == expected_audio
    assert a['imageIds'] == before_a['imageIds'] and comp(page, composition['b'])['draft'] == before_b
    dialog = open_selector(page, 'image')
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['a'])
    dialog.get_by_test_id('selector-select-all').click()
    assert len(selected_names(dialog)) == 26
    dialog.get_by_test_id('selector-deselect-all').click()
    assert len(selected_names(dialog)) == 1
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['overflow'])
    dialog.get_by_test_id('selector-select-all').click()
    expect(dialog.get_by_text('最多可选择 100 项', exact=False)).to_be_visible()
    assert len(selected_names(dialog)) == 1
    dialog.get_by_test_id('selector-clear-all').click()
    assert selected_names(dialog) == []
    dialog.get_by_test_id('selector-source').select_option('project:' + projects['a'])
    dialog.get_by_test_id('selector-select-all').click()
    dialog.get_by_test_id('selector-apply').click()
    wait(lambda: len(comp(page, composition['a'])['draft']['imageIds']) == 25)
    assert comp(page, composition['a'])['draft']['audioIds'] == a['audioIds']
    page.get_by_test_id('composition-project-' + composition['b']).click()
    assert comp(page, composition['b'])['draft'] == before_b
    report['checks'].append('Apply persists only current project/type; 25 images cross-page; 101-image overflow refuses atomically without truncation; clear is dialog-type-only')

    # Library selection spans pages, intersects search/type/usage and preserves other types.
    page.get_by_test_id('nav-library').click()
    library = page.get_by_test_id('library-workspace')
    library.get_by_test_id('library-search').fill('a-audio-')
    library.get_by_test_id('library-select-all').click()
    expect(library.get_by_text('当前筛选已选 25', exact=False)).to_be_visible()
    library.get_by_test_id('library-select-all').click()
    expect(library.get_by_text('累计已选 25 项', exact=False)).to_be_visible()
    library.get_by_role('button', name='下一页', exact=True).click()
    assert all(library.locator('.asset-main > input[type=checkbox]').evaluate_all('inputs => inputs.map(input => input.checked)'))
    library.get_by_test_id('library-tab-image').click()
    library.get_by_test_id('library-search').fill('a-image-')
    library.get_by_test_id('library-select-all').click()
    expect(library.get_by_text('累计已选 50 项', exact=False)).to_be_visible()
    library.get_by_label('按使用状态筛选').select_option('used')
    library.get_by_test_id('library-deselect-all').click()
    expect(library.get_by_text('累计已选 49 项', exact=False)).to_be_visible()
    library.get_by_label('按使用状态筛选').select_option('all')
    library.get_by_test_id('library-deselect-all').click()
    expect(library.get_by_text('累计已选 25 项', exact=False)).to_be_visible()
    library.get_by_test_id('library-tab-audio').click()
    library.get_by_test_id('library-search').fill('a-audio-')
    missing.rename(hidden)
    library.get_by_test_id('library-refresh').click()
    wait(lambda: not next(asset for asset in state(page)['assets'] if asset['id'] == fixture['missing']['audio']['id'])['available'])
    library.get_by_test_id('library-deselect-all').click()
    expect(library.get_by_text('累计已选 0 项', exact=False)).to_be_visible()
    hidden.rename(missing)
    library.get_by_test_id('library-refresh').click()
    wait(lambda: next(asset for asset in state(page)['assets'] if asset['id'] == fixture['missing']['audio']['id'])['available'])
    report['checks'].append('library keeps name search, selects all matching pages, intersects usage/type and deselects newly unavailable items without clearing other type')

    # Pending-only entry selection remains scoped per project and type across remounts.
    page.get_by_test_id('nav-generation').click()
    page.get_by_test_id('generation-project-' + projects['a']).click()
    page.get_by_test_id('generation-select-all').click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('25 / 25')
    page.get_by_test_id('generation-select-all').click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('25 / 25')
    pager = page.get_by_test_id('generation-workspace').locator(':scope > .pager')
    pager.get_by_role('button', name='下一页', exact=True).click()
    enabled = page.locator('.entry-summary > input:not(:disabled)')
    assert all(enabled.evaluate_all('inputs => inputs.map(input => input.checked)'))
    page.get_by_test_id('generation-tab-image').click()
    page.get_by_test_id('generation-select-all').click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('25 / 25')
    page.get_by_test_id('generation-deselect-all').click()
    page.get_by_test_id('generation-tab-audio').click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('25 / 25')
    page.get_by_test_id('generation-project-' + projects['b']).click()
    page.get_by_test_id('generation-select-all').click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('2 / 2')
    page.get_by_test_id('generation-project-' + projects['a']).click()
    page.get_by_test_id('generation-deselect-all').click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('0 / 25')
    page.get_by_test_id('generation-project-' + projects['b']).click()
    expect(page.get_by_test_id('generation-selected-count')).to_contain_text('2 / 2')
    assert page.locator('.entry-summary > input:disabled').count() == 1
    assert not page.locator('.entry-summary > input:disabled').is_checked()
    report['checks'].append('generation pending only, cross-page, no submitted entries, A/B and music/image selections isolated and repeated select-all unique')

    # Actual safeStorage and settings UI: both sites are independently added; no Test/Generate click.
    page.get_by_test_id('nav-settings').click()
    keys = {'mureka': 'synthetic-v401-international', 'mureka-cn': 'cn.x'}
    old_cipher = None
    secret_file = Path(fixture['profile']) / 'secrets.json'
    for site, key in keys.items():
        page.get_by_test_id('api-add').click()
        editor = page.get_by_role('dialog', name='添加 API', exact=True)
        editor.get_by_test_id('api-provider').select_option(site)
        expect(editor.get_by_text('https://api.mureka.cn' if site == 'mureka-cn' else 'https://api.mureka.ai', exact=False)).to_be_visible()
        editor.get_by_test_id('api-key').fill(key)
        editor.get_by_test_id('api-save').click()
        expect(editor).not_to_be_visible()
        data = json.loads(secret_file.read_text(encoding='utf-8'))
        assert data['version'] == 3
        if site == 'mureka':
            old_cipher = data['keys']['mureka']
        else:
            assert data['keys']['mureka'] == old_cipher
        assert key not in secret_file.read_text(encoding='utf-8')
    apis = state(page)['apis']
    assert {api['provider'] for api in apis} == set(keys) and all(api['hasKey'] for api in apis)
    page.get_by_test_id('api-add').click()
    editor = page.get_by_role('dialog', name='添加 API', exact=True)
    values = editor.get_by_test_id('api-provider').locator('option').evaluate_all('items => items.map(item => item.value)')
    assert 'mureka' not in values and 'mureka-cn' not in values
    editor.get_by_role('button', name='取消', exact=True).click()
    page.screenshot(path=str(output / 'sites.png'))
    page.get_by_test_id('nav-generation').click()
    page.get_by_test_id('entry-add').click()
    expect(page.get_by_test_id('entry-provider')).to_be_visible()
    page.get_by_test_id('entry-provider').select_option('mureka-cn')
    page.get_by_test_id('entry-prompt').fill('国内站保留描述，不提交')
    page.locator('.entry-editor details.advanced > summary').click()
    page.get_by_test_id('entry-model').select_option('mureka-9.5')
    page.get_by_test_id('entry-provider').select_option('mureka')
    page.get_by_test_id('entry-prompt').fill('国际站独立描述，不提交')
    page.get_by_test_id('entry-provider').select_option('mureka-cn')
    expect(page.get_by_test_id('entry-prompt')).to_have_value('国内站保留描述，不提交')
    expect(page.get_by_test_id('entry-model')).to_have_value('mureka-9.5')
    assert page.get_by_test_id('entry-lyrics').count() == 0
    page.get_by_test_id('nav-settings').click()  # flush genuine autosave
    expect(page.get_by_test_id('settings-workspace')).to_be_visible()
    wait(lambda: any(e['draft'].get('provider') == 'mureka-cn' and e['alternatives'].get('mureka', {}).get('prompt') == '国际站独立描述，不提交' for e in state(page)['entries']))
    final = state(page)
    assert len(final['requests']) == fixture['requests'] and not final['batches']
    assert any(e['draft'].get('provider') == 'mureka-cn' and e['alternatives'].get('mureka', {}).get('prompt') == '国际站独立描述，不提交' for e in final['entries'])
    report['checks'].append('two actual encrypted site configs coexist, menu uniqueness and endpoints, domestic short key, unchanged international ciphertext, independent entry models/drafts; no paid requests')
    report['expected'] = {'composition': {p['id']: p['draft'] for p in final['compositionProjects']}, 'requests': len(final['requests']), 'apis': sorted(api['provider'] for api in final['apis'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Fixture produced by v401-ui-fixture.mjs inside PI_SCRATCH_DIR')
    parser.add_argument('--exe', type=Path, help='Actual 4.0.1 portable EXE for smoke-only startup/restart verification')
    args = parser.parse_args()
    workspace, scratch, root = Path.cwd(), Path(os.environ['PI_SCRATCH_DIR']).resolve(), args.root.resolve()
    assert root.is_relative_to(scratch) and root != scratch
    fixture = json.loads((root / 'synthetic.json').read_text(encoding='utf-8'))
    assert fixture['synthetic'] and fixture['version'] == '4.0.1'
    output = root / ('portable-check' if args.exe else 'ui-check')
    output.mkdir(exist_ok=True)
    report = {'passed': False, 'version': '4.0.1', 'fixture': str(root), 'checks': [], 'pageErrors': [], 'newPaidRequests': 0, 'actualInference': False}
    if args.exe:
        expected = json.loads((root / 'ui-check' / 'report.json').read_text(encoding='utf-8'))
        assert expected['passed']
        report['expected'] = expected['expected']
    proc = None
    try:
        with sync_playwright() as playwright:
            for launch in range(2):
                port = free_port(); endpoint = f'http://127.0.0.1:{port}'
                executable = args.exe.resolve() if args.exe else workspace / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
                cmd = [str(executable)] + ([] if args.exe else ['.']) + [f'--user-data-dir={fixture["profile"]}', f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1']
                env = dict(os.environ)
                for name in ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSIC_CANVAS_E2E', 'MUSIC_CANVAS_TEST_DIR']:
                    env.pop(name, None)
                with (output / f'launch-{launch}.log').open('w', encoding='utf-8') as log:
                    proc = subprocess.Popen(cmd, cwd=workspace, env=env, stdout=log, stderr=log)
                    wait_for_cdp(endpoint, proc)
                    browser = playwright.chromium.connect_over_cdp(endpoint)
                    context = browser.contexts[0]
                    page = context.pages[0] if context.pages else context.wait_for_event('page', timeout=30000)
                    page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
                    page.wait_for_load_state('domcontentloaded')
                    expect(page.get_by_test_id('nav-generation')).to_be_enabled(timeout=30000)
                    assert state(page)['testMode'] is False
                    if not args.exe and launch == 0:
                        full_checks(page, fixture, output, report)
                    expected = report['expected']; data = state(page)
                    assert sorted(api['provider'] for api in data['apis']) == expected['apis']
                    assert all(api['hasKey'] for api in data['apis'])
                    assert len(data['requests']) == expected['requests'] and not data['batches']
                    assert {p['id']: p['draft'] for p in data['compositionProjects']} == expected['composition']
                    report['checks'].append(f'{"portable" if args.exe else "development"} real launch {launch+1}: site configs and current project selections retained, no generation/render')
                    page.close(); browser.close()
                    proc.wait(timeout=45)
                    assert proc.returncode == 0 and endpoint_closed(endpoint)
                    proc = None
        assert not report['pageErrors']
        report['passed'] = True
    finally:
        if proc and proc.poll() is None:
            subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True, check=False)
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']), 'report': str(output / 'report.json')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
