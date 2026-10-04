"""Inspect actual V3 Electron UI at two resolutions, using only isolated local fixtures."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect


def check_readability(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    small = page.evaluate('''() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), small = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!node.textContent.trim() || !el || ['SCRIPT','STYLE','OPTION'].includes(el.tagName) || !el.getClientRects().length) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 14) small.push({text: node.textContent.trim().slice(0,50), size});
      }
      return small;
    }''')
    assert not small, small


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scratch = Path(os.environ.get('PI_SCRATCH_DIR', tempfile.gettempdir()))
    parser.add_argument('--output', type=Path, default=scratch / 'v3-visual')
    parser.add_argument('--fixture', type=Path, help='Reuse a completed synthetic batch fixture inside PI_SCRATCH_DIR')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[1]
    if args.fixture:
        fixture = args.fixture.resolve()
        assert fixture.is_relative_to(scratch.resolve()), 'Only isolated synthetic fixture paths are accepted'
        assert json.loads((fixture / 'report.json').read_text(encoding='utf-8'))['passed']
    else:
        seed = subprocess.run(['node', '--input-type=module', '-e', "import {makeBatchFixture} from './scripts/batch-test-utils.mjs'; const f=await makeBatchFixture({count:60,seconds:8,images:3}); console.log(JSON.stringify({root:f.root}));"], cwd=root, capture_output=True, text=True, encoding='utf-8', timeout=300, check=True)
        fixture = Path(json.loads(seed.stdout.strip().splitlines()[-1])['root'])
    executable = root / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='v3-visual-profile-', dir=scratch) as profile:
        shutil.copytree(fixture / 'data', Path(profile) / 'appdata')
        env = dict(os.environ, MUSIC_CANVAS_E2E='1', MUSIC_CANVAS_TEST_DIR=profile)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        with (args.output / 'electron.log').open('w', encoding='utf-8') as log:
            proc = subprocess.Popen([str(executable), str(root), f'--remote-debugging-port={port}'], env=env, stdout=log, stderr=log)
            try:
                endpoint = f'http://127.0.0.1:{port}'
                for _ in range(150):
                    if proc.poll() is not None: raise RuntimeError('Electron exited early')
                    try:
                        with urllib.request.urlopen(endpoint + '/json/version', timeout=1) as response: json.load(response)
                        break
                    except OSError: time.sleep(0.2)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(endpoint)
                    context = browser.contexts[0]
                    page = context.pages[0] if context.pages else context.wait_for_event('page')
                    page.wait_for_load_state('networkidle')
                    errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
                    expect(page.get_by_test_id('library-import')).to_be_enabled(timeout=120000)
                    (args.output / 'initial-semantics.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
                    for width, height in [(1366, 768), (1920, 1080)]:
                        page.set_viewport_size({'width': width, 'height': height})
                        page.get_by_test_id('nav-library').click()
                        page.get_by_test_id('library-tab-audio').click()
                        expect(page.get_by_test_id('library-audio-table').locator('tbody tr')).to_have_count(30)
                        check_readability(page)
                        assert page.locator('#page-title').evaluate('(el)=>getComputedStyle(el).fontSize') == '24px'
                        page.screenshot(path=str(args.output / f'library-music-{width}.png'))
                        page.get_by_test_id('library-select-all').check()
                        selected = page.get_by_test_id('library-selection')
                        expect(selected).to_contain_text('60')
                        page.get_by_role('button', name='下一页', exact=True).click()
                        expect(page.get_by_test_id('library-audio-table').locator('tbody input:checked')).to_have_count(30)
                        page.get_by_test_id('library-tab-image').click()
                        expect(page.get_by_test_id('library-image-grid').locator('article')).to_have_count(3)
                        page.wait_for_function("[...document.querySelectorAll('.library-contact-sheet img')].every(i=>i.complete&&i.naturalWidth>0)")
                        page.get_by_test_id('library-select-all').check()
                        check_readability(page)
                        page.screenshot(path=str(args.output / f'library-images-{width}.png'))
                        first_image = page.locator('.library-image-open').first
                        first_image.click()
                        preview = page.get_by_role('dialog', name='查看图片', exact=True)
                        expect(preview).to_be_visible(); check_readability(page)
                        page.keyboard.press('Tab')
                        assert page.evaluate("Boolean(document.activeElement.closest('[role=dialog]'))")
                        page.keyboard.press('Escape'); expect(first_image).to_be_focused()
                        page.get_by_test_id('nav-batch').click()
                        page.get_by_test_id('batch-minimum-minutes').fill('60' if args.fixture else '1')
                        page.get_by_test_id('batch-plan-button').click()
                        expect(page.get_by_test_id('batch-start')).to_be_enabled(timeout=120000)
                        check_readability(page)
                        page.get_by_test_id('batch-plan').scroll_into_view_if_needed()
                        page.screenshot(path=str(args.output / f'batch-plan-{width}.png'))
                        page.get_by_test_id('batch-history').scroll_into_view_if_needed()
                        check_readability(page)
                        page.screenshot(path=str(args.output / f'batch-history-{width}.png'))
                        page.get_by_test_id('nav-generation').click()
                        expect(page.get_by_label('音乐描述', exact=True)).to_be_visible()
                        assert page.get_by_label('音乐描述', exact=True).evaluate('(el)=>getComputedStyle(el).fontSize') == '16px'
                        assert page.get_by_label('画面描述', exact=True).evaluate('(el)=>getComputedStyle(el).fontSize') == '16px'
                        check_readability(page)
                        page.screenshot(path=str(args.output / f'generation-{width}.png'))
                        page.get_by_role('button', name='设置', exact=True).click()
                        dialog = page.get_by_role('dialog', name='设置', exact=True)
                        expect(dialog.get_by_role('heading', name='硅基流动 · 图片', exact=True)).to_be_visible()
                        check_readability(page)
                        page.screenshot(path=str(args.output / f'settings-{width}.png'))
                        page.keyboard.press('Escape')
                    assert not errors, errors
                    (args.output / 'report.json').write_text(json.dumps({'passed': True, 'resolutions': [[1366,768],[1920,1080]], 'assets': 63, 'paidCalls': 0, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
                    print('PASS: actual V3 UI, 60 tracks/3 images, pagination/select all, plan/history, 16px inputs/24px title/14px minimum, focus/Escape, no horizontal overflow or page errors')
                    browser.close()
            finally:
                if proc.poll() is None:
                    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True, check=False)
                proc.wait(timeout=20)


if __name__ == '__main__':
    main()
