"""Launch the actual portable EXE twice with an isolated profile. Never calls AI services."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, default=Path('dist/油管视频生成-3.0.0-Windows-x64.exe'))
    parser.add_argument('--output', type=Path, default=Path(os.environ['PI_SCRATCH_DIR']) / 'v3-portable')
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='v3-portable-profile-', dir=os.environ['PI_SCRATCH_DIR']) as temporary:
        root = Path(temporary); profile = root / 'appdata'; profile.mkdir()
        settings = {'version': 3, 'projectRoot': str(root / 'media'), 'musicDefaults': {'prompt':'','mode':'instrumental','model':'auto','count':1,'styles':[]}, 'imageDefaults': {'prompt':'','model':'Qwen/Qwen-Image','size':'1664x928'}}
        (profile / 'settings.json').write_text(json.dumps(settings), encoding='utf-8')
        env = dict(os.environ, MUSIC_CANVAS_E2E='1', MUSIC_CANVAS_TEST_DIR=str(root / 'must-not-be-used'))
        env.pop('ELECTRON_RUN_AS_NODE', None)
        previous_id = None
        for attempt in range(2):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            with (args.output / f'launcher-{attempt}.log').open('w', encoding='utf-8') as log:
                proc = subprocess.Popen([str(args.exe.resolve()), f'--user-data-dir={profile}', f'--remote-debugging-port={port}'], env=env, stdout=log, stderr=log)
                try:
                    endpoint = f'http://127.0.0.1:{port}'
                    ready = False
                    for _ in range(300):
                        try:
                            with urllib.request.urlopen(endpoint + '/json/version', timeout=1) as response: json.load(response)
                            ready = True; break
                        except OSError: time.sleep(0.3)
                    if not ready: raise RuntimeError('Portable launcher did not expose the owned test window')
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.connect_over_cdp(endpoint)
                        context = browser.contexts[0]
                        page = context.pages[0] if context.pages else context.wait_for_event('page')
                        page.wait_for_load_state('networkidle')
                        expect(page.get_by_test_id('library-import')).to_be_enabled(timeout=30000)
                        assert page.title() == '油管视频生成'
                        boot = page.evaluate('window.canvas.bootstrap()')
                        assert boot['testMode'] is False, 'Packaged app must ignore development simulation flags'
                        assert boot['settings']['projectRoot'] == str(root / 'media')
                        assert boot['settings']['keys'] == {'mureka':False, 'siliconflow':False}
                        page.get_by_test_id('nav-generation').click()
                        expect(page.get_by_label('音乐描述', exact=True)).to_be_visible()
                        project = page.evaluate('window.canvas.getGenerationProject()')
                        if previous_id: assert project['id'] == previous_id
                        previous_id = project['id']
                        assert not project['musicJobs'] and not project['imageJobs']
                        assert Path(project['directory']).is_relative_to(root)
                        page.screenshot(path=str(args.output / f'portable-window-{attempt}.png'))
                        page.close()
                        browser.close()
                    proc.wait(timeout=30)
                    assert proc.returncode == 0, proc.returncode
                finally:
                    if proc.poll() is None:
                        subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'], capture_output=True, check=False)
                        proc.wait(timeout=20)
        (args.output / 'report.json').write_text(json.dumps({'passed':True,'launches':2,'generationSessionRetained':True,'paidCalls':0,'executable':str(args.exe.resolve())}, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS: actual portable launcher twice, isolated profile, packaged mode, persistent automatic session, no API calls')


if __name__ == '__main__':
    main()
