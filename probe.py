"""Read-only check of the official Codex app-server integration."""
import json
import queue
import shutil
import subprocess
import sys
import threading
import time
import os

THREAD_ID = os.environ.get("CODEX_ZOTERO_THREAD_ID", "").strip()
if not THREAD_ID:
    raise RuntimeError("Set CODEX_ZOTERO_THREAD_ID before running the probe.")


def main():
    proc = subprocess.Popen(
        [shutil.which("codex"), "app-server", "--stdio"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW,
    )
    messages = queue.Queue()
    threading.Thread(target=lambda: [messages.put(line) for line in proc.stdout], daemon=True).start()
    threading.Thread(target=lambda: [None for line in proc.stderr], daemon=True).start()

    def call(number, method, params):
        proc.stdin.write(json.dumps({"id": number, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            try:
                message = json.loads(messages.get(timeout=1))
            except queue.Empty:
                if proc.poll() is not None:
                    raise RuntimeError(f"app-server exited: {proc.returncode}")
                continue
            if message.get("id") == number:
                return message
        raise TimeoutError(method)

    try:
        init = call(1, "initialize", {"clientInfo": {"name": "zotero_codex_chat", "version": "0.1.0"}})
        print(json.dumps({"initialize": init}, ensure_ascii=True), flush=True)
        proc.stdin.write('{"method":"initialized"}\n')
        proc.stdin.flush()
        result = call(2, "thread/read", {"threadId": THREAD_ID, "includeTurns": False})
        thread = result.get("result", {}).get("thread", {})
        print(json.dumps({"thread": {k: thread.get(k) for k in ("id", "name", "status", "cwd")}, "error": result.get("error")}, ensure_ascii=True), flush=True)
        account = call(3, "account/read", {"refreshToken": False})
        info = account.get("result", {}).get("account") or {}
        print(json.dumps({"accountType": info.get("type"), "requiresOpenaiAuth": account.get("result", {}).get("requiresOpenaiAuth"), "error": account.get("error")}, ensure_ascii=True), flush=True)
        if "--resume" in sys.argv:
            resumed = call(4, "thread/resume", {"threadId": THREAD_ID, "excludeTurns": True})
            resumed_thread = resumed.get("result", {}).get("thread", {})
            print(json.dumps({"resumedThreadId": resumed_thread.get("id"), "status": resumed_thread.get("status"), "error": resumed.get("error")}, ensure_ascii=True), flush=True)
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.terminate()


if __name__ == "__main__":
    main()

