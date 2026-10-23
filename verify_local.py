"""Exercise the real loopback server without sending any inference request."""
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parent
config = json.loads((root / 'runtime.json').read_text(encoding='utf-8'))
process = subprocess.Popen([sys.executable, str(root / 'bridge.py'), '--config', str(root / 'runtime.json')],
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def request(path, payload=None, token=True):
    headers = {'X-Zotero-Chat-Token': config['token']} if token else {}
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request('http://127.0.0.1:23125' + path, headers=headers, data=data)
    with urllib.request.urlopen(req, timeout=55) as response:
        return json.load(response)


try:
    deadline = time.monotonic() + 55
    while True:
        try:
            state = request('/state')
            break
        except (OSError, urllib.error.URLError):
            if process.poll() is not None or time.monotonic() > deadline:
                raise
            time.sleep(.3)
    assert state['threadId'] == config['threadId']
    print(json.dumps({'threadId': state['threadId'], 'historyMessages': len(state['messages']), 'connected': state['connected']}, ensure_ascii=True), flush=True)
    try:
        request('/state', token=False)
        raise AssertionError('Unauthenticated read was accepted')
    except urllib.error.HTTPError as exc:
        assert exc.code == 403
        print('Unauthenticated read rejected: 403', flush=True)
    try:
        result = request('/connect', {})
        print('Original thread ownership acquired without sending a turn:', result['connected'], flush=True)
    except urllib.error.HTTPError as exc:
        error = json.load(exc)
        assert exc.code == 409 and '桌面' in error['error']
        print('Original active-writer lock correctly surfaced: 409', flush=True)
    print('No turn/start request was sent.', flush=True)
finally:
    try:
        request('/shutdown', {})
    except OSError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()

