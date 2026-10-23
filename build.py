"""Build a machine-local XPI and runtime configuration. Never includes model credentials."""
import json
from pathlib import Path
import secrets
import shutil
import sys
import zipfile
import os

ROOT = Path(__file__).resolve().parent
THREAD = os.environ.get('CODEX_ZOTERO_THREAD_ID', '').strip()
if not THREAD:
    raise RuntimeError('Set CODEX_ZOTERO_THREAD_ID before the first build.')
runtime = ROOT / 'runtime.json'
if not runtime.exists():
    runtime.write_text(json.dumps({'threadId': THREAD, 'token': secrets.token_urlsafe(32)}, indent=2), encoding='utf-8')
settings = json.loads(runtime.read_text(encoding='utf-8'))
settings['codex'] = shutil.which('codex')
if not settings['codex']:
    raise RuntimeError('Installed Codex executable not found.')
runtime.write_text(json.dumps(settings, indent=2), encoding='utf-8')
python = Path(sys.executable).with_name('pythonw.exe')
if not python.exists():
    raise RuntimeError('This Windows build requires the installed pythonw.exe.')
machine = {'python': str(python), 'bridge': str(ROOT / 'bridge.py'), 'runtimeConfig': str(runtime)}
manifest = json.loads((ROOT / 'extension' / 'manifest.json').read_text(encoding='utf-8'))
application = manifest['applications']['zotero']
for required in ('id', 'update_url', 'strict_min_version', 'strict_max_version'):
    if not application.get(required):
        raise ValueError('Required Zotero manifest field missing: ' + required)
if not application['update_url'].startswith('https://'):
    raise ValueError('Zotero requires secure HTTPS update metadata even for manually managed plugins.')
target = ROOT / ('Codex-Zotero-Chat-' + manifest['version'] + '.xpi')
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for filename in sorted((ROOT / 'extension').rglob('*')):
        if filename.is_file():
            relative = filename.relative_to(ROOT / 'extension').as_posix()
            if relative == 'bootstrap.js':
                script = filename.read_text(encoding='utf-8')
                marker = 'const MACHINE_CONFIG = null;'
                if marker not in script:
                    raise ValueError('Bootstrap machine configuration marker missing.')
                script = script.replace(marker, 'const MACHINE_CONFIG = ' + json.dumps(machine, ensure_ascii=True) + ';', 1)
                archive.writestr(relative, script.encode('utf-8'))
            else:
                archive.write(filename, relative)
    archive.writestr('machine.json', json.dumps(machine, ensure_ascii=True))
print(str(target))
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    print('XPI verified:', len(archive.namelist()), 'entries')

