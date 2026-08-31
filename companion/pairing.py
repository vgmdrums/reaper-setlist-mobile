"""
Pairing: auth token persistence and local network address discovery for the
Genius SetList Mobile companion. The phone gets {host, port, token} once,
via a QR code shown in the tray app's status window (see tray.py) — there is
no unauthenticated REST endpoint that hands this out.
"""
import os
import json
import random
import secrets
import socket
import threading
import time

DISCOVERY_PORT = 47823

# Short, pronounceable words for the pairing phrase — easy to read off a
# monitor and type on a phone keyboard, unlike a random hex token.
_PHRASE_WORDS = [
    "amber", "atlas", "aurora", "basil", "cedar", "comet", "coral", "delta",
    "ember", "falcon", "granite", "harbor", "indigo", "jasper", "kite",
    "lagoon", "lumen", "maple", "nectar", "onyx", "opal", "piper", "quartz",
    "raven", "ridge", "saber", "tiger", "umber", "vapor", "willow", "zephyr",
    "meadow", "cobalt", "dune", "echo", "flint", "glacier", "haze", "ivory",
    "juniper",
]


def get_config_dir() -> str:
    base = os.environ.get("APPDATA", os.path.expanduser("~"))
    path = os.path.join(base, "GeniusSetListMobile")
    os.makedirs(path, exist_ok=True)
    return path


CONFIG_FILE = os.path.join(get_config_dir(), "config.json")

# config.json is touched from two real OS threads that run concurrently: the
# asyncio/uvicorn thread (every WS connect calls record_device()) and the
# Tkinter tray thread (role-pill clicks). Without a lock, a read on one
# thread can land between the other thread's open("w") truncation and its
# json.dump() — load_config() then sees a torn/empty file, silently falls
# back to {}, and a save from THAT stale empty state wipes out whatever the
# other thread just wrote. This bit us for real: an admin assignment and the
# entire device history were wiped in one race, while token/phrase (touched
# far less often) happened to survive. Every mutator below now does its
# whole load-modify-save as one critical section under this lock.
_lock = threading.RLock()


def load_config() -> dict:
    with _lock:
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        return {}


def save_config(cfg: dict):
    with _lock:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)


def _update_config(mutate):
    """Atomically load, mutate (in place), and save config.json — the
    load-modify-save must be a single critical section, not three separate
    lock acquisitions, or two concurrent callers can still interleave
    between them."""
    with _lock:
        cfg = load_config()
        result = mutate(cfg)
        save_config(cfg)
        return result


def get_or_create_token() -> str:
    def mutate(cfg):
        token = cfg.get("token")
        if not token:
            token = secrets.token_hex(16)
            cfg["token"] = token
        return token
    return _update_config(mutate)


def _generate_phrase() -> str:
    w1, w2 = random.sample(_PHRASE_WORDS, 2)
    return f"{w1}-{w2}-{random.randint(10, 99)}"


def get_or_create_phrase() -> str:
    """A stable, human-typeable alternative to scanning the QR code. It is
    NOT the auth secret itself — it only lets the phone *find* this machine
    on the Wi-Fi network (see discovery server in main.py); the real
    session token still comes back in the discovery reply."""
    def mutate(cfg):
        phrase = cfg.get("phrase")
        if not phrase:
            phrase = _generate_phrase()
            cfg["phrase"] = phrase
        return phrase
    return _update_config(mutate)


def set_phrase(phrase: str) -> str:
    """Let the user override the generated phrase with something they'll
    remember. Returns the normalized (trimmed) phrase actually saved."""
    phrase = phrase.strip() or _generate_phrase()
    def mutate(cfg):
        cfg["phrase"] = phrase
    _update_config(mutate)
    return phrase


def get_local_ip() -> dict:
    """Return {"ok": True, "ip": ...} or {"ok": False, "error": ...}.

    Both devices are expected on the same Wi-Fi access point, so the phone
    just needs this machine's LAN IP — no VPN/relay involved. The UDP-connect
    trick below sends no packets (UDP `connect()` only resolves a route); it's
    the same approach the old desktop app used for its LAN QR code.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return {"ok": True, "ip": ip}
    except OSError:
        pass
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith("127."):
            return {"ok": True, "ip": ip}
    except OSError:
        pass
    return {"ok": False, "error": "Could not determine this machine's Wi-Fi/LAN IP address."}


def get_admin_device_ids() -> set:
    """The devices (by their self-generated device_id) allowed into Edit
    mode — every other connected device is locked to Stage view. Empty set
    means "no admin assigned yet" — nobody can edit until the tray owner
    explicitly picks someone from the device history below. There is
    deliberately no "first device to connect" auto-assignment: that made
    admin depend on connection order/luck, not on who should actually have it.
    Any number of devices can be admin at once."""
    cfg = load_config()
    ids = cfg.get("admin_device_ids")
    if ids is None:
        # One-time migration from the old single-admin field.
        legacy = cfg.get("admin_device_id")
        ids = [legacy] if legacy else []
    return set(ids)


def set_device_admin(device_id: str, is_admin: bool):
    if not device_id:
        return
    def mutate(cfg):
        ids = set(cfg.get("admin_device_ids") or ([cfg["admin_device_id"]] if cfg.get("admin_device_id") else []))
        ids.add(device_id) if is_admin else ids.discard(device_id)
        cfg["admin_device_ids"] = sorted(ids)
        cfg.pop("admin_device_id", None)
    _update_config(mutate)


def record_device(device_id: str, label: str):
    """Remember every device that's ever connected — by name, not just
    whoever happens to be online right now — so the tray can show the full
    roster (including offline ones) when picking who should be admin."""
    if not device_id:
        return
    def mutate(cfg):
        devices = cfg.setdefault("devices", {})
        entry = devices.get(device_id, {})
        if label:
            entry["label"] = label
        elif "label" not in entry:
            entry["label"] = "Unnamed device"
        now = time.time()
        entry.setdefault("first_seen", now)
        entry["last_seen"] = now
        devices[device_id] = entry
    _update_config(mutate)


def get_known_devices() -> dict:
    """{device_id: {"label":..., "first_seen":..., "last_seen":...}, ...}
    for every device that has ever connected, online or not."""
    return load_config().get("devices", {})


def remove_device(device_id: str):
    """Drop a device from the tray's history list (also revoking admin if it
    had it — can't stay admin once forgotten). Purely a list clean-up: if
    that device is still actively connected, its session keeps working until
    it reconnects, at which point it's simply recorded fresh again."""
    if not device_id:
        return
    def mutate(cfg):
        cfg.get("devices", {}).pop(device_id, None)
        ids = set(cfg.get("admin_device_ids") or [])
        ids.discard(device_id)
        cfg["admin_device_ids"] = sorted(ids)
        cfg.get("device_permissions", {}).pop(device_id, None)
    _update_config(mutate)


def can_control_playback(device_id: str) -> bool:
    """Separate from admin — a non-admin device can still be trusted with
    play/stop/etc. (the default, matching original behavior) or restricted
    to view-only. Admins always have control regardless of this flag, since
    revoking your own playback access while editing would be a confusing
    self-lockout. Missing device/key defaults to True."""
    if device_id in get_admin_device_ids():
        return True
    cfg = load_config()
    perms = cfg.get("device_permissions", {}).get(device_id, {})
    return perms.get("can_control", True)


def set_can_control_playback(device_id: str, can_control: bool):
    if not device_id:
        return
    def mutate(cfg):
        all_perms = cfg.setdefault("device_permissions", {})
        entry = all_perms.get(device_id, {})
        entry["can_control"] = can_control
        all_perms[device_id] = entry
    _update_config(mutate)


def build_pairing_payload(port: int) -> dict:
    """Returns {"ok": bool, "payload": {host, port, token} | None, "error": str | None}."""
    addr = get_local_ip()
    if not addr["ok"]:
        return {"ok": False, "payload": None, "error": addr["error"]}
    payload = {"host": addr["ip"], "port": port, "token": get_or_create_token()}
    return {"ok": True, "payload": payload, "error": None}
