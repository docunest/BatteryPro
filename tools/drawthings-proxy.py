#!/usr/bin/env python3
"""
Tiny CORS proxy so the Private AI Chat web app can talk to Draw Things' HTTP API.

Browsers only let a web page read another server's response if that server
allows it (CORS). This proxy sits next to Draw Things on your Mac, forwards
the two API routes the app uses, and adds the required headers for your
app's address only.

    Phone (app) --HTTPS--> tailscale serve --> this proxy :7861 --> Draw Things :7860

Usage (standard library only, no installs):
    python3 drawthings-proxy.py
    python3 drawthings-proxy.py --origin https://docunest.github.io --target http://127.0.0.1:7860 --port 7861
Then, in another terminal:
    tailscale serve --bg 7861
"""
import argparse
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED = {('GET', '/'), ('POST', '/sdapi/v1/txt2img')}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--origin', default='https://docunest.github.io', help='web app origin allowed to call the API')
    ap.add_argument('--target', default='http://127.0.0.1:7860', help='Draw Things API Server address')
    ap.add_argument('--port', type=int, default=7861, help='port to listen on (localhost only)')
    args = ap.parse_args()
    target = args.target.rstrip('/')

    class Proxy(BaseHTTPRequestHandler):
        def cors(self):
            self.send_header('Access-Control-Allow-Origin', args.origin)
            self.send_header('Vary', 'Origin')

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Max-Age', '86400')
            self.end_headers()

        def forward(self):
            path = self.path.split('?', 1)[0]
            if (self.command, path) not in ALLOWED:
                self.send_response(404)
                self.cors()
                self.end_headers()
                return
            # Requests from a browser must come from the app's own address.
            origin = self.headers.get('Origin')
            if origin and origin != args.origin:
                self.send_response(403)
                self.end_headers()
                return
            body = None
            if self.command == 'POST':
                body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            req = urllib.request.Request(target + path, data=body, method=self.command,
                                         headers={'Content-Type': 'application/json'})
            try:
                # Image generation can take minutes on big models.
                with urllib.request.urlopen(req, timeout=900) as r:
                    status, data, ctype = r.status, r.read(), r.headers.get('Content-Type', 'application/json')
            except urllib.error.HTTPError as e:
                status, data, ctype = e.code, e.read(), e.headers.get('Content-Type', 'text/plain')
            except OSError as e:
                status, data, ctype = 502, f'Draw Things is not reachable at {target}: {e}'.encode(), 'text/plain'
            self.send_response(status)
            self.cors()
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = forward
        do_POST = forward

        def log_message(self, fmt, *a):
            # Log the route only; never prompts or images.
            print(f'{self.command} {self.path.split("?", 1)[0]} -> {a[1] if len(a) > 1 else ""}')

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Proxy)
    print(f'Draw Things proxy on http://127.0.0.1:{args.port} -> {target} (allowing {args.origin})')
    print(f'Expose it to your phone with:  tailscale serve --bg {args.port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
