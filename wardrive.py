"""Wardrive tab: import wardriving logs, keep them in one local SQLite database, and hand the UI what it
needs to draw and analyse them on an offline map. Nothing here talks to the internet.

Reads: WiGLE CSV (WigleWifi-1.x: Marauder, the Flipper wardriver apps, WiGLE's Android app, most tools),
WiGLE-style rows mixed into console logs, Kismet .kismet databases, GPX, KML and NMEA GPS logs.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import math
import re
import sqlite3
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

MAX_FILE = 300 * 1024 * 1024
LOG_EXT = {".csv", ".log", ".txt", ".kml", ".gpx", ".nmea", ".kismet", ".wiglecsv", ".pcap", ".pcapng", ".cap"}
MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
KINDS = ("wifi", "ble", "bt", "cell")
SECS = ("open", "wep", "wpa", "wpa2", "wpa3", "ent", "none")   # "none" = not WiFi


class WardriveError(Exception):
    pass


# ====================================================================== small helpers

def haversine(a_lat, a_lon, b_lat, b_lon):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def security(auth, kind="wifi"):
    """Normalise WiGLE / Marauder / Kismet auth strings to one class."""
    if kind != "wifi":
        return "none"
    a = (auth or "").upper().replace("_", "-")
    if not a.strip():
        return "open"
    if "SAE" in a or "WPA3" in a or "OWE" in a:
        return "wpa3"
    if "EAP" in a or "ENTERPRISE" in a or "802.1X" in a or "MGT" in a:
        return "ent"
    if "WPA2" in a or "RSN" in a:
        return "wpa2"
    if "WPA" in a:
        return "wpa"
    if "WEP" in a:
        return "wep"
    return "open"   # [ESS], [OPEN], None and anything else without a cipher


def band(channel, freq):
    try:
        f = int(freq or 0)
    except ValueError:
        f = 0
    if f:
        if 2400 <= f < 2500:
            return "2.4"
        if 4900 <= f < 5900:
            return "5"
        if 5925 <= f <= 7125:
            return "6"
    try:
        c = int(channel or 0)
    except ValueError:
        return ""
    if 1 <= c <= 14:
        return "2.4"
    if 32 <= c <= 177:
        return "5"
    return ""


_OUI = None


def maker(mac, kind):
    global _OUI
    if kind not in ("wifi", "ble", "bt") or not MAC_RE.match(mac or ""):
        return ""
    first = int(mac[0:2], 16)
    if first & 0x02:
        return "Random address"
    if _OUI is None:
        _OUI = {}
        for base in (Path(__file__).resolve().parent, Path(getattr(__import__("sys"), "_MEIPASS", ".")),):
            p = base / "assets" / "oui.tsv.gz"
            if p.exists():
                with gzip.open(p, "rt", encoding="utf-8") as f:
                    for line in f:
                        k, _, v = line.rstrip("\n").partition("\t")
                        _OUI[k] = v
                break
    return _OUI.get(mac.replace(":", "").replace("-", "")[:6].upper(), "")


def _num(v, cast=float, default=None):
    try:
        return cast(v)
    except (TypeError, ValueError):
        return default


def _time(s):
    """WiGLE writes local 'YYYY-MM-DD HH:MM:SS'; keep it as text and also give a sortable number."""
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    if s.isdigit():   # epoch seconds or ms
        n = int(s) / (1000 if len(s) > 11 else 1)
        return datetime.fromtimestamp(n, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return ""


def _good(lat, lon):
    return lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 and not (abs(lat) < 1e-6 and abs(lon) < 1e-6)


# ====================================================================== parsers -> {"rows": [...], "track": [...], "app": str, "fmt": str}

def _kind(t):
    t = (t or "WIFI").strip().upper()
    if t in ("WIFI", "WI-FI", "WLAN", ""):
        return "wifi"
    if t == "BLE":
        return "ble"
    if t in ("BT", "BLUETOOTH"):
        return "bt"
    return "cell"


def _wigle_row(r):
    mac = (r.get("MAC") or r.get("BSSID") or r.get("Netid") or "").strip()
    lat = _num(r.get("CurrentLatitude") or r.get("Latitude") or r.get("trilat"))
    lon = _num(r.get("CurrentLongitude") or r.get("Longitude") or r.get("trilong"))
    if not mac or not _good(lat, lon):
        return None
    kind = _kind(r.get("Type"))
    if kind != "cell":
        mac = mac.upper().replace("-", ":")
        if not MAC_RE.match(mac):
            return None
    return {
        "mac": mac, "kind": kind, "ssid": (r.get("SSID") or "").strip()[:64], "auth": (r.get("AuthMode") or r.get("Encryption") or "").strip()[:80],
        "t": _time(r.get("FirstSeen") or r.get("Time") or r.get("lasttime")), "channel": _num(r.get("Channel"), int, 0) or 0,
        "freq": _num(r.get("Frequency"), int, 0) or 0, "rssi": _num(r.get("RSSI") or r.get("Signal"), int, None),
        "lat": lat, "lon": lon, "alt": _num(r.get("AltitudeMeters")), "acc": _num(r.get("AccuracyMeters")),
    }


WIGLE_COLS = ["MAC", "SSID", "AuthMode", "FirstSeen", "Channel", "RSSI", "CurrentLatitude", "CurrentLongitude",
              "AltitudeMeters", "AccuracyMeters", "Type"]


def parse_wigle(text):
    lines = text.splitlines()
    app = ""
    head_i = None
    for i, line in enumerate(lines[:40]):
        if line.startswith("WigleWifi"):
            kv = dict(p.split("=", 1) for p in line.split(",")[1:] if "=" in p)
            app = " ".join(x for x in (kv.get("appRelease", ""), kv.get("device", "") or kv.get("model", "")) if x).strip()
        if re.match(r"^\s*(MAC|BSSID)\s*,", line, re.I):
            head_i = i
            break
    rows, cand = [], 0
    if head_i is not None:
        reader = csv.DictReader(io.StringIO("\n".join(lines[head_i:])))
        reader.fieldnames = [f.strip() for f in reader.fieldnames]
        for r in reader:
            cand += 1 if MAC_RE.match((r.get("MAC") or r.get("BSSID") or "").strip()) else 0
            w = _wigle_row(r)
            if w:
                rows.append(w)
        fmt = "WiGLE CSV"
    else:
        # console logs (e.g. a Marauder session saved by the Flipper app): pick out WiGLE-shaped lines
        for line in lines:
            parts = next(csv.reader([line.strip()]), [])
            if len(parts) >= 8 and MAC_RE.match(parts[0].strip()):
                cand += 1
                w = _wigle_row(dict(zip(WIGLE_COLS, parts)))
                if w:
                    rows.append(w)
        fmt = "WiGLE rows in a log"
    return {"rows": rows, "track": [], "app": app, "fmt": fmt, "logged": cand,
            "no_gps_module": "GPS Not Found" in text[:20000]}


def _nmea_deg(v, hemi):
    if not v:
        return None
    try:
        d = float(v)
    except ValueError:
        return None
    deg = int(d // 100)
    val = deg + (d - deg * 100) / 60
    return -val if hemi in ("S", "W") else val


def _nmea_time(date, hms):
    if not date or len(date) != 6 or len(hms) < 6:
        return ""
    yy = int(date[4:6])
    return f"{2000 + yy if yy < 80 else 1900 + yy}-{date[2:4]}-{date[0:2]} {hms[0:2]}:{hms[2:4]}:{hms[4:6]}"


def parse_nmea(text):
    track, date = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("$") or len(line) < 10:
            continue
        p = line.split("*")[0].split(",")
        tag = p[0][3:]
        try:
            if tag == "RMC" and len(p) >= 10 and p[2] == "A":
                date = p[9]
                lat, lon = _nmea_deg(p[3], p[4]), _nmea_deg(p[5], p[6])
                t = _nmea_time(date, p[1])
                if _good(lat, lon):
                    track.append((t, lat, lon))
            elif tag == "GGA" and len(p) >= 7 and p[6] not in ("", "0"):
                lat, lon = _nmea_deg(p[2], p[3]), _nmea_deg(p[4], p[5])
                t = _nmea_time(date, p[1])
                if _good(lat, lon):
                    track.append((t, lat, lon))
        except (IndexError, ValueError):
            continue
    return {"rows": [], "track": track, "app": "", "fmt": "NMEA GPS log"}


def _strip_ns(root):
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def parse_gpx(text):
    root = _strip_ns(ET.fromstring(text))
    track = []
    for pt in list(root.iter("trkpt")) + list(root.iter("rtept")):
        lat, lon = _num(pt.get("lat")), _num(pt.get("lon"))
        if _good(lat, lon):
            t = pt.findtext("time") or ""
            track.append((_time(t.replace("Z", "").split(".")[0].replace("T", " ")), lat, lon))
    return {"rows": [], "track": track, "app": "", "fmt": "GPX"}


def parse_kml(text):
    """WiGLE's KML exports put one network per Placemark; other KML gives us routes."""
    root = _strip_ns(ET.fromstring(text))
    rows, track = [], []
    for pm in root.iter("Placemark"):
        name = (pm.findtext("name") or "").strip()
        desc = re.sub(r"<[^>]+>", "\n", pm.findtext("description") or "")
        pt = pm.find(".//Point/coordinates")
        if pt is not None and pt.text:
            c = pt.text.strip().split(",")
            lon, lat = _num(c[0]), _num(c[1]) if len(c) > 1 else None
            m = re.search(r"(([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2})", desc + " " + name)
            if m and _good(lat, lon):
                kind = "ble" if re.search(r"\bBLE\b|Bluetooth LE", desc) else ("bt" if "Bluetooth" in desc else "wifi")
                def grab(label):
                    g = re.search(label + r"\s*[:=]\s*([^\n]+)", desc, re.I)
                    return g.group(1).strip() if g else ""
                rows.append({"mac": m.group(1).upper().replace("-", ":"), "kind": kind,
                             "ssid": (grab("SSID|Network Name") or name)[:64], "auth": grab("Encryption|Capabilities|AuthMode"),
                             "t": _time(grab("Time|First Seen|Last Seen")), "channel": _num(grab("Channel"), int, 0) or 0,
                             "freq": _num(re.sub(r"\D", "", grab("Frequency")), int, 0) or 0,
                             "rssi": _num(re.sub(r"[^\d-]", "", grab("Signal|RSSI")), int, None),
                             "lat": lat, "lon": lon, "alt": None, "acc": None})
        for ls in pm.iter("LineString"):
            for c in (ls.findtext("coordinates") or "").split():
                xy = c.split(",")
                if len(xy) >= 2 and _good(_num(xy[1]), _num(xy[0])):
                    track.append(("", float(xy[1]), float(xy[0])))
    return {"rows": rows, "track": track, "app": "", "fmt": "KML"}


def parse_kismet(path):
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    try:
        rows, track = [], []
        cur = con.execute("SELECT phyname, devmac, strongest_signal, avg_lat, avg_lon, first_time, last_time, device FROM devices")
        for phy, mac, sig, lat, lon, t0, t1, blob in cur:
            if not _good(lat, lon):
                continue
            try:
                d = json.loads(blob)
            except (TypeError, ValueError):
                d = {}
            typ = str(d.get("kismet.device.base.type", ""))
            phy = (phy or "").lower()
            if "802.11" in phy:
                if "AP" not in typ:
                    continue
                kind = "wifi"
            elif "btle" in phy:
                kind = "ble"
            elif "bluetooth" in phy:
                kind = "bt"
            else:
                continue
            freq = _num(d.get("kismet.device.base.frequency"), float, 0) or 0
            rows.append({"mac": (mac or "").upper(), "kind": kind, "ssid": str(d.get("kismet.device.base.commonname") or d.get("kismet.device.base.name") or "")[:64],
                         "auth": str(d.get("kismet.device.base.crypt", "")), "t": _time(str(t0 or "")),
                         "channel": _num(d.get("kismet.device.base.channel"), int, 0) or 0, "freq": int(freq / 1000) if freq > 100000 else int(freq),
                         "rssi": sig if sig and sig < 0 else None, "lat": lat, "lon": lon, "alt": None, "acc": None})
        try:
            for ts, lat, lon in con.execute("SELECT ts_sec, lat, lon FROM packets WHERE lat != 0 GROUP BY ts_sec ORDER BY ts_sec LIMIT 200000"):
                if _good(lat, lon):
                    track.append((_time(str(ts)), lat, lon))
        except sqlite3.Error:
            pass
        return {"rows": [r for r in rows if MAC_RE.match(r["mac"])], "track": track, "app": "Kismet", "fmt": "Kismet"}
    finally:
        con.close()


# ====================================================================== packet captures: link handshakes to networks
# This reads 802.11 headers only to attribute each captured WPA handshake (EAPOL-Key frames) to the access point it
# belongs to, so a capture with many handshakes can be split and filed per network and viewed offline. It does not
# crack, derive, or test keys and stores no passphrase material; the "message numbers" are just how complete each
# four-way handshake is (M1 pairs with M2, M3 with M4).

PCAP_EXT = {".pcap", ".pcapng", ".cap"}
PCAP_MAGIC = (b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4", b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d", b"\x0a\x0d\x0d\x0a")


def _mac(b):
    return ":".join(f"{x:02X}" for x in b)


_BCAST = {"FF:FF:FF:FF:FF:FF", "00:00:00:00:00:00"}


def _dot11_offset(frame, dlt):
    """Start of the 802.11 MAC header inside a link-layer frame (skips any radio header)."""
    if dlt == 105:                                   # bare 802.11
        return 0
    if dlt in (127, 192):                            # radiotap / PPI: 2-byte length at offset 2
        return int.from_bytes(frame[2:4], "little") if len(frame) >= 4 else None
    if dlt == 119:                                   # prism: 4-byte length at offset 4
        return int.from_bytes(frame[4:8], "little") if len(frame) >= 8 else None
    if dlt == 163:                                   # AVS: 4-byte length at offset 4, big-endian
        return int.from_bytes(frame[4:8], "big") if len(frame) >= 8 else None
    return None


def _eapol_msg(key_info):
    """Which of the four handshake messages this EAPOL-Key frame is, from its Key Information flags."""
    ack, mic = key_info & 0x0080, key_info & 0x0100
    install, secure = key_info & 0x0040, key_info & 0x0200
    if ack and not mic:
        return 1
    if mic and ack and install:
        return 3
    if mic and secure and not ack:
        return 4
    if mic and not ack:
        return 2
    return 0


def _pmkid_in(eapol):
    """True if this EAPOL-Key frame's key data carries a non-zero RSN PMKID (KDE OUI 00-0F-AC type 4).
    Only presence is read, for sorting; the value itself is not extracted or used."""
    if len(eapol) < 99:
        return False
    kdl = int.from_bytes(eapol[97:99], "big")
    kd = eapol[99:99 + kdl] if kdl else eapol[99:]
    i = 0
    while i + 2 <= len(kd):
        if kd[i] == 0xDD:
            ln = kd[i + 1]
            el = kd[i + 2:i + 2 + ln]
            if len(el) >= 20 and el[:4] == b"\x00\x0f\xac\x04" and any(el[4:20]):
                return True
            i += 2 + ln
        else:
            break
    j = kd.find(b"\x00\x0f\xac\x04")
    return j >= 0 and len(kd) >= j + 20 and any(kd[j + 4:j + 20])


def _beacon_ssid(body):
    """SSID tag (0) out of a beacon / probe-response body (12 fixed bytes, then tagged params)."""
    i = 12
    while i + 2 <= len(body):
        tag, ln = body[i], body[i + 1]
        if tag == 0:
            try:
                return body[i + 2:i + 2 + ln].decode("utf-8", "strict")[:64]
            except UnicodeDecodeError:
                return ""
        i += 2 + ln
    return ""


def _dot11(frame, ts, groups, names):
    if len(frame) < 10:
        return
    fc0, fc1 = frame[0], frame[1]
    ftype, subtype = (fc0 >> 2) & 0x3, (fc0 >> 4) & 0xF
    to_ds, from_ds = fc1 & 0x01, fc1 & 0x02
    a1 = _mac(frame[4:10])
    a2 = _mac(frame[10:16]) if len(frame) >= 16 else ""
    a3 = _mac(frame[16:22]) if len(frame) >= 22 else ""
    if ftype == 0 and subtype in (5, 8):             # probe response / beacon -> remember the network name
        ssid = _beacon_ssid(frame[24:])
        if ssid and not names.get(a3):
            names[a3] = ssid
        return
    if ftype != 2:                                   # only data frames carry EAPOL
        return
    if to_ds and not from_ds:
        bssid, client = a1, a2
    elif from_ds and not to_ds:
        bssid, client = a2, a1
    elif not to_ds and not from_ds:
        bssid, client = a3, a2
    else:
        return                                       # WDS (4-address) frames: no single AP/client pair
    off = 24 + (6 if (to_ds and from_ds) else 0) + (2 if subtype & 0x08 else 0)
    body = frame[off:]
    if len(body) < 8 or body[:6] != b"\xaa\xaa\x03\x00\x00\x00" or body[6:8] != b"\x88\x8e":
        return                                       # not EAPOL (ethertype 0x888E over LLC/SNAP)
    eapol = body[8:]
    if len(eapol) < 7 or eapol[1] != 3:              # EAPOL-Key
        return
    if bssid in _BCAST or not MAC_RE.match(bssid):
        return
    msg = _eapol_msg(int.from_bytes(eapol[5:7], "big"))
    if not msg:
        return
    g = groups.get((bssid, client))
    if g is None:
        g = groups[(bssid, client)] = {"bssid": bssid, "client": client, "msgs": set(), "t": ts, "frames": [], "pkts": 0, "pmkid": False}
    g["msgs"].add(msg)
    g["pkts"] += 1
    if msg == 1 and _pmkid_in(eapol):
        g["pmkid"] = True
    if not g["t"]:
        g["t"] = ts
    if len(g["frames"]) < 40:
        g["frames"].append(bytes(frame))


def _iter_pcap(data):
    """Yield (timestamp, linktype, 802.11-or-link frame) for classic pcap and pcapng files."""
    magic = data[:4]
    if magic in (b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4", b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d"):
        le = magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1")
        en = "little" if le else "big"
        nano = magic in (b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d")
        dlt = int.from_bytes(data[20:24], en)
        off, n = 24, len(data)
        while off + 16 <= n:
            ts_sec = int.from_bytes(data[off:off + 4], en)
            ts_sub = int.from_bytes(data[off + 4:off + 8], en)
            incl = int.from_bytes(data[off + 8:off + 12], en)
            off += 16
            if incl <= 0 or incl > 262144 or off + incl > n:
                break
            yield ts_sec + ts_sub / (1e9 if nano else 1e6), dlt, data[off:off + incl]
            off += incl
    elif magic == b"\x0a\x0d\x0d\x0a":
        yield from _iter_pcapng(data)


def _iter_pcapng(data):
    off, n = 0, len(data)
    en = "little"
    linktypes, iface = {}, 0
    while off + 12 <= n:
        btype = int.from_bytes(data[off:off + 4], en)
        if btype == 0x0A0D0D0A:
            en = "little" if data[off + 8:off + 12] == b"\x4d\x3c\x2b\x1a" else "big"
        blen = int.from_bytes(data[off + 4:off + 8], en)
        if blen < 12 or off + blen > n:
            break
        body = data[off + 8:off + blen - 4]
        if btype == 0x00000001 and len(body) >= 2:               # interface description
            linktypes[iface] = int.from_bytes(body[0:2], en)
            iface += 1
        elif btype == 0x00000006 and len(body) >= 20:            # enhanced packet
            ifid = int.from_bytes(body[0:4], en)
            ts = ((int.from_bytes(body[4:8], en) << 32) | int.from_bytes(body[8:12], en)) / 1e6
            caplen = int.from_bytes(body[12:16], en)
            yield ts, linktypes.get(ifid, 127), body[20:20 + caplen]
        elif btype == 0x00000003 and len(body) >= 4:             # simple packet
            caplen = int.from_bytes(body[0:4], en)
            yield 0.0, linktypes.get(0, 127), body[4:4 + caplen]
        off += blen


def _epoch(ts):
    try:
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if ts else ""
    except (OverflowError, OSError, ValueError):
        return ""


def parse_pcap(data):
    """Group the EAPOL handshakes in a capture by the access point they belong to."""
    groups, names = {}, {}
    seen = 0
    for ts, dlt, frame in _iter_pcap(data):
        seen += 1
        if seen > 5_000_000:
            break
        hoff = _dot11_offset(frame, dlt)
        if hoff is None or hoff >= len(frame):
            continue
        _dot11(frame[hoff:], ts, groups, names)
    shakes = []
    for (bssid, client), g in groups.items():
        msgs = sorted(g["msgs"])
        shakes.append({"bssid": bssid, "client": client, "ssid": names.get(bssid, ""), "msgs": msgs,
                       "complete": 1 if (1 in msgs and 2 in msgs) else 0, "pmkid": 1 if g["pmkid"] else 0,
                       "t": _epoch(g["t"]), "pkts": g["pkts"], "frames": g["frames"]})
    shakes.sort(key=lambda s: (-(s["complete"] or s["pmkid"]), -s["complete"], s["bssid"]))
    return {"rows": [], "track": [], "app": "", "fmt": "Packet capture", "shakes": shakes}


def _pcap_bytes(frames):
    """Wrap raw 802.11 frames (one handshake) back into a small standalone .pcap (link type 105)."""
    import struct
    out = bytearray(struct.pack("<IHHiIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, 105))
    for f in frames:
        out += struct.pack("<IIII", 0, 0, len(f), len(f)) + f
    return bytes(out)


def parse_file(name, data):
    """Pick a parser by content first, then by extension."""
    ext = Path(name).suffix.lower()
    if data[:4] in PCAP_MAGIC:
        return parse_pcap(data)
    if data[:16].startswith(b"SQLite format 3"):
        with tempfile.NamedTemporaryFile(suffix=".kismet", delete=False) as f:
            f.write(data)
            tmp = f.name
        try:
            return parse_kismet(tmp)
        except sqlite3.Error as e:
            raise WardriveError(f"Couldn't read that Kismet file: {e}")
        finally:
            Path(tmp).unlink(missing_ok=True)
    text = data.decode("utf-8-sig", "replace")
    head = text[:4000].lstrip()
    try:
        if head.startswith("<") and "<gpx" in head[:2000]:
            return parse_gpx(text)
        if head.startswith("<") and "<kml" in head[:2000]:
            return parse_kml(text)
    except ET.ParseError as e:
        raise WardriveError(f"That XML file is broken: {e}")
    if ext == ".nmea" or re.search(r"^\$G[PNL](RMC|GGA),", text[:20000], re.M):
        res = parse_nmea(text)
        if res["track"]:
            return res
    return parse_wigle(text)


# ====================================================================== the database

SCHEMA = """
CREATE TABLE IF NOT EXISTS drives(id INTEGER PRIMARY KEY, name TEXT, source TEXT, sha1 TEXT UNIQUE, fmt TEXT, app TEXT,
  imported TEXT, t0 TEXT, t1 TEXT, sightings INT DEFAULT 0, networks INT DEFAULT 0, new_networks INT DEFAULT 0, km REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS nets(id INTEGER PRIMARY KEY, mac TEXT, kind TEXT, ssid TEXT, auth TEXT, sec TEXT, channel INT, freq INT,
  band TEXT, maker TEXT, first TEXT, last TEXT, best_rssi INT, best_lat REAL, best_lon REAL, lat REAL, lon REAL, n INT, fdrive INT,
  UNIQUE(mac, kind));
CREATE TABLE IF NOT EXISTS sights(net INT, drive INT, t TEXT, rssi INT, lat REAL, lon REAL, alt REAL, acc REAL);
CREATE INDEX IF NOT EXISTS sights_net ON sights(net);
CREATE INDEX IF NOT EXISTS sights_drive ON sights(drive);
CREATE UNIQUE INDEX IF NOT EXISTS sights_uniq ON sights(net, drive, t, lat, lon);
CREATE TABLE IF NOT EXISTS track(drive INT, t TEXT, lat REAL, lon REAL);
CREATE INDEX IF NOT EXISTS track_drive ON track(drive);
CREATE TABLE IF NOT EXISTS shakes(id INTEGER PRIMARY KEY, net INT, drive INT, bssid TEXT, client TEXT, ssid TEXT,
  msgs TEXT, complete INT DEFAULT 0, pmkid INT DEFAULT 0, t TEXT, pkts INT DEFAULT 0, cap BLOB, UNIQUE(bssid, client, drive));
CREATE TABLE IF NOT EXISTS netdrive(net INT, drive INT, ssid TEXT, auth TEXT, channel INT, UNIQUE(net, drive));
CREATE INDEX IF NOT EXISTS netdrive_drive ON netdrive(drive);
CREATE INDEX IF NOT EXISTS shakes_net ON shakes(net);
CREATE INDEX IF NOT EXISTS shakes_drive ON shakes(drive);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
"""


class Store:
    def __init__(self, root):
        self.dir = Path(root)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "wardrive.db"
        self.lock = threading.RLock()
        self.con = sqlite3.connect(self.path, check_same_thread=False)
        self.con.executescript(SCHEMA)
        for col, ddl in (("pmkid", "ALTER TABLE shakes ADD COLUMN pmkid INT DEFAULT 0"),):   # migrate older DBs
            try:
                self.con.execute(ddl)
            except sqlite3.OperationalError:
                pass
        self.con.execute("PRAGMA journal_mode=WAL")

    # -------------------------------------------- settings
    def get(self, k, default=None):
        r = self.con.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def set(self, k, v):
        with self.lock, self.con:
            self.con.execute("INSERT OR REPLACE INTO kv VALUES(?,?)", (k, json.dumps(v)))

    # -------------------------------------------- import
    def import_bytes(self, name, data, source=""):
        if len(data) > MAX_FILE:
            raise WardriveError("That file is bigger than 300 MB.")
        sha = hashlib.sha1(data).hexdigest()
        with self.lock:
            dup = self.con.execute("SELECT id, name FROM drives WHERE sha1=?", (sha,)).fetchone()
            if dup:
                return {"duplicate": True, "id": dup[0], "name": dup[1]}
        parsed = parse_file(name, data)
        if parsed.get("shakes") is not None:
            return self._import_shakes(name, data, sha, source, parsed["shakes"])
        rows, track = parsed["rows"], parsed["track"]
        if not rows and not track:
            if parsed.get("logged"):
                raise WardriveError(f"{parsed['logged']} network sightings are in it, but none has a GPS position: "
                                    "the GPS had no fix yet while it was logging.")
            if parsed.get("no_gps_module"):
                raise WardriveError("Marauder says \"GPS Not Found\" in it, so it logged nothing. Connect the GPS module "
                                    "and wait for a fix before wardriving.")
            if parsed.get("fmt") == "WiGLE CSV":
                raise WardriveError("It's empty: only the header, no networks were logged.")
            raise WardriveError("No networks or GPS points found in it. Wardrive logs are usually WiGLE CSV files.")
        if not track:
            # the route is where the scanner was each time it logged something
            seen = sorted({(r["t"], round(r["lat"], 6), round(r["lon"], 6)) for r in rows})
            track = seen
        track = _thin(track)
        times = sorted(t for t in [r["t"] for r in rows] + [p[0] for p in track] if t)
        km = _km(track)
        with self.lock, self.con:
            cur = self.con.execute(
                "INSERT INTO drives(name, source, sha1, fmt, app, imported, t0, t1, km) VALUES(?,?,?,?,?,?,?,?,?)",
                (Path(name).stem[:80], source[:200], sha, parsed["fmt"], parsed["app"][:80],
                 datetime.now().strftime("%Y-%m-%d %H:%M:%S"), times[0] if times else "", times[-1] if times else "", km))
            did = cur.lastrowid
            before = {r[0] for r in self.con.execute("SELECT id FROM nets")}
            ids = self._upsert_nets(rows)
            per = {}                      # what each network called itself on this drive (for "renamed" / "security changed")
            for r in rows:
                k = (r["mac"], r["kind"])
                cur = per.get(k)
                if cur is None or (r["ssid"] and not cur["ssid"]) or (r["t"] >= cur["t"] and (r["ssid"] or not cur["ssid"])):
                    per[k] = r
            self.con.executemany("INSERT OR REPLACE INTO netdrive VALUES(?,?,?,?,?)",
                                 [(ids[k], did, r["ssid"], r["auth"], r["channel"] or 0) for k, r in per.items()])
            self.con.executemany(
                "INSERT OR IGNORE INTO sights VALUES(?,?,?,?,?,?,?,?)",
                [(ids[(r["mac"], r["kind"])], did, r["t"], r["rssi"], r["lat"], r["lon"], r["alt"], r["acc"]) for r in rows])
            self.con.executemany("INSERT INTO track VALUES(?,?,?,?)", [(did, t, la, lo) for t, la, lo in track])
            touched = set(ids.values())
            self._refresh(touched)
            new = len(touched - before)
            nsights = self.con.execute("SELECT COUNT(*) FROM sights WHERE drive=?", (did,)).fetchone()[0]
            self.con.execute("UPDATE drives SET sightings=?, networks=?, new_networks=? WHERE id=?", (nsights, len(touched), new, did))
        return {"ok": True, "id": did, "name": Path(name).stem, "networks": len(touched), "new": new,
                "sightings": nsights, "points": len(track), "fmt": parsed["fmt"], "km": round(km, 2)}

    def _import_shakes(self, name, data, sha, source, shakes):
        """A packet capture: file every handshake under the access point it belongs to."""
        if not shakes:
            raise WardriveError("No WPA handshakes found in that capture. (Looked for EAPOL four-way handshake frames.)")
        with self.lock, self.con:
            cur = self.con.execute(
                "INSERT INTO drives(name, source, sha1, fmt, app, imported) VALUES(?,?,?,?,?,?)",
                (Path(name).stem[:80], source[:200], sha, "Packet capture", "", datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            did = cur.lastrowid
            linked = 0
            for s in shakes:
                net = self._net_for_shake(s)
                linked += 1 if net else 0
                self.con.execute(
                    "INSERT OR IGNORE INTO shakes(net, drive, bssid, client, ssid, msgs, complete, pmkid, t, pkts, cap) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (net, did, s["bssid"], s["client"], s["ssid"], ",".join(map(str, s["msgs"])),
                     s["complete"], s.get("pmkid", 0), s["t"], s["pkts"], _pcap_bytes(s["frames"])))
            n = self.con.execute("SELECT COUNT(*) FROM shakes WHERE drive=?", (did,)).fetchone()[0]
            complete = self.con.execute("SELECT COUNT(*) FROM shakes WHERE drive=? AND complete=1", (did,)).fetchone()[0]
            pmkid = self.con.execute("SELECT COUNT(*) FROM shakes WHERE drive=? AND pmkid=1", (did,)).fetchone()[0]
            aps = len({s["bssid"] for s in shakes})
            self.con.execute("UPDATE drives SET networks=?, sightings=? WHERE id=?", (aps, n, did))
        return {"ok": True, "id": did, "name": Path(name).stem, "fmt": "Packet capture", "capture": True,
                "handshakes": n, "complete": complete, "pmkid": pmkid, "networks": aps, "new": 0, "linked": linked,
                "sightings": n, "points": 0, "km": 0}

    def _net_for_shake(self, s):
        """Link to the existing network with this BSSID, or make a locationless one so the handshake has a home."""
        row = self.con.execute("SELECT id, ssid FROM nets WHERE mac=? AND kind='wifi'", (s["bssid"],)).fetchone()
        if row:
            if s["ssid"] and not row[1]:
                self.con.execute("UPDATE nets SET ssid=? WHERE id=?", (s["ssid"], row[0]))
            return row[0]
        cur = self.con.execute(
            "INSERT INTO nets(mac, kind, ssid, auth, sec, channel, freq, band, maker, n) VALUES(?,?,?,?,?,?,?,?,?,0)",
            (s["bssid"], "wifi", s["ssid"], "", "wpa2", 0, 0, "", maker(s["bssid"], "wifi")))
        return cur.lastrowid

    def _upsert_nets(self, rows):
        ids = {}
        latest = {}
        for r in rows:   # newest non-empty name/auth/channel per network
            k = (r["mac"], r["kind"])
            cur = latest.get(k)
            if cur is None or (r["t"] >= cur["t"] and (r["ssid"] or not cur["ssid"])):
                latest[k] = r
        for (mac, kind), r in latest.items():
            row = self.con.execute("SELECT id, ssid, last FROM nets WHERE mac=? AND kind=?", (mac, kind)).fetchone()
            if row:
                ids[(mac, kind)] = row[0]
                if r["t"] >= (row[2] or "") or not row[1]:
                    self.con.execute("UPDATE nets SET ssid=COALESCE(NULLIF(?,''), ssid), auth=COALESCE(NULLIF(?,''), auth), sec=?, "
                                     "channel=COALESCE(NULLIF(?,0), channel), freq=COALESCE(NULLIF(?,0), freq), band=? WHERE id=?",
                                     (r["ssid"], r["auth"], security(r["auth"], kind), r["channel"], r["freq"],
                                      band(r["channel"], r["freq"]), row[0]))
            else:
                cur = self.con.execute(
                    "INSERT INTO nets(mac, kind, ssid, auth, sec, channel, freq, band, maker) VALUES(?,?,?,?,?,?,?,?,?)",
                    (mac, kind, r["ssid"], r["auth"], security(r["auth"], kind), r["channel"], r["freq"],
                     band(r["channel"], r["freq"]), maker(mac, kind)))
                ids[(mac, kind)] = cur.lastrowid
        return ids

    def _refresh(self, net_ids):
        """Recompute first/last seen, strongest point and the estimated position of these networks."""
        ids = list(net_ids)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            q = ",".join("?" * len(chunk))
            by = {}
            for net, drive, t, rssi, lat, lon in self.con.execute(
                    f"SELECT s.net, s.drive, s.t, s.rssi, s.lat, s.lon FROM sights s WHERE s.net IN ({q})", chunk):
                by.setdefault(net, []).append((t or "", rssi, lat, lon, drive))
            upd, gone = [], []
            dstart = dict(self.con.execute("SELECT id, COALESCE(NULLIF(t0,''), imported) FROM drives"))
            for net in chunk:
                s = by.get(net)
                if not s:
                    gone.append(net)
                    continue
                ts = [x[0] for x in s if x[0]]
                withsig = [x for x in s if x[1] is not None]
                best = max(withsig, key=lambda x: x[1]) if withsig else s[0]
                top = sorted(withsig, key=lambda x: -x[1])[:20]
                if top:
                    w = [10 ** ((x[1] - best[1]) / 10) for x in top]
                    lat = sum(x[2] * k for x, k in zip(top, w)) / sum(w)
                    lon = sum(x[3] * k for x, k in zip(top, w)) / sum(w)
                else:
                    lat = sum(x[2] for x in s) / len(s)
                    lon = sum(x[3] for x in s) / len(s)
                fdrive = min({x[4] for x in s}, key=lambda d: (dstart.get(d, ""), d))
                upd.append((min(ts) if ts else "", max(ts) if ts else "", best[1], best[2], best[3], lat, lon, len(s), fdrive, net))
            self.con.executemany("UPDATE nets SET first=?, last=?, best_rssi=?, best_lat=?, best_lon=?, lat=?, lon=?, n=?, fdrive=? WHERE id=?", upd)
            if gone:                                   # but keep a network that still has a captured handshake
                qg = ",".join("?" * len(gone))
                keep = {r[0] for r in self.con.execute(f"SELECT DISTINCT net FROM shakes WHERE net IN ({qg})", gone)}
                dead = [(g,) for g in gone if g not in keep]
                self.con.executemany("DELETE FROM nets WHERE id=?", dead)
                self.con.executemany("DELETE FROM netdrive WHERE net=?", dead)

    # -------------------------------------------- reading
    def summary(self):
        with self.lock:
            drives = [dict(zip(("id", "name", "source", "fmt", "app", "imported", "t0", "t1", "sightings", "networks", "new", "km"), r))
                      for r in self.con.execute("SELECT id, name, source, fmt, app, imported, t0, t1, sightings, networks, new_networks, km FROM drives ORDER BY COALESCE(NULLIF(t0,''), imported)")]
            n = self.con.execute("SELECT COUNT(*) FROM nets").fetchone()[0]
            hs = self.con.execute("SELECT COUNT(*), COALESCE(SUM(complete),0), COALESCE(SUM(pmkid),0), COUNT(DISTINCT net) FROM shakes").fetchone()
        return {"drives": drives, "networks": n, "handshakes": hs[0], "handshakes_complete": hs[1],
                "handshakes_pmkid": hs[2], "handshake_nets": hs[3]}

    def networks(self):
        """Every located network in a compact form the map can filter quickly:
        [id, lat, lon, kind, sec, band, channel, best_rssi, ssid, mac, maker, first, last, n, fdrive, [drive ids], has_handshake]"""
        with self.lock:
            dmap = {}
            for net, d in self.con.execute("SELECT DISTINCT net, drive FROM sights"):
                dmap.setdefault(net, []).append(d)
            hs = {r[0] for r in self.con.execute("SELECT DISTINCT net FROM shakes WHERE net IS NOT NULL")}
            out = []
            for r in self.con.execute("SELECT id, lat, lon, kind, sec, band, channel, best_rssi, ssid, mac, maker, first, last, n, fdrive FROM nets WHERE lat IS NOT NULL"):
                out.append([r[0], round(r[1], 6), round(r[2], 6), *r[3:], dmap.get(r[0], []), 1 if r[0] in hs else 0])
        return out

    def handshakes(self):
        """Every captured handshake with the network it belongs to (located or not), best ones first."""
        with self.lock:
            out = []
            for r in self.con.execute(
                    "SELECT s.id, s.net, s.bssid, s.client, COALESCE(NULLIF(s.ssid,''), n.ssid, ''), s.msgs, s.complete, s.pmkid, "
                    "s.t, s.pkts, s.drive, n.lat, n.lon FROM shakes s LEFT JOIN nets n ON n.id=s.net "
                    "ORDER BY (s.complete OR s.pmkid) DESC, s.complete DESC, COALESCE(NULLIF(s.ssid,''), n.ssid, s.bssid)"):
                out.append(dict(zip(("id", "net", "bssid", "client", "ssid", "msgs", "complete", "pmkid", "t", "pkts", "drive", "lat", "lon"), r)))
        return out

    def shake(self, sid):
        """(filename, pcap bytes) for one handshake, so it can be saved on its own."""
        with self.lock:
            r = self.con.execute("SELECT bssid, ssid, cap FROM shakes WHERE id=?", (int(sid),)).fetchone()
        if not r or r[2] is None:
            return None
        base = re.sub(r"[^A-Za-z0-9_-]+", "_", r[1] or "").strip("_") or "handshake"
        return f"{base}_{r[0].replace(':', '')}.pcap", r[2]

    def network(self, nid):
        with self.lock:
            r = self.con.execute("SELECT id, mac, kind, ssid, auth, sec, channel, freq, band, maker, first, last, best_rssi, best_lat, best_lon, lat, lon, n FROM nets WHERE id=?", (nid,)).fetchone()
            if not r:
                return None
            keys = ("id", "mac", "kind", "ssid", "auth", "sec", "channel", "freq", "band", "maker", "first", "last", "best_rssi", "best_lat", "best_lon", "lat", "lon", "n")
            net = dict(zip(keys, r))
            net["sightings"] = [list(x) for x in self.con.execute("SELECT t, rssi, lat, lon, drive FROM sights WHERE net=? ORDER BY t LIMIT 5000", (nid,))]
            net["drives"] = sorted({x[4] for x in net["sightings"]})
            net["shakes"] = [dict(zip(("id", "bssid", "client", "ssid", "msgs", "complete", "pmkid", "t", "pkts", "drive"), x))
                             for x in self.con.execute("SELECT id, bssid, client, ssid, msgs, complete, pmkid, t, pkts, drive FROM shakes WHERE net=? ORDER BY (complete OR pmkid) DESC, complete DESC, t", (nid,))]
        return net

    def drive(self, did):
        """Route and first sighting of each network in one drive, for the replay."""
        with self.lock:
            track = [list(x) for x in self.con.execute("SELECT t, lat, lon FROM track WHERE drive=? ORDER BY rowid", (did,))]
            first = [list(x) for x in self.con.execute(
                "SELECT net, MIN(t), lat, lon FROM sights WHERE drive=? GROUP BY net ORDER BY MIN(t)", (did,))]
        return {"track": track, "first": first}

    def tracks(self):
        with self.lock:
            out = {}
            for d, la, lo in self.con.execute("SELECT drive, lat, lon FROM track ORDER BY drive, rowid"):
                out.setdefault(d, []).append([round(la, 6), round(lo, 6)])
        return out

    def bounds(self):
        with self.lock:
            r = self.con.execute("SELECT MIN(lon), MIN(lat), MAX(lon), MAX(lat) FROM (SELECT lat, lon FROM sights UNION ALL SELECT lat, lon FROM track)").fetchone()
        return list(r) if r and r[0] is not None else None

    def changes(self, did, gone_m=40.0, moved_m=200.0):
        """What changed on one drive compared with every drive before it:
        new (never seen before), gone (WiFi seen before, the route passed within gone_m of it, not heard this time),
        moved (WiFi whose likely spot shifted more than moved_m), renamed, and security changed."""
        did = int(did)
        with self.lock:
            starts = {r[0]: r[1] or "" for r in self.con.execute(
                "SELECT id, COALESCE(NULLIF(t0,''), imported) FROM drives WHERE fmt != 'Packet capture'")}
            if did not in starts:
                return {"error": "That drive is gone."}
            earlier = sorted((d for d in starts if d != did and (starts[d], d) < (starts[did], did)), key=lambda d: (starts[d], d))
            if not earlier:
                return {"drive": did, "first": True}
            q = ",".join("?" * len(earlier))
            sb, se = {}, {}
            for net, rssi, lat, lon in self.con.execute("SELECT net, rssi, lat, lon FROM sights WHERE drive=?", (did,)):
                sb.setdefault(net, []).append((rssi, lat, lon))
            for net, rssi, lat, lon in self.con.execute(f"SELECT net, rssi, lat, lon FROM sights WHERE drive IN ({q})", earlier):
                se.setdefault(net, []).append((rssi, lat, lon))
            route = self.con.execute("SELECT lat, lon FROM track WHERE drive=?", (did,)).fetchall()
            per = {}
            for net, drive, ssid, auth in self.con.execute(f"SELECT net, drive, ssid, auth FROM netdrive WHERE drive IN ({q},?)", earlier + [did]):
                per.setdefault(net, {})[drive] = (ssid or "", auth or "")
            kinds = dict(self.con.execute("SELECT id, kind FROM nets"))
        new = [n for n in sb if n not in se]
        dense = []                                   # fill short gaps so a quiet stretch still counts as driven
        for a, b in zip(route, route[1:]):
            dense.append(a)
            step = haversine(a[0], a[1], b[0], b[1])
            if gone_m / 2 < step < 800:
                k = int(step // (gone_m / 2))
                dense += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(1, k)]
        dense += route[-1:]
        grid = _Grid(dense, gone_m)
        gone = []
        for n, s in se.items():
            if n in sb or kinds.get(n) != "wifi":
                continue
            lat, lon = _spot(s)
            if grid.near(lat, lon, gone_m):
                gone.append(n)
        moved, renamed, sec = [], [], []
        for n in sb.keys() & se.keys():
            k = kinds.get(n, "wifi")
            if k == "wifi":
                a, b = _spot(se[n]), _spot(sb[n])
                d = haversine(a[0], a[1], b[0], b[1])
                if d > moved_m:
                    moved.append({"id": n, "from": [round(a[0], 6), round(a[1], 6)], "to": [round(b[0], 6), round(b[1], 6)], "m": round(d)})
            names = per.get(n, {})
            cur = names.get(did)
            prev = next((names[d] for d in reversed(earlier) if d in names), None)
            if not cur or not prev:
                continue
            if cur[0] and prev[0] and cur[0] != prev[0]:
                renamed.append({"id": n, "from": prev[0], "to": cur[0]})
            if k == "wifi" and cur[1] and prev[1]:
                a, b = security(prev[1], k), security(cur[1], k)
                if a != b:
                    sec.append({"id": n, "from": a, "to": b})
        moved.sort(key=lambda x: -x["m"])
        return {"drive": did, "vs": len(earlier), "seen": len(sb), "new": new, "gone": gone,
                "moved": moved, "renamed": renamed, "sec": sec}

    # -------------------------------------------- editing
    def rename_drive(self, did, name):
        with self.lock, self.con:
            self.con.execute("UPDATE drives SET name=? WHERE id=?", ((name or "").strip()[:80] or "Drive", did))

    def delete_drive(self, did):
        with self.lock, self.con:
            nets = {r[0] for r in self.con.execute("SELECT DISTINCT net FROM sights WHERE drive=?", (did,))}
            nets |= {r[0] for r in self.con.execute("SELECT DISTINCT net FROM shakes WHERE drive=? AND net IS NOT NULL", (did,))}
            self.con.execute("DELETE FROM sights WHERE drive=?", (did,))
            self.con.execute("DELETE FROM track WHERE drive=?", (did,))
            self.con.execute("DELETE FROM shakes WHERE drive=?", (did,))
            self.con.execute("DELETE FROM netdrive WHERE drive=?", (did,))
            self.con.execute("DELETE FROM drives WHERE id=?", (did,))
            self._refresh(list(nets))
        self._vacuum()
        return {"ok": True, "removed": len(nets)}

    def wipe(self):
        with self.lock, self.con:
            for t in ("sights", "track", "shakes", "netdrive", "nets", "drives"):
                self.con.execute(f"DELETE FROM {t}")
        self._vacuum()

    def _vacuum(self):
        with self.lock:
            try:
                self.con.execute("VACUUM")
            except sqlite3.Error:
                pass

    # -------------------------------------------- export
    def export(self, fmt, ids, home=None):
        """Text of an export of these networks. Anything inside the home zone is left out."""
        ids = [int(i) for i in ids]

        def inside(lat, lon):
            return bool(home and home.get("on") and haversine(lat, lon, home["lat"], home["lon"]) <= home["r"])

        with self.lock:
            nets = {}
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                q = ",".join("?" * len(chunk))
                for r in self.con.execute(f"SELECT id, mac, kind, ssid, auth, sec, channel, freq, band, maker, first, last, best_rssi, lat, lon, n FROM nets WHERE id IN ({q})", chunk):
                    if not inside(r[13], r[14]):
                        nets[r[0]] = r
            if fmt == "wigle":
                sights = []
                keys = list(nets)
                for i in range(0, len(keys), 500):
                    chunk = keys[i:i + 500]
                    q = ",".join("?" * len(chunk))
                    sights += self.con.execute(f"SELECT net, t, rssi, lat, lon, alt, acc FROM sights WHERE net IN ({q}) ORDER BY t", chunk).fetchall()
        hidden = len(ids) - len(nets)
        if fmt == "wigle":
            buf = io.StringIO()
            buf.write("WigleWifi-1.4,appRelease=FlipperWorkbench,model=Workbench,release=1,device=Workbench,display=,board=,brand=\n")
            w = csv.writer(buf, lineterminator="\n")
            w.writerow(WIGLE_COLS)
            for net, t, rssi, lat, lon, alt, acc in sights:
                if inside(lat, lon):
                    continue
                n = nets[net]
                w.writerow([n[1], n[3], n[4], t, n[6] or "", rssi if rssi is not None else "", f"{lat:.7f}", f"{lon:.7f}",
                            "" if alt is None else alt, "" if acc is None else acc, {"wifi": "WIFI", "ble": "BLE", "bt": "BT"}.get(n[2], "GSM")])
            return buf.getvalue(), len(nets), hidden
        if fmt == "csv":
            buf = io.StringIO()
            w = csv.writer(buf, lineterminator="\n")
            w.writerow(["MAC", "Name", "Type", "Security", "Auth", "Channel", "Frequency", "Band", "Maker", "FirstSeen", "LastSeen",
                        "BestRSSI", "Latitude", "Longitude", "TimesSeen"])
            for n in nets.values():
                w.writerow([n[1], n[3], n[2], n[5], n[4], n[6] or "", n[7] or "", n[8], n[9], n[10], n[11],
                            "" if n[12] is None else n[12], f"{n[13]:.7f}", f"{n[14]:.7f}", n[15]])
            return buf.getvalue(), len(nets), hidden
        if fmt == "geojson":
            feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(n[14], 7), round(n[13], 7)]},
                      "properties": {"mac": n[1], "name": n[3], "type": n[2], "security": n[5], "auth": n[4], "channel": n[6],
                                     "band": n[8], "maker": n[9], "first_seen": n[10], "last_seen": n[11], "best_rssi": n[12], "times_seen": n[15]}}
                     for n in nets.values()]
            return json.dumps({"type": "FeatureCollection", "features": feats}, indent=1), len(nets), hidden
        if fmt == "kml":
            def x(s):
                return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
            colors = {"open": "ff4fdd5f", "wep": "ff2f9cff", "wpa": "ff00c8ff", "wpa2": "ff2982ff", "wpa3": "ffff9b4f",
                      "ent": "ffe08ab4", "none": "ffd0d0d0"}
            out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
                   "<name>Flipper Workbench wardrive export</name>"]
            for sec, c in colors.items():
                out.append(f'<Style id="{sec}"><IconStyle><color>{c}</color><scale>0.6</scale></IconStyle></Style>')
            for n in nets.values():
                desc = (f"MAC: {x(n[1])}<br/>Type: {x(n[2])}<br/>Encryption: {x(n[4])}<br/>Channel: {x(n[6])}<br/>"
                        f"Maker: {x(n[9])}<br/>First Seen: {x(n[10])}<br/>Last Seen: {x(n[11])}<br/>Signal: {x(n[12])}")
                out.append(f"<Placemark><name>{x(n[3] or n[1])}</name><description><![CDATA[{desc}]]></description>"
                           f"<styleUrl>#{n[5]}</styleUrl><Point><coordinates>{n[14]:.7f},{n[13]:.7f}</coordinates></Point></Placemark>")
            out.append("</Document></kml>")
            return "\n".join(out), len(nets), hidden
        raise WardriveError("Unknown export format")


def _spot(s):
    """Likely position from (rssi, lat, lon) sightings: the signal-weighted middle of the strongest 20."""
    withsig = [x for x in s if x[0] is not None]
    if withsig:
        top = sorted(withsig, key=lambda x: -x[0])[:20]
        w = [10 ** ((x[0] - top[0][0]) / 10) for x in top]
        tw = sum(w)
        return sum(x[1] * k for x, k in zip(top, w)) / tw, sum(x[2] * k for x, k in zip(top, w)) / tw
    return sum(x[1] for x in s) / len(s), sum(x[2] for x in s) / len(s)


class _Grid:
    """Route points bucketed into cells, to ask 'did the route pass within r metres of here?' quickly."""

    def __init__(self, pts, cell_m):
        self.cells = {}
        lat0 = sum(p[0] for p in pts) / len(pts) if pts else 0.0
        self.dlat = cell_m / 111320.0
        self.dlon = cell_m / (111320.0 * max(0.05, math.cos(math.radians(lat0))))
        for la, lo in pts:
            self.cells.setdefault((int(la // self.dlat), int(lo // self.dlon)), []).append((la, lo))

    def near(self, lat, lon, r):
        ci, cj = int(lat // self.dlat), int(lon // self.dlon)
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for la, lo in self.cells.get((i, j), ()):
                    if haversine(lat, lon, la, lo) <= r:
                        return True
        return False


def _thin(track, min_m=4.0):
    out = []
    for t, la, lo in sorted(track, key=lambda p: p[0] or "") if any(p[0] for p in track) else track:
        if out and haversine(out[-1][1], out[-1][2], la, lo) < min_m:
            continue
        out.append((t, la, lo))
    return out


def _km(track):
    d = 0.0
    for a, b in zip(track, track[1:]):
        step = haversine(a[1], a[2], b[1], b[2])
        if step < 2000:          # skip GPS jumps and gaps between sessions
            d += step
    return d / 1000


# ====================================================================== finding logs on the Flipper

def looks_like_log(path, size):
    p = path.lower()
    name = p.rsplit("/", 1)[-1]
    ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if size <= 0 or size > MAX_FILE or ext not in LOG_EXT:
        return False
    if ext in (".gpx", ".kml", ".nmea", ".kismet", ".wiglecsv", ".pcap", ".pcapng", ".cap"):
        return True
    if any(k in name for k in ("wardriv", "wigle")):
        return True
    return any(k in p for k in ("wardriv", "/wigle", "/gps", "ghost_esp", "/nmea"))   # captures match by extension above
