import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

APP_DIR = Path(__file__).resolve().parent


def backend_revision():
    files = {}
    for path in (APP_DIR / "server.py", *(APP_DIR / "flow").rglob("*.py")):
        try:
            info = path.stat()
            files[path] = (info.st_mtime_ns, info.st_size)
        except FileNotFoundError:
            continue
    return files


def reload_on_change():
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    revision = backend_revision()
    env = dict(os.environ, FLOW_RELOAD_WORKER="1")
    # 每次从源码导入，避免短时间内等长修改命中旧字节码。
    with tempfile.TemporaryDirectory(prefix="flow-reload-") as cache:
        command = [sys.executable, "-B", "-X", f"pycache_prefix={cache}", str(APP_DIR / "server.py"), *sys.argv[1:]]
        print("Flow 热部署已启用", flush=True)
        while not stopping:
            worker = subprocess.Popen(command, env=env)
            try:
                while not stopping:
                    time.sleep(0.5)
                    if stopping:
                        break
                    current = backend_revision()
                    if current != revision:
                        revision = current
                        print("检测到后端代码更新，正在重启 Flow", flush=True)
                        break
            finally:
                if worker.poll() is None:
                    worker.terminate()
                    try:
                        worker.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        worker.kill()
                        worker.wait()


def main():
    parser = argparse.ArgumentParser(description="Flow 本地视频流")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=28888)
    parser.add_argument("--data", type=Path, default=APP_DIR / "data", help="索引的保存目录")
    parser.add_argument("--root", type=Path, action="append", help="限制可引入的目录，可重复指定")
    parser.add_argument("--reload", action="store_true", help="代码更新后自动重新加载")
    args = parser.parse_args()
    roots = [path.resolve() for path in args.root or []]
    if any(not path.is_dir() for path in roots):
        parser.error("--root 必须指向服务器可读取的现有目录")
    reload_worker = os.environ.get("FLOW_RELOAD_WORKER") == "1"
    if (args.reload or os.environ.get("FLOW_RELOAD") == "1") and not reload_worker:
        return reload_on_change()

    from flow.api import Handler
    from flow.library import Library

    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        server.reload_token = uuid4().hex if reload_worker else None
        server.library = Library(args.data.resolve(), roots)
        server.image_library = Library(args.data.resolve(), roots, images=True)
        print(f"Flow 已启动  http://{args.host}:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
    
