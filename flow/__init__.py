from pathlib import Path


APP_DIR = Path(__file__).resolve().parent.parent
FORMATS = {".mp4": "video/mp4", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
           ".avi": "video/x-msvideo", ".ts": "video/mp2t"}
IMAGE_FORMATS = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                 ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp"}


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status
