import json
import math
import os
import re
import shutil
import subprocess
import threading
from functools import lru_cache
from html import unescape

from . import APP_DIR, FORMATS, RequestError


DEMUXERS = {".mp4": "mov", ".mkv": "matroska", ".mov": "mov", ".avi": "avi", ".ts": "mpegts"}


@lru_cache(maxsize=256)
def probe_streams(ffprobe, path, modified_ns, size):
    result = subprocess.run(
        [ffprobe, "-v", "quiet", "-protocol_whitelist", "file,pipe", "-f", DEMUXERS[path.suffix.lower()],
         "-show_entries", "format=duration:stream=index,codec_type,codec_name,pix_fmt:stream_tags=language,title:stream_disposition=default",
         "-of", "json", str(path)], stdout=subprocess.PIPE, timeout=8, check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return json.loads(result.stdout)


@lru_cache(maxsize=4096)
def probe_duration(ffprobe, path, modified_ns, size):
    result = subprocess.run(
        [ffprobe, "-v", "quiet", "-protocol_whitelist", "file,pipe", "-f", DEMUXERS[path.suffix.lower()],
         "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        stdout=subprocess.PIPE, timeout=8, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    duration = float(result.stdout.strip())
    return duration if math.isfinite(duration) and duration > 0 else None


def stream_file(request, path, formats=FORMATS):
    with path.open("rb") as file:
        size = os.fstat(file.fileno()).st_size
        start, end = 0, size - 1
        requested = request.headers.get("Range")
        if requested:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested.strip())
            if match and any(match.groups()):
                left, right = match.groups()
                start = int(left) if left else max(0, size - int(right))
                end = min(end, int(right)) if left and right else end
            else:
                start = size
            if start > end or start >= size:
                request.send_response(416)
                request.send_header("Content-Range", f"bytes */{size}")
                request.send_header("Content-Length", "0")
                request.end_headers()
                return
        request.send_response(206 if requested else 200)
        request.send_header("Content-Type", formats[path.suffix.lower()])
        request.send_header("Accept-Ranges", "bytes")
        request.send_header("Content-Length", str(end - start + 1))
        if requested:
            request.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        request.end_headers()
        if request.command == "HEAD":
            return
        file.seek(start)
        remaining = end - start + 1
        while remaining:
            data = file.read(min(256 * 1024, remaining))
            if not data:
                break
            request.wfile.write(data)
            remaining -= len(data)


def media_tool(name):
    if os.name == "nt":
        bundled = APP_DIR / "vendor" / "ffmpeg" / "windows" / (name + ".exe")
        if bundled.is_file():
            return str(bundled)
    return shutil.which(name)


class Transcoder:
    def __init__(self):
        self.ffmpeg = media_tool("ffmpeg")
        self.ffprobe = media_tool("ffprobe")
        self.slots = threading.BoundedSemaphore(2)
        self.duration_slots = threading.BoundedSemaphore(2)

    def duration(self, path):
        if not self.ffprobe:
            return None
        try:
            info = path.stat()
            with self.duration_slots:
                return probe_duration(self.ffprobe, path, info.st_mtime_ns, info.st_size)
        except (OSError, ValueError, subprocess.SubprocessError):
            return None

    def info(self, path):
        if self.ffprobe:
            try:
                info = path.stat()
                return probe_streams(self.ffprobe, path, info.st_mtime_ns, info.st_size)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        return {}

    def codecs(self, path, demuxer, allow_copy=True, audio_only=False):
        video_args = ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                      "-threads", "2", "-preset", "veryfast", "-g", "30"]
        audio_args = ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]
        if allow_copy or audio_only:
            streams = self.info(path).get("streams", [])
            video = next((s for s in streams if s.get("codec_type") == "video"), {})
            audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
            if audio_only and video.get("codec_name") in ("hevc", "h264"):
                video_args = ["-c:v", "copy"]
                if video["codec_name"] == "hevc":
                    video_args += ["-tag:v", "hvc1"]
            elif allow_copy and video.get("codec_name") == "h264" and video.get("pix_fmt") in ("yuv420p", "yuvj420p"):
                video_args = ["-c:v", "copy"]
            if not audio_only and allow_copy and audio.get("codec_name") == "aac":
                audio_args = ["-c:a", "copy"]
                if demuxer == "mpegts":
                    audio_args += ["-bsf:a", "aac_adtstoasc"]
        return video_args + audio_args

    def stream(self, request, path, start=0, audio_only=False):
        if not math.isfinite(start) or start < 0:
            raise RequestError("播放起点无效")
        if not self.ffmpeg:
            raise RequestError("兼容播放工具 FFmpeg 不可用，请检查服务端安装", 503)
        if not self.slots.acquire(blocking=False):
            raise RequestError("兼容播放器正忙，请稍后重试", 503)
        try:
            demuxer = DEMUXERS[path.suffix.lower()]
            seek = ["-ss", f"{start:.3f}"] if start else []
            command = [self.ffmpeg, "-nostdin", "-loglevel", "quiet", "-protocol_whitelist", "file,pipe",
                       "-fflags", "+genpts", "-f", demuxer, "-threads", "2", *seek, "-i", str(path), "-map", "0:v:0",
                       "-map", "0:a:0?", *self.codecs(path, demuxer, allow_copy=not start, audio_only=audio_only), "-movflags",
                       "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", "-f", "mp4", "pipe:1"]
            request.send_response(200)
            request.send_header("Content-Type", "video/mp4")
            request.send_header("Cache-Control", "no-store")
            request.end_headers()
            if request.command == "HEAD":
                return
            with subprocess.Popen(command, stdout=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as proc:
                try:
                    request.connection.settimeout(30)
                    shutil.copyfileobj(proc.stdout, request.wfile, length=64 * 1024)
                finally:
                    proc.kill()
                    proc.stdout.close()
        finally:
            self.slots.release()


SUBTITLE_FORMATS = {".vtt", ".srt", ".ass", ".ssa"}
TEXT_CODECS = {"subrip", "ass", "ssa", "webvtt", "mov_text", "text"}
CHINESE = re.compile(r"(?:^|[._\s-])(?:zh|zho|chi|chs|cht|cmn|chinese)(?:$|[._\s-])|中文|简体|繁体|简中|繁中", re.I)
TIMESTAMP = r"(?:\d+:)?\d{2}:\d{2}[.,]\d{3}"
TIMING = re.compile(rf"({TIMESTAMP})\s+-->\s+({TIMESTAMP})(?:\s+.*)?")


def subtitle_seconds(timestamp):
    value = 0
    for part in timestamp.replace(",", ".").split(":"):
        value = value * 60 + float(part)
    return value


def parse_cues(text, offset=0):
    cues = []
    for block in re.split(r"\n[ \t]*\n", text.replace("\r\n", "\n").replace("\r", "\n").strip()):
        lines = block.splitlines()
        for i, line in enumerate(lines[:2]):
            timing = TIMING.fullmatch(line.strip())
            if timing:
                body = "\n".join(lines[i + 1:])
                body = re.sub(r"<br\s*/?>", "\n", body, flags=re.I)
                body = unescape(re.sub(r"<[^>\n]+>|\{\\[^}\n]*\}", "", body)).strip()
                if body:
                    cues.append((subtitle_seconds(timing[1]) + offset, subtitle_seconds(timing[2]) + offset, body))
                break
    return cues


def matching_sidecars(video):
    stem = video.stem.casefold()
    matches = []
    for path in video.parent.iterdir():
        if path.suffix.lower() not in SUBTITLE_FORMATS:
            continue
        name = path.stem.casefold()
        tag = name[len(stem):]
        if not name.startswith(stem) or (tag and not tag.startswith((".", "-", "_", " "))):
            continue
        if path.resolve() == path and path.is_file():
            matches.append((not bool(CHINESE.search(tag)), bool(tag), name, path))
    return [match[-1] for match in sorted(matches)]


def run_subtitle_tool(command, *, data=None, timeout=10):
    return subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          check=True, timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout


def sidecar_cues(path, ffmpeg):
    with path.open("rb") as file:
        data = file.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        return []
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = data.decode("utf-16")
    else:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("gb18030")
    if path.suffix.lower() in (".ass", ".ssa"):
        if not ffmpeg:
            return []
        text = run_subtitle_tool([ffmpeg, "-v", "error", "-protocol_whitelist", "pipe", "-f", "ass", "-i", "pipe:0",
                         "-f", "srt", "pipe:1"], data=text.encode()).decode("utf-8")
    return parse_cues(text)


def embedded_track(streams):
    tracks = []
    for stream in streams:
        if stream.get("codec_type") == "subtitle" and stream.get("codec_name") in TEXT_CODECS:
            tags = stream.get("tags", {})
            label = tags.get("language", "") + " " + tags.get("title", "")
            tracks.append((not bool(CHINESE.search(label)), not stream.get("disposition", {}).get("default"),
                           stream["index"]))
    return min(tracks)[-1] if tracks else None


def subtitle_page(video, transcoder, position):
    for path in matching_sidecars(video):
        try:
            cues = sidecar_cues(path, transcoder.ffmpeg)
        except (OSError, UnicodeError, subprocess.SubprocessError):
            continue
        if cues:
            return {"start": 0, "end": None, "cues": cues}
    if transcoder.ffmpeg and transcoder.ffprobe:
        track = embedded_track(transcoder.info(video).get("streams", []))
        if track is not None:
            # Read a short window from the NAS, including cues crossing its start.
            start = position // 60 * 60
            seek = max(0, start - 10)
            duration = start + 60 - seek
            output = run_subtitle_tool([transcoder.ffmpeg, "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                               "-f", DEMUXERS[video.suffix.lower()], "-ss", str(seek), "-t", str(duration),
                               "-i", str(video), "-map", f"0:{track}", "-t", str(duration), "-f", "srt", "pipe:1"],
                              timeout=20)
            return {"start": start, "end": start + 60, "cues": parse_cues(output.decode("utf-8"), seek)}
    return {"start": 0, "end": None, "cues": []}
