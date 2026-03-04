"""
临时 Lark challenge 验证服务
用完即删，仅用于通过 Lark 开发者控制台 URL 验证
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
            challenge = data.get("challenge", "")
            resp = json.dumps({"challenge": challenge}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(resp)
            print(f"[OK] challenge={challenge}")
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            print(f"[ERR] {e}")

    def log_message(self, *args):
        pass  # 静默 access log


if __name__ == "__main__":
    port = 8765
    print(f"启动验证服务 http://0.0.0.0:{port}")
    print("等待 Lark 发送 challenge...")
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
