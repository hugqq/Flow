import json
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

from . import APP_DIR, RequestError
from .media import stream_file, subtitle_page


WEB_TYPES = {"/": "text/html", "/app.js": "text/javascript", "/style.css": "text/css"}
WEB_DIR = APP_DIR / "web"


class Handler(BaseHTTPRequestHandler):
    server_version = "Flow/1"

    @property
    def library(self):
        return self.server.library

    def web_revision(self):
        token = getattr(self.server, "reload_token", None)
        if not token:
            return None
        try:
            files = [(WEB_DIR / (route[1:] or "index.html")).stat() for route in WEB_TYPES]
        except FileNotFoundError:
            return None
        return "-".join([token, *(f"{info.st_mtime_ns:x}.{info.st_size:x}" for info in files)])

    def log_message(self, format, *args):
        pass

    def reply(self, status, payload, content_type="application/json; charset=utf-8"):
        if not isinstance(payload, bytes):
            payload = json.dumps(payload, ensure_ascii=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def handle_request(self):
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            return
        except RequestError as error:
            self.reply(error.status, {"error": str(error)})
        except (ValueError, OverflowError, RecursionError):
            self.reply(400, {"error": "请求参数无效"})
        except PermissionError:
            self.reply(403, {"error": "服务没有读取此目录或文件的权限"})
        except FileNotFoundError:
            self.reply(404, {"error": "文件或目录已不存在"})
        except Exception:
            self.reply(500, {"error": "操作失败，请稍后重试"})

    do_GET = do_HEAD = do_POST = handle_request

    def route(self):
        url = urlsplit(self.path)
        query = dict((k, v[0]) for k, v in parse_qs(url.query).items())
        images = url.path.startswith("/api/images/")
        library = self.server.image_library if images else self.library
        route = url.path.replace("/api/images/", "/api/", 1) if images else url.path
        if self.command == "POST":
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host"):
                raise RequestError("请求来源无效", 403)
            length = int(self.headers.get("Content-Length", "0"))
            if self.headers.get_content_type() != "application/json" or not 0 < length <= 32768:
                raise RequestError("需要有效的 JSON 请求")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise RequestError("请求参数无效")
            if route == "/api/sources":
                return self.reply(200, library.add(body.get("path")))
            if route == "/api/sources/remove":
                return self.reply(200, library.remove(body.get("path")))
        elif route == "/api/status":
            return self.reply(200, library.status(joined=not images and query.get("joined") == "1"))
        elif url.path == "/api/revision" and getattr(self.server, "reload_token", None):
            return self.reply(200, {"revision": self.web_revision()})
        elif url.path == "/api/folders":
            return self.reply(200, self.library.browse(query.get("path", ""), max(0, int(query.get("offset", 0)))))
        elif url.path == "/api/images":
            return self.reply(200, self.server.image_library.video_page(
                int(query.get("anchor", 0)), query.get("dir") == "prev",
                int(query.get("source", 0)),
                offset=max(0, int(query.get("offset", 0)))))
        elif url.path == "/api/videos":
            return self.reply(200, self.library.video_page(int(query.get("anchor", 0)), query.get("dir") == "prev",
                                                        int(query.get("source", 0)),
                                                        with_duration=query.get("duration") == "1",
                                                        joined=query.get("joined") == "1",
                                                        group=int(query.get("group", 0)), clip=int(query.get("clip", 0))))
        elif match := re.fullmatch(r"/image/(\d+)", url.path):
            library = self.server.image_library
            return stream_file(self, library.media_path(int(match[1])), library.formats)
        elif match := re.fullmatch(r"/media/(\d+)/subtitles", url.path):
            path = self.library.media_path(int(match[1]))
            return self.reply(200, subtitle_page(path, self.library.transcoder, max(0, int(query.get("at", 0)))))
        elif match := re.fullmatch(r"/media/(\d+)/info", url.path):
            info = self.library.transcoder.info(self.library.media_path(int(match[1])))
            audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), {})
            return self.reply(200, {"audio": audio.get("codec_name"), "duration": info.get("format", {}).get("duration")})
        elif match := re.fullmatch(r"/media/(\d+)", url.path):
            path = self.library.media_path(int(match[1]))
            if query.get("compatible") in ("1", "audio"):
                return self.library.transcoder.stream(self, path, float(query.get("start", 0)), query["compatible"] == "audio")
            return stream_file(self, path)
        elif url.path in WEB_TYPES:
            path = WEB_DIR / (url.path[1:] or "index.html")
            revision = self.web_revision() if url.path == "/" else None
            content = path.read_bytes()
            if revision:
                meta = f'  <meta name="flow-revision" content="{revision}">\n</head>'
                content = content.replace(b"</head>", meta.encode(), 1)
            return self.reply(200, content, WEB_TYPES[url.path] + "; charset=utf-8")
        raise RequestError("找不到此内容", 404)
