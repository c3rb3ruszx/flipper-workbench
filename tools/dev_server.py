"""Dev only: serve ui/ in a normal browser with the REAL Python Api behind it.

  .venv\\Scripts\\python.exe tools\\dev_server.py [port]      then open http://127.0.0.1:8766/index.html?devapi

JS calls POST /api/<method> with a JSON list of arguments. Events the Api would push into the window are
queued and the page polls /__events. File dialogs return the paths in FB_DEV_PICK (";"-separated), and save
dialogs write into .cache/devsave/. A plugged-in Flipper is ignored unless FB_DEV_DEVICE=1.
"""
import http.server
import json
import os
import re
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import gui  # noqa: E402

UI = ROOT / "ui"
EVENTS = []
LOCK = threading.Lock()


class FakeWindow:
    def evaluate_js(self, script):
        with LOCK:
            EVENTS.append(script)

    def create_file_dialog(self, kind, save_filename="", **kw):
        import webview
        if kind in (getattr(webview.FileDialog, "SAVE", None), getattr(webview, "SAVE_DIALOG", None)):
            d = ROOT / ".cache" / "devsave"
            d.mkdir(parents=True, exist_ok=True)
            return str(d / (save_filename or "out.bin"))
        pick = os.environ.get("FB_DEV_PICK", "")
        return [p for p in pick.split(";") if p] or None


API = gui.Api()
API._window = FakeWindow()
if os.environ.get("FB_DEV_DEVICE") != "1":
    # By default the dev page never sees a plugged-in Flipper: no device monitor, so no auto backup, screen mirror,
    # battery readings or companion status writes from a test page. Set FB_DEV_DEVICE=1 to allow them.
    API.start_background = lambda: True


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")   # always serve the files as they are on disk
        super().end_headers()

    def do_POST(self):
        m = re.fullmatch(r"/api/([a-z_0-9]+)", self.path)
        n = int(self.headers.get("Content-Length") or 0)
        args = json.loads(self.rfile.read(n) or b"[]")
        if not m or m.group(1).startswith("_") or not hasattr(API, m.group(1)):
            self.send_error(404)
            return
        try:
            res = getattr(API, m.group(1))(*args)
        except Exception as e:  # noqa: BLE001
            res = {"error": f"{type(e).__name__}: {e}"}
        body = json.dumps(res).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/__events"):
            with LOCK:
                body = json.dumps(EVENTS[:]).encode()
                EVENTS.clear()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    print(f"http://127.0.0.1:{port}/index.html?devapi", flush=True)
    S(("127.0.0.1", port), H).serve_forever()
