"""
Local sprite server — serves output/sheets/ + a JSON index.

    python scripts/serve_sprites.py

Then open: client/test_client.html
"""
import json
import os
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

SHEETS_DIR = Path(__file__).parent.parent / "output" / "sheets"
CLIENT_DIR = Path(__file__).parent.parent / "client"
PORT = 8888

MIME = {".png": "image/png", ".json": "application/json", ".html": "text/html"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass  # suppress request noise

    def do_GET(self):
        if self.path == "/sheets.json":
            names = sorted(p.name for p in SHEETS_DIR.glob("*.png"))
            body = json.dumps(names).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)

        elif self.path.startswith("/sheets/"):
            name = Path(self.path).name
            path = SHEETS_DIR / name
            if not path.exists() or path.suffix != ".png":
                self.send_error(404); return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", len(data))
            self.end_headers()
            self.wfile.write(data)

        else:
            # Serve static files from client/
            safe = self.path.lstrip("/")
            target = (CLIENT_DIR / safe).resolve()
            try:
                target.relative_to(CLIENT_DIR.resolve())
            except ValueError:
                self.send_error(403); return
            if not target.exists() or not target.is_file():
                self.send_error(404); return
            data = target.read_bytes()
            ctype = MIME.get(target.suffix, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", len(data))
            self.end_headers()
            self.wfile.write(data)


if __name__ == "__main__":
    import signal, subprocess
    try:
        result = subprocess.run(["lsof", "-ti", f":{PORT}"], capture_output=True, text=True)
        pids = result.stdout.strip().split()
        if pids:
            for pid in pids:
                os.kill(int(pid), signal.SIGKILL)
            print(f"Killed existing process(es) on :{PORT}: {' '.join(pids)}")
    except Exception:
        pass
    print(f"Serving {SHEETS_DIR}")
    print(f"Open: client/test_client.html  (http://localhost:{PORT}/sheets.json)")
    HTTPServer(("localhost", PORT), Handler).serve_forever()
