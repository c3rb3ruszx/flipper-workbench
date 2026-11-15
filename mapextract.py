"""Offline street maps for the Wardrive tab.

Cuts an area out of the public Protomaps daily build of OpenStreetMap (one huge .pmtiles file that is
meant to be read with HTTP range requests) and saves it as a small .pmtiles file on this computer.
Only the map area is requested; nothing about the user's logs is ever sent.

  plan(bbox, maxzoom)    -> how many tiles and bytes it would download (reads only the directories)
  extract(bbox, maxzoom, out, progress, cancel)
"""
from __future__ import annotations

import bisect
import gzip
import json
import math
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pmtiles.tile import (Compression, deserialize_directory, deserialize_header, tileid_to_zxy,
                          zxy_to_tileid)
from pmtiles.writer import Writer

BUILDS = "https://build-metadata.protomaps.dev/builds.json"
BUILD_URL = "https://build.protomaps.com/{key}"
UA = "FlipperWorkbench-maps/1"
MAX_ZOOM = 15                       # the build's own max zoom
LIMIT_BYTES = 2_000_000_000         # refuse anything bigger than this


class Cancelled(Exception):
    pass


def _get(url, start=None, length=None, timeout=60, on_bytes=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if start is not None:
        req.add_header("Range", f"bytes={start}-{start + length - 1}")
    for attempt in range(4):
        got = 0
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if on_bytes is None:
                    data = r.read()
                else:
                    parts = []
                    while True:
                        chunk = r.read(65536)
                        if not chunk:
                            break
                        parts.append(chunk)
                        got += len(chunk)
                        on_bytes(len(chunk))
                    data = b"".join(parts)
            if start is not None and len(data) != length:
                raise IOError(f"short read {len(data)} of {length}")
            return data
        except Cancelled:
            raise
        except Exception:  # noqa: BLE001
            if on_bytes and got:
                on_bytes(-got)          # this attempt's bytes will come again
            if attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))


def latest_build():
    """URL of the newest daily build."""
    builds = json.loads(_get(BUILDS, timeout=30))
    key = sorted(b["key"] for b in builds if b["key"].endswith(".pmtiles"))[-1]
    return BUILD_URL.format(key=key), key[:8]


def tiles_for(bbox, z):
    """Tile x/y range covering bbox (west, south, east, north) at zoom z."""
    w, s, e, n = bbox
    def tx(lon):
        return min(2 ** z - 1, max(0, int((lon + 180) / 360 * 2 ** z)))
    def ty(lat):
        lat = max(-85.0511, min(85.0511, lat))
        r = math.radians(lat)
        return min(2 ** z - 1, max(0, int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)))
    return tx(w), tx(e), ty(n), ty(s)


def wanted_ids(bbox, minzoom, maxzoom):
    ids = []
    for z in range(minzoom, maxzoom + 1):
        x0, x1, y0, y1 = tiles_for(bbox, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                ids.append(zxy_to_tileid(z, x, y))
    ids.sort()
    return ids


class Archive:
    """A remote .pmtiles read with range requests; directories are cached per run."""

    def __init__(self, url):
        self.url = url
        self.header = deserialize_header(_get(url, 0, 127))
        self.root = self._dir(self.header["root_offset"], self.header["root_length"])
        self.metadata = json.loads(self._decomp(_get(url, self.header["metadata_offset"], self.header["metadata_length"])))
        self._leaves = {}

    def _decomp(self, b):
        return gzip.decompress(b) if self.header["internal_compression"] == Compression.GZIP else b

    def _dir(self, offset, length):
        return deserialize_directory(_get(self.url, offset, length))

    def _leaf(self, entry):
        key = entry.offset
        if key not in self._leaves:
            self._leaves[key] = self._dir(self.header["leaf_directory_offset"] + entry.offset, entry.length)
        return self._leaves[key]

    def lookup(self, ids, cancel=None):
        """Entries (tile_id, data offset, length) for each wanted id that exists. Fetches only the leaf
        directories that cover the wanted ids."""
        found = []
        self._walk(self.root, ids, found, 0, cancel)
        return found

    def _walk(self, entries, ids, found, depth, cancel):
        if depth > 3 or not ids:
            return
        starts = [e.tile_id for e in entries]
        groups = {}
        for tid in ids:
            i = bisect.bisect_right(starts, tid) - 1
            if i < 0:
                continue
            groups.setdefault(i, []).append(tid)
        leaves = [entries[i] for i in groups if entries[i].run_length == 0 and entries[i].offset not in self._leaves]
        if len(leaves) > 1:
            with ThreadPoolExecutor(6) as ex:
                list(ex.map(self._leaf, leaves))
        for i, sub in groups.items():
            if cancel and cancel.is_set():
                raise Cancelled()
            e = entries[i]
            if e.run_length == 0:                       # a leaf directory covering these ids
                self._walk(self._leaf(e), sub, found, depth + 1, cancel)
            else:
                for tid in sub:
                    if tid < e.tile_id + e.run_length:
                        found.append((tid, e.offset, e.length))


def plan(bbox, maxzoom=MAX_ZOOM, minzoom=0, url=None, archive=None, cancel=None):
    arc = archive or Archive(url or latest_build()[0])
    found = arc.lookup(wanted_ids(bbox, minzoom, min(maxzoom, MAX_ZOOM)), cancel)
    uniq = {(o, n) for _, o, n in found}
    return {"tiles": len(found), "bytes": sum(n for _, n in uniq), "archive": arc, "found": found}


def _ranges(chunks, gap=32768, cap=1_000_000):
    """Merge (offset, length) chunks that sit close together into bigger range requests."""
    out = []
    for o, n in sorted(chunks):
        if out and o - (out[-1][0] + out[-1][1]) <= gap and (o + n) - out[-1][0] <= cap:
            out[-1][1] = max(out[-1][1], o + n - out[-1][0])
        else:
            out.append([o, n])
    return out


def extract(bbox, out_path, maxzoom=MAX_ZOOM, minzoom=0, progress=None, cancel=None, url=None, name=""):
    cancel = cancel or threading.Event()
    say = progress or (lambda *a: None)
    say("Finding the newest OpenStreetMap build", 0, 0)
    if not url:
        url, date = latest_build()
    else:
        date = ""
    arc = Archive(url)
    say("Reading the map index", 0, 0)
    p = plan(bbox, maxzoom, minzoom, archive=arc, cancel=cancel)
    found = p["found"]
    if not found:
        raise ValueError("No map data for that area")
    if p["bytes"] > LIMIT_BYTES:
        raise ValueError("That area is too big to download in one go. Zoom in or pick a smaller area.")
    base = arc.header["tile_data_offset"]
    chunks = {(o, n) for _, o, n in found}
    ranges = _ranges(chunks)
    data = {}
    lock = threading.Lock()
    done = [0]
    total = sum(n for _, n in ranges)

    def tick(k):
        if cancel.is_set():
            raise Cancelled()
        with lock:
            done[0] += k
        say("Downloading map tiles", done[0], total)

    def fetch(r):
        if cancel.is_set():
            raise Cancelled()
        o, n = r
        blob = _get(url, base + o, n, on_bytes=tick)
        with lock:
            data[o] = blob

    with ThreadPoolExecutor(6) as ex:
        for f in [ex.submit(fetch, r) for r in ranges]:
            f.result()
    if cancel.is_set():
        raise Cancelled()
    starts = sorted(data)

    def piece(o, n):
        i = bisect.bisect_right(starts, o) - 1
        s = starts[i]
        return data[s][o - s:o - s + n]

    say("Saving the map", total, total)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".part")
    with open(tmp, "wb") as f:
        w = Writer(f)
        for tid, o, n in sorted(found):
            w.write_tile(tid, piece(o, n))
        h = arc.header
        west, south, east, north = bbox
        zs = sorted({tileid_to_zxy(t)[0] for t, _, _ in found})
        meta = dict(arc.metadata)
        meta["name"] = name or "Workbench map"
        meta["description"] = f"Cut from the Protomaps OpenStreetMap build {date}".strip()
        header = {
            "tile_compression": h["tile_compression"], "tile_type": h["tile_type"],
            "min_lon_e7": int(west * 1e7), "min_lat_e7": int(south * 1e7),
            "max_lon_e7": int(east * 1e7), "max_lat_e7": int(north * 1e7),
            "center_zoom": max(zs[0], min(zs[-1], 12)),
            "center_lon_e7": int((west + east) / 2 * 1e7), "center_lat_e7": int((south + north) / 2 * 1e7),
        }
        w.finalize(header, meta)
    tmp.replace(out_path)
    return {"path": str(out_path), "tiles": len(found), "bytes": out_path.stat().st_size, "date": date}


def info(path):
    """Header facts of a local .pmtiles file, or raises if it is not one we can draw."""
    with open(path, "rb") as f:
        h = deserialize_header(f.read(127))
        f.seek(h["metadata_offset"])
        raw = f.read(h["metadata_length"])
    meta = json.loads(gzip.decompress(raw) if h["internal_compression"] == Compression.GZIP else raw)
    if h["tile_type"].value != 1:
        raise ValueError("Only vector OpenStreetMap maps (.pmtiles from Protomaps) are supported")
    return {
        "bounds": [h["min_lon_e7"] / 1e7, h["min_lat_e7"] / 1e7, h["max_lon_e7"] / 1e7, h["max_lat_e7"] / 1e7],
        "minzoom": h["min_zoom"], "maxzoom": h["max_zoom"], "name": meta.get("name", ""),
        "layers": [l.get("id") for l in meta.get("vector_layers", [])],
    }


# ====================================================================== local server for the page

class MapServer:
    """Serves map files to the page over 127.0.0.1 with HTTP range requests (what the PMTiles reader needs).
    Only files named <id>.pmtiles in the given folders can be read."""

    def __init__(self, folders):
        import http.server
        import re as _re
        import socketserver

        self.folders = [Path(f) for f in folders]
        server = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _cors(self):
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "Range, If-Match")
                self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag, Accept-Ranges")

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.end_headers()

            def do_HEAD(self):
                self.do_GET(head=True)

            def do_GET(self, head=False):
                m = _re.fullmatch(r"/m/([A-Za-z0-9_\-]{1,80})\.pmtiles", self.path.split("?")[0])
                path = server.find(m.group(1)) if m else None
                if not path:
                    self.send_response(404)
                    self._cors()
                    self.end_headers()
                    return
                size = path.stat().st_size
                etag = f'"{int(path.stat().st_mtime)}-{size}"'
                rng = self.headers.get("Range")
                start, end = 0, size - 1
                if rng:
                    r = _re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
                    if not r:
                        self.send_response(416)
                        self._cors()
                        self.end_headers()
                        return
                    if r.group(1):
                        start = int(r.group(1))
                        end = min(int(r.group(2)), size - 1) if r.group(2) else size - 1
                    else:
                        start = max(0, size - int(r.group(2)))
                    if start > end:
                        self.send_response(416)
                        self._cors()
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                self.send_response(206 if rng else 200)
                self._cors()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(end - start + 1))
                if rng:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if head:
                    return
                with open(path, "rb") as f:
                    f.seek(start)
                    left = end - start + 1
                    while left > 0:
                        chunk = f.read(min(left, 1 << 20))
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                            return
                        left -= len(chunk)

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        self.httpd = S(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def find(self, mid):
        for d in self.folders:
            p = d / f"{mid}.pmtiles"
            if p.is_file():
                return p
        return None

    def url(self, mid):
        return f"http://127.0.0.1:{self.port}/m/{mid}.pmtiles"
