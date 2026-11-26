"""Reads Flipper capture files (.sub, .ir, .nfc, .rfid, .ibtn) into something people can read.

All of them use Flipper's key/value text format: "Key: value" lines, "#" comments, and for .ir a
"#" line between signals. Unknown files come back as plain text.
"""

import re

PRESETS = {
    "FuriHalSubGhzPresetOok270Async": "AM270 (OOK, 270 kHz)",
    "FuriHalSubGhzPresetOok650Async": "AM650 (OOK, 650 kHz)",
    "FuriHalSubGhzPreset2FSKDev238Async": "FM238 (2-FSK, 2.38 kHz)",
    "FuriHalSubGhzPreset2FSKDev476Async": "FM476 (2-FSK, 47.6 kHz)",
    "FuriHalSubGhzPresetMSK99_97KbAsync": "MSK (99.97 kb/s)",
    "FuriHalSubGhzPresetGFSK9_99KbAsync": "GFSK (9.99 kb/s)",
    "FuriHalSubGhzPresetCustom": "Custom",
}
IR_PROTOCOLS = {"NEC", "NECext", "NEC42", "NEC42ext", "Samsung32", "RC6", "RC5", "RC5X", "SIRC", "SIRC15",
                "SIRC20", "Kaseikyo", "RCA", "Pioneer"}

# Sub-GHz protocols that use a rolling (hopping) code: a captured copy opens the target at most once and
# then desyncs, so a saved replay is not a working clone. Names as Flipper writes them in the .sub Protocol field.
SUBGHZ_ROLLING = {"KeeLoq", "Star Line", "Starline", "AN-Motors", "AN_Motors", "Alutech", "Nice FloR-S",
                  "Nice Flor S", "CAME Atomo", "Hormann BiSecur", "Honda", "FAAC SLH", "FAAC_SLH", "Keeloq",
                  "Security+ 2.0", "Security+2.0", "Somfy Telis", "Somfy Keytis", "Chamberlain Code"}
# Fixed-code protocols: the same signal every press, so a saved copy keeps working as a clone.
SUBGHZ_FIXED = {"Princeton", "CAME", "CAME TWEE", "NICE FLO", "Nice Flo", "Holtek", "Holtek HT12X", "Linear",
                "Linear Delta3", "Chamberlain", "Gate-TX", "GateTX", "SMC5326", "PT2260", "Hollarm", "Megacode",
                "Ansonic", "Doitrand", "KIA", "Keeloq (fixed)", "BETT", "Clemsa", "Intertechno_V3", "Airforce",
                "Marantec", "Power Smart", "Honeywell", "MagellanTech", "Kinggates Stylo4k", "Normstahl",
                "Somfy fixed", "Dooya", "SMC", "RAW2"}


def subghz_kind(protocol, has_raw=False):
    """Classify a .sub Protocol as 'rolling', 'fixed', 'raw' or 'unknown', with a plain-English note."""
    p = (protocol or "").strip()
    if p in SUBGHZ_ROLLING:
        return "rolling", "Rolling code: the signal changes every press, so a saved copy opens it at most once, not a lasting clone."
    if p in SUBGHZ_FIXED:
        return "fixed", "Fixed code: the same signal every time, so a saved copy keeps working as a clone."
    if p == "RAW" or (not p or p == "?") and has_raw:
        return "raw", "Raw capture: replayable as recorded. It works like a clone only if the device itself uses a fixed code."
    return "unknown", "Unrecognised protocol; can't tell if it's fixed or rolling from the file alone."


def subghz_summary(text, path=""):
    """Quick facts for the Sub-GHz library from a .sub file's text: frequency, modulation, protocol, type."""
    pairs = _pairs(text)
    proto = _first(pairs, "Protocol") or ""
    preset = _first(pairs, "Preset") or ""
    has_raw = any(k == "RAW_Data" for k, _ in pairs)
    kind, note = subghz_kind(proto, has_raw)
    hz = 0
    try:
        hz = int(_first(pairs, "Frequency") or 0)
    except ValueError:
        hz = 0
    return {"freq": hz, "freq_mhz": _mhz(_first(pairs, "Frequency")), "preset": PRESETS.get(preset, preset or ""),
            "protocol": proto or ("RAW" if has_raw else "?"), "type": kind, "note": note}
TEXT_EXT = {".txt", ".js", ".fmf", ".log", ".md", ".csv", ".json", ".ini", ".cfg", ".conf", ".sub", ".ir",
            ".nfc", ".rfid", ".ibtn", ".u2f", ".fff", ".keys", ".dict", ".ducky", ".bad", ".xml", ".html", ".yml"}
MAX_VIEW = 512 * 1024


def kind_of(name):
    n = name.lower()
    for ext, kind in ((".sub", "subghz"), (".ir", "ir"), (".nfc", "nfc"), (".rfid", "rfid"), (".ibtn", "ibutton")):
        if n.endswith(ext):
            return kind
    if n.endswith(".js"):
        return "js"
    if n.endswith(".txt") and ("badusb" in n or "/badusb/" in n):
        return "badusb"
    return "text"


def is_text(data):
    if b"\x00" in data[:4096]:
        return False
    try:
        data[:4096].decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _pairs(text):
    """Every "Key: value" line in order (keys can repeat, e.g. RAW_Data)."""
    out = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        k, sep, v = line.partition(":")
        if sep:
            out.append((k.strip(), v.strip()))
    return out


def _first(pairs, *keys):
    for want in keys:
        for k, v in pairs:
            if k.lower() == want.lower():
                return v
    return None


def _hex_le(value):
    """'07 00 00 00' (little-endian bytes, as .ir files store them) -> '0x07' for the CLI."""
    try:
        b = bytes(int(x, 16) for x in value.split())
    except ValueError:
        return None
    return hex(int.from_bytes(b, "little"))


def _mhz(hz):
    try:
        return f"{int(hz) / 1e6:.2f} MHz"
    except (TypeError, ValueError):
        return hz


# ---------------------------------------------------------------- signal timings for the signal viewer
# Signed microseconds: positive = signal on (carrier / high), negative = off. Drawn from the protocol's ideal timing,
# so a parsed button or key can be looked at like a recording. Nothing here sends anything.
MAX_WAVE = 400_000
IR_CARRIER = {"NEC": 38000, "NECext": 38000, "NEC42": 38000, "NEC42ext": 38000, "Samsung32": 38000, "Pioneer": 40000,
              "RCA": 56000, "SIRC": 40000, "SIRC15": 40000, "SIRC20": 40000, "RC5": 36000, "RC5X": 36000, "RC6": 36000}


def _le(value):
    try:
        return int.from_bytes(bytes(int(x, 16) for x in value.split()), "little")
    except (ValueError, AttributeError):
        return None


def _lsb(v, n):
    return [(v >> i) & 1 for i in range(n)]


def _msb(v, n):
    return [(v >> i) & 1 for i in reversed(range(n))]


def _distance(lead, mark, one, zero, bits):
    """Pulse-distance coding (NEC family, Samsung, RCA, Pioneer): leader, then mark + long/short space per bit, stop mark."""
    w = [lead[0], -lead[1]]
    for b in bits:
        w += [mark, -(one if b else zero)]
    return w + [mark]


def _levels(halves, unit):
    """List of on/off half-bits -> signed durations (leading/trailing off-time dropped)."""
    w = []
    for lv in halves:
        d = unit if lv else -unit
        if w and (w[-1] > 0) == (d > 0):
            w[-1] += d
        else:
            w.append(d)
    while w and w[0] < 0:
        w.pop(0)
    while w and w[-1] < 0:
        w.pop()
    return w


def ir_timings(protocol, address, command):
    """Ideal timing of one press of a parsed IR button, or None for protocols not drawn here."""
    a, c = _le(address), _le(command)
    if a is None or c is None:
        return None
    p = protocol
    if p == "NEC":
        return _distance((9000, 4500), 560, 1690, 560, _lsb(a, 8) + _lsb(~a & 0xFF, 8) + _lsb(c, 8) + _lsb(~c & 0xFF, 8))
    if p == "NECext":
        return _distance((9000, 4500), 560, 1690, 560, _lsb(a, 16) + _lsb(c, 16))
    if p == "NEC42":
        return _distance((9000, 4500), 560, 1690, 560, _lsb(a, 13) + _lsb(~a & 0x1FFF, 13) + _lsb(c, 8) + _lsb(~c & 0xFF, 8))
    if p == "NEC42ext":
        return _distance((9000, 4500), 560, 1690, 560, _lsb(a, 26) + _lsb(c, 16))
    if p == "Samsung32":
        return _distance((4500, 4500), 550, 1650, 550, _lsb(a, 8) + _lsb(a, 8) + _lsb(c, 8) + _lsb(~c & 0xFF, 8))
    if p == "Pioneer":
        return _distance((8500, 4250), 500, 1500, 500, _lsb(a, 8) + _lsb(~a & 0xFF, 8) + _lsb(c, 8) + _lsb(~c & 0xFF, 8))
    if p == "RCA":
        return _distance((4000, 4000), 500, 2000, 1000, _msb(a, 4) + _msb(c, 8) + _msb(~a & 0xF, 4) + _msb(~c & 0xFF, 8))
    if p in ("SIRC", "SIRC15", "SIRC20"):
        bits = _lsb(c, 7) + _lsb(a, {"SIRC": 5, "SIRC15": 8, "SIRC20": 13}[p])
        w = [2400]
        for b in bits:
            w += [-600, 1200 if b else 600]
        return w
    if p in ("RC5", "RC5X"):
        s2 = 1 if p == "RC5" else (~c >> 6) & 1
        halves = []
        for b in [1, s2, 0] + _msb(a, 5) + _msb(c, 6):
            halves += [0, 1] if b else [1, 0]          # RC5: a 1 rises in the middle of its bit
        return _levels(halves, 889)
    if p == "RC6":
        halves = [1] * 6 + [0] * 2 + [1, 0]            # leader, then the start bit
        for b in [0, 0, 0]:                            # mode 0
            halves += [1, 0] if b else [0, 1]          # RC6: a 1 falls in the middle of its bit
        halves += [0, 0, 1, 1]                         # toggle bit, twice as long
        for b in _msb(a, 8) + _msb(c, 8):
            halves += [1, 0] if b else [0, 1]
        return _levels(halves, 444)
    return None


def princeton_timings(key, bits, te, repeats=3):
    """Princeton (the common fixed-code remote chip): 1 = 3 TE on + 1 off, 0 = 1 on + 3 off, then 1 on + 30 off."""
    v = _le(" ".join(reversed((key or "").split())))     # .sub keys are written most significant byte first
    try:
        n, te = int(bits), int(te)
    except (TypeError, ValueError):
        return None
    if v is None or not 1 <= n <= 64 or not 50 <= te <= 5000:
        return None
    one = []
    for b in _msb(v & ((1 << n) - 1), n):
        one += [3 * te, -te] if b else [te, -3 * te]
    one += [te, -30 * te]
    return one * repeats


def parse(name, text, path=""):
    kind = kind_of(path or name)
    pairs = _pairs(text)
    res = {"kind": kind, "filetype": _first(pairs, "Filetype") or "", "fields": [], "text": text}
    f = res["fields"]

    if kind == "subghz":
        raw = [int(x) for k, v in pairs if k == "RAW_Data" for x in v.split() if re.fullmatch(r"-?\d+", x)]
        proto = _first(pairs, "Protocol") or "?"
        res["title"] = "Sub-GHz recording" if proto == "RAW" else f"Sub-GHz key: {proto}"
        f.append(["Frequency", _mhz(_first(pairs, "Frequency"))])
        preset = _first(pairs, "Preset") or ""
        f.append(["Modulation", PRESETS.get(preset, preset or "?")])
        f.append(["Protocol", proto])
        for k in ("Bit", "Key", "TE", "Repeat", "Manufacture", "Serial", "Btn", "Cnt"):
            v = _first(pairs, k)
            if v:
                f.append([{"Bit": "Bits", "TE": "TE (us)"}.get(k, k), v])
        if raw:
            total_us = sum(abs(x) for x in raw)
            f.append(["Samples", f"{len(raw):,}"])
            f.append(["Length", f"{total_us / 1e6:.2f} s"])
            res["wave"] = raw[:MAX_WAVE]
        elif proto == "Princeton":
            w = princeton_timings(_first(pairs, "Key"), _first(pairs, "Bit"), _first(pairs, "TE"))
            if w:
                res["wave"], res["synth"] = w, True
        try:
            hz = int(_first(pairs, "Frequency") or 0)
        except ValueError:
            hz = 0
        res["signal"] = {"kind": "subghz", "freq": hz, "preset": PRESETS.get(preset, preset), "protocol": proto,
                         "te": _first(pairs, "TE")}
        res["note"] = "Replaying Sub-GHz signals is done on the Flipper itself (Sub-GHz app), within your local rules."

    elif kind == "ir":
        signals, cur, raw_signals = [], None, []
        for k, v in pairs:
            if k == "name":
                cur = {"name": v}
                signals.append(cur)
                raw_signals.append([[k, v]])
            elif cur is not None:
                cur[k] = v
                raw_signals[-1].append([k, v])
        res["signals"] = raw_signals          # every field in file order, so an edited remote can be written back
        buttons = []
        for s in signals:
            b = {"name": s.get("name", "?"), "type": s.get("type", "?")}
            if s.get("type") == "parsed":
                proto, addr, cmd = s.get("protocol", ""), _hex_le(s.get("address", "")), _hex_le(s.get("command", ""))
                b["detail"] = f"{proto} · address {addr} · command {cmd}"
                if proto in IR_PROTOCOLS and addr and cmd:
                    b["tx"] = f"ir tx {proto} {addr} {cmd}"
                w = ir_timings(proto, s.get("address", ""), s.get("command", ""))
                if w:
                    b["wave"], b["synth"], b["carrier"] = w, True, IR_CARRIER.get(proto)
            elif s.get("type") == "raw":
                samples = s.get("data", "").split()
                try:
                    b["wave"] = [int(x) if i % 2 == 0 else -int(x) for i, x in enumerate(samples)][:MAX_WAVE]
                    b["carrier"] = int(float(s.get("frequency", "38000")))
                except ValueError:
                    pass
                freq, duty = s.get("frequency", "38000"), s.get("duty_cycle", "0.33")
                try:
                    dc = int(round(float(duty) * 100)) if float(duty) <= 1 else int(float(duty))
                except ValueError:
                    dc = 33
                b["detail"] = f"raw · {int(freq) / 1000:g} kHz · {len(samples)} samples"
                if 0 < len(samples) <= 512:
                    b["tx"] = f"ir tx RAW F:{freq} DC:{dc} {' '.join(samples)}"
            buttons.append(b)
        res["title"] = "Infrared remote"
        f.append(["Buttons", str(len(buttons))])
        res["buttons"] = buttons
        res["signal"] = {"kind": "ir"}
        res["note"] = "Send fires the button from your Flipper's IR LED, so point it at the device."

    elif kind == "nfc":
        dev = _first(pairs, "Device type") or "?"
        res["title"] = f"NFC card: {dev}"
        for k in ("Device type", "UID", "ATQA", "SAK", "Mifare Classic type", "Data format version",
                  "NTAG/Ultralight type", "Mifare version", "Signature", "Counter 0", "Pages total", "Pages read"):
            v = _first(pairs, k)
            if v and not (k == "Device type"):
                f.append([k, v])
        f.insert(0, ["Type", dev])
        blocks = [(k, v) for k, v in pairs if re.fullmatch(r"(Block|Page) \d+", k)]
        if blocks:
            unread = sum(1 for _, v in blocks if "??" in v)
            label = "Blocks" if blocks[0][0].startswith("Block") else "Pages"
            f.append([label, f"{len(blocks)} ({len(blocks) - unread} read{', ' + str(unread) + ' missing' if unread else ''})"])
            res["blocks"] = [[k, v] for k, v in blocks[:512]]

    elif kind == "rfid":
        kt = _first(pairs, "Key type") or "?"
        res["title"] = f"RFID tag: {kt}"
        f.append(["Type", kt])
        f.append(["Data", _first(pairs, "Data") or "?"])

    elif kind == "ibutton":
        proto = _first(pairs, "Protocol", "Key type") or "?"
        res["title"] = f"iButton key: {proto}"
        f.append(["Protocol", proto])
        for k in ("Rom Data", "Data", "Sram Data", "Eeprom Data"):
            v = _first(pairs, k)
            if v:
                f.append([k, v if len(v) < 80 else v[:80] + "..."])

    else:
        res["title"] = {"js": "JavaScript app", "badusb": "BadUSB script"}.get(kind, "Text file")
        lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
        f.append(["Lines", str(lines)])

    if res["filetype"]:
        f.append(["File type", res["filetype"]])
    return res
