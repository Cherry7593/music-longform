"""Targeted native Python Playwright checks for prompt paste/import; attach only to an owned isolated app."""
import argparse
import json
import os
from pathlib import Path
import time
from playwright.sync_api import sync_playwright, expect


def wait(condition, timeout=20):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if condition():
            return
        time.sleep(0.1)
    raise AssertionError('Expected state was not observed')


def snapshot(page):
    return page.evaluate('async () => JSON.parse(JSON.stringify(await window.canvas.bootstrap()))')


def entries(page, project_id, kind):
    data = snapshot(page)
    project = next(p for p in data['generationProjects'] if p['id'] == project_id)
    by_id = {e['id']: e for e in data['entries']}
    return [by_id[i] for i in project['entryIds'] if i in by_id and by_id[i]['kind'] == kind]


def open_import(page, kind):
    page.get_by_test_id('prompt-import-open').click()
    dialog = page.get_by_role('dialog', name='批量导入音乐提示词' if kind == 'audio' else '批量导入图片提示词', exact=True)
    expect(dialog).to_be_visible()
    expect(dialog.get_by_test_id('prompt-import-text')).to_be_focused()
    assert page.locator('#root').evaluate('(root) => root.inert')
    return dialog


def close_import(page, dialog):
    dialog.get_by_role('button', name='取消', exact=True).click()
    dialog.get_by_test_id('prompt-import-discard').click()
    expect(dialog).not_to_be_visible()
    expect(page.get_by_test_id('prompt-import-open')).to_be_focused()
    assert not page.locator('#root').evaluate('(root) => root.inert')


def document(kind, count):
    label = '音乐' if kind == 'audio' else '图片'
    blocks = [f'# {label}提示词 v1']
    for index in range(1, count + 1):
        blocks.append(f'## 条目 {index}\n### 名称\n{label}名{index}\n\n### 提示词\n{label}描述{index}\n\n  保留段落空格  ')
        if kind == 'audio':
            blocks[-1] += f'\n### 歌词\n[Verse]\n歌词{index}\n\n[Chorus]\n尾句'
    return '\n\n'.join(blocks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    root, scratch = args.root.resolve(), Path(os.environ['PI_SCRATCH_DIR']).resolve()
    assert root != scratch and root.is_relative_to(scratch)
    assert args.endpoint.startswith('http://127.0.0.1:')
    report = {'passed': False, 'checks': [], 'pageErrors': [], 'externalRequests': [], 'mode': 'package-smoke' if args.smoke else 'full-targeted'}
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(args.endpoint)
        try:
            page = browser.contexts[0].pages[0]
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('request', lambda request: report['externalRequests'].append(request.url) if request.url.startswith(('http://', 'https://')) else None)
            page.wait_for_load_state('networkidle')
            expect(page.get_by_test_id('nav-generation')).to_be_enabled(timeout=30000)
            a = page.evaluate('() => window.canvas.createGenerationProject()')
            page.evaluate('id => window.canvas.updateGenerationProject(id, {name:"粘贴测试A"})', a['id'])
            wait(lambda: page.get_by_test_id('generation-project-' + a['id']).count() == 1)
            page.get_by_test_id('generation-project-' + a['id']).click()
            expect(page.get_by_test_id('prompt-template-save')).to_be_enabled()
            page.get_by_test_id('prompt-template-save').click()
            wait(lambda: '已取消保存模板' in page.locator('main').inner_text())
            page.get_by_test_id('prompt-template-save').click()
            wait(lambda: (root / 'templates' / '音乐提示词模板.md').exists())
            page.get_by_test_id('generation-tab-image').click()
            expect(page.get_by_test_id('prompt-template-save')).to_have_text('下载图片模板')
            page.get_by_test_id('prompt-template-save').click()
            wait(lambda: (root / 'templates' / '图片提示词模板.md').exists())
            report['checks'].append('both template buttons use native save choices; cancel succeeds; Chinese UTF-8 template files saved')
            if not args.smoke:
                page.get_by_test_id('generation-tab-audio').click()
                expect(page.get_by_test_id('prompt-template-save')).to_have_text('下载音乐模板')
                old = page.evaluate('id => window.canvas.addEntry(id, "audio")', a['id'])
                page.evaluate('entry => window.canvas.updateEntry(entry.id, entry.revision, {...entry.draft,prompt:"原有草稿不改动"}, {})', old)
                wait(lambda: len(entries(page, a['id'], 'audio')) == 1)
                old_snapshot = entries(page, a['id'], 'audio')[0]
                expect(page.get_by_test_id('entry-' + old['id'])).to_be_visible()
                page.get_by_test_id('entry-' + old['id']).locator('input[type=checkbox]').check()
                before = len(snapshot(page)['entries'])
                dialog = open_import(page, 'audio')
                raw = dialog.get_by_test_id('prompt-import-text')
                invalid = '# 图片提示词 v1\n## 条目 1\n### 提示词\n不能放进音乐'
                raw.fill(invalid)
                dialog.get_by_test_id('prompt-import-parse').click()
                expect(dialog.get_by_test_id('prompt-import-errors')).to_contain_text('第 1 行')
                expect(raw).to_have_value(invalid)
                assert len(snapshot(page)['entries']) == before
                source = document('audio', 2)
                raw.fill(source)
                dialog.get_by_test_id('prompt-import-parse').click()
                expect(dialog.get_by_test_id('prompt-import-count')).to_have_text('识别 2 个待创建条目')
                dialog.get_by_test_id('prompt-import-row-1').get_by_test_id('prompt-import-title').fill('临时编辑不得静默丢弃')
                dialog.get_by_test_id('prompt-import-back').click()
                expect(dialog.get_by_test_id('prompt-import-discard')).to_be_visible()
                dialog.get_by_role('button', name='继续编辑', exact=True).click()
                expect(dialog.get_by_test_id('prompt-import-row-1').get_by_test_id('prompt-import-title')).to_have_value('临时编辑不得静默丢弃')
                dialog.get_by_test_id('prompt-import-back').click()
                dialog.get_by_test_id('prompt-import-discard').click()
                expect(dialog.get_by_test_id('prompt-import-text')).to_have_value(source)
                dialog.get_by_test_id('prompt-import-parse').click()
                expect(dialog.get_by_test_id('prompt-import-row-1').get_by_test_id('prompt-import-title')).to_have_value('音乐名1')
                close_import(page, dialog)
                assert len(snapshot(page)['entries']) == before
                report['checks'].append('wrong-type original-line error, original text retained, return requires discard confirmation/reparse, cancel no writes and focus restored')

                dialog = open_import(page, 'audio')
                no_api = '# 音乐提示词 v1\n\n## 条目 1\n### 名称\n无API名称\n### 提示词\n  多行提示词  \n\n内部段落\n### 歌词\n[Verse]\n中文歌词\n\n## 条目 2\n### 提示词\n  多行提示词  \n\n内部段落'
                dialog.get_by_test_id('prompt-import-text').fill(no_api)
                dialog.get_by_test_id('prompt-import-parse').click()
                expect(dialog.get_by_text('重复提示词提醒', exact=False)).to_be_visible()
                assert dialog.get_by_test_id('prompt-import-row-1').get_by_test_id('entry-provider').locator('option').count() == 1
                dialog.get_by_test_id('prompt-import-create').evaluate('(button) => {button.click(); button.click()}')
                expect(dialog).not_to_be_visible(timeout=30000)
                wait(lambda: len(entries(page, a['id'], 'audio')) == 3)
                saved = entries(page, a['id'], 'audio')
                assert saved[0] == old_snapshot
                assert saved[1]['draft']['prompt'] == saved[2]['draft']['prompt'] == '  多行提示词  \n\n内部段落'
                assert saved[1]['draft']['lyrics'] == '[Verse]\n中文歌词' and not saved[2]['draft'].get('title')
                assert all(not e.get('requestId') and not e['draft'].get('provider') for e in saved[1:])
                expect(page.get_by_test_id('generation-selected-count')).to_contain_text('1 / 3')
                page.get_by_test_id('generation-deselect-all').click()
                page.get_by_test_id('entry-' + saved[1]['id']).locator('input[type=checkbox]').check()
                page.get_by_test_id('generate-selected').click()
                wait(lambda: '请先添加并选择适用的 API' in page.get_by_test_id('generation-workspace').inner_text())
                assert page.get_by_role('dialog').count() == 0 and not snapshot(page)['requests']
                report['checks'].append('no-API draft batch saves exactly twice despite double click/lost reply; duplicates retained; old row/selection preserved; generation blocked')

                for provider in ['mureka-cn', 'reapi', 'siliconflow', 'acestep']:
                    value = {'provider': provider}
                    if provider != 'acestep':
                        value['key'] = 'synthetic-prompt-import-402'
                    page.evaluate('value => window.canvas.saveApi(value)', value)
                wait(lambda: len(snapshot(page)['apis']) == 4)
                dialog = open_import(page, 'audio')
                source = document('audio', 23)
                dialog.get_by_test_id('prompt-import-text').fill(source)
                dialog.get_by_test_id('prompt-import-parse').click()
                expect(dialog.get_by_test_id('prompt-import-count')).to_have_text('识别 23 个待创建条目')
                assert dialog.locator('.prompt-import-row').count() == 10
                body = dialog.locator('.dialog-body')
                assert body.evaluate('(element) => element.scrollHeight > element.clientHeight')
                body.hover(); page.mouse.wheel(0, 700)
                wait(lambda: body.evaluate('(element) => element.scrollTop') > 0)
                bulk = dialog.get_by_test_id('prompt-import-bulk')
                bulk.locator(':scope > summary').click()
                bulk.get_by_test_id('entry-provider').select_option('reapi')
                bulk.get_by_test_id('entry-input-mode').select_option('lyrics')
                bulk.locator('details.advanced > summary').click()
                bulk.get_by_test_id('entry-model').select_option('V6_WILD')
                bulk.get_by_test_id('prompt-import-apply-all').click()
                first = dialog.get_by_test_id('prompt-import-row-1')
                expect(first.get_by_test_id('prompt-import-title')).to_have_value('音乐名1')
                expect(first.get_by_test_id('entry-prompt')).to_have_value('音乐描述1\n\n  保留段落空格  ')
                expect(first.get_by_test_id('entry-lyrics')).to_have_value('[Verse]\n歌词1\n\n[Chorus]\n尾句')
                first.get_by_test_id('entry-provider').select_option('mureka-cn')
                first.locator('details.advanced > summary').click()
                first.get_by_test_id('entry-model').select_option('mureka-9.5')
                long_text = '长描述' * 1100 + '\n\n<script id="untrusted-import">alert(1)</script> https://never-fetch.invalid/ C:\\never-read.txt'
                first.get_by_test_id('entry-prompt').fill(long_text)
                second = dialog.get_by_test_id('prompt-import-row-2')
                second.get_by_test_id('entry-provider').select_option('acestep')
                second.locator('details.advanced > summary').click()
                second.get_by_test_id('entry-seconds').fill('120')
                assert second.get_by_test_id('ace-models-refresh').count() == 0
                dialog.get_by_test_id('prompt-import-remove-3').click()
                dialog.get_by_role('button', name='下一页', exact=True).click()
                expect(dialog.get_by_test_id('prompt-import-row-12')).to_be_visible()
                assert not page.locator('#untrusted-import').count()
                assert not page.evaluate('() => document.documentElement.scrollWidth > innerWidth')
                page.screenshot(path=str(root / 'music-import.png'))
                dialog.get_by_test_id('prompt-import-create').click()
                expect(dialog).not_to_be_visible(timeout=30000)
                wait(lambda: len(entries(page, a['id'], 'audio')) == 25)
                new = entries(page, a['id'], 'audio')[3:]
                assert [e['draft'].get('title') for e in new] == [f'音乐名{i}' for i in range(1, 24) if i != 3]
                assert new[0]['draft']['prompt'] == long_text and new[0]['draft']['provider'] == 'mureka-cn' and new[0]['draft']['model'] == 'mureka-9.5'
                assert new[1]['draft']['provider'] == 'acestep' and new[1]['draft']['seconds'] == 120
                assert all(e['draft']['model'] == 'V6_WILD' for e in new[2:])
                assert all(e['draft']['lyrics'].startswith('[Verse]\n') for e in new)
                pager = page.get_by_test_id('generation-workspace').locator(':scope > .pager')
                pager.get_by_role('button', name='下一页', exact=True).click()
                assert page.locator('.entry-list > article').count() == 5
                report['checks'].append('23 music rows preview paginated; bulk settings preserve content; per-row APIs/models/lyrics/long HTML-like text preserved; removal order and created-page pagination correct; no model refresh')

                b = page.evaluate('() => window.canvas.createGenerationProject()')
                page.evaluate('id => window.canvas.updateGenerationProject(id,{name:"粘贴测试B"})', b['id'])
                wait(lambda: page.get_by_test_id('generation-project-' + b['id']).count() == 1)
                page.get_by_test_id('generation-project-' + b['id']).click()
                page.get_by_test_id('generation-tab-image').click()
                expect(page.get_by_test_id('prompt-template-save')).to_have_text('下载图片模板')
                dialog = open_import(page, 'image')
                dialog.get_by_test_id('prompt-import-text').fill(document('image', 12))
                dialog.get_by_test_id('prompt-import-parse').click()
                bulk = dialog.get_by_test_id('prompt-import-bulk'); bulk.locator(':scope > summary').click()
                assert bulk.get_by_test_id('entry-provider').locator('option').count() == 2
                bulk.locator('details.advanced > summary').click()
                bulk.get_by_label('画面尺寸', exact=False).select_option('928x1664')
                bulk.get_by_test_id('prompt-import-apply-all').click()
                first = dialog.get_by_test_id('prompt-import-row-1'); first.locator('details.advanced > summary').click()
                first.get_by_label('画面尺寸', exact=False).select_option('1328x1328')
                assert dialog.get_by_test_id('entry-lyrics').count() == 0
                page.screenshot(path=str(root / 'image-import.png'))
                dialog.get_by_test_id('prompt-import-create').click()
                expect(dialog).not_to_be_visible(timeout=30000)
                wait(lambda: len(entries(page, b['id'], 'image')) == 12)
                images = entries(page, b['id'], 'image')
                assert [e['draft']['title'] for e in images] == [f'图片名{i}' for i in range(1, 13)]
                assert images[0]['draft']['size'] == '1328x1328' and all(e['draft']['size'] == '928x1664' for e in images[1:])
                assert len(entries(page, a['id'], 'audio')) == 25 and not entries(page, a['id'], 'image') and not entries(page, b['id'], 'audio')
                assert not snapshot(page)['requests'] and not snapshot(page)['batches']
                report['checks'].append('image paste/preview/bulk size/per-row size/create passes; no lyrics field, only image API, project/type isolation and no generation')
            assert not report['pageErrors'] and not report['externalRequests']
            report['passed'] = True
        finally:
            (root / 'ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            browser.close()  # disconnect the CDP client; Node owns the actual app lifetime
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']), 'report': str(root / 'ui-report.json')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
