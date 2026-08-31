"""
Genius SetList Mobile — Companion (Windows tray app)
Talks to REAPER via a Lua file bridge (genius_bridge.lua), same mechanism as
the original Genius SetList desktop app. Serves the mobile-optimized React
frontend and a REST/WebSocket API over the machine's Wi-Fi/LAN address so an
Android phone (native WebView shell) can reach it from the same access point.

No REAPER HTTP API, no reapy — the bridge writes state to genius_state.json
and reads commands from genius_cmd.json in REAPER's resource path.

SETUP (one time, in REAPER):
  Actions > Load ReaScript > genius_bridge.lua > Run
  Optionally: Actions > Add to startup actions
"""

import sys, os, threading, time, json, asyncio, uvicorn, uuid, secrets, subprocess

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, APIRouter, Depends, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from typing import List, Optional

import pairing

PORT = 9760
APP_VERSION = "1.0.2"
UPDATE_REPO = "vgmdrums/reaper-setlist-mobile"

# ── Bridge file paths ─────────────────────────────────────────────────────────
def get_reaper_resource_path() -> str:
    """Find Reaper's resource path (where reaper.ini lives)."""
    import winreg
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"SOFTWARE\REAPER")
        path, _ = winreg.QueryValueEx(key, "REAPER_RESOURCE_PATH")
        return path
    except OSError:
        pass
    appdata = os.environ.get("APPDATA", "")
    candidates = [
        os.path.join(appdata, "REAPER"),
        r"C:\Users\Default\AppData\Roaming\REAPER",
    ]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return appdata

REAPER_RESOURCE = get_reaper_resource_path()
STATE_FILE = os.path.join(REAPER_RESOURCE, "genius_state.json")
CMD_FILE   = os.path.join(REAPER_RESOURCE, "genius_cmd.json")

if getattr(sys, "frozen", False):
    BRIDGE_SCRIPT = os.path.join(sys._MEIPASS, "genius_bridge.lua")
else:
    BRIDGE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "genius_bridge.lua")

print(f"  State file: {STATE_FILE}")
print(f"  Bridge script: {BRIDGE_SCRIPT}")

# ── Bridge state reader ───────────────────────────────────────────────────────
_state_cache = {}
_state_mtime = 0.0

def read_bridge_state() -> dict:
    global _state_cache, _state_mtime
    try:
        mtime = os.path.getmtime(STATE_FILE)
        if mtime == _state_mtime:
            return _state_cache
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if raw:
            _state_cache = json.loads(raw)
            _state_mtime = mtime
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return _state_cache

def bridge_connected() -> bool:
    try:
        mtime = os.path.getmtime(STATE_FILE)
        return (time.time() - mtime) < 3.0
    except OSError:
        return False

def send_command(action: int = 0, pos: float = None, loop_pos: float = None, open_project: str = None) -> bool:
    cmd = {"id": str(uuid.uuid4())}
    if action:
        cmd["action"] = action
    if pos is not None:
        cmd["pos"] = pos
    if loop_pos is not None:
        cmd["loop_pos"] = loop_pos
    if open_project is not None:
        cmd["open_project"] = open_project
    try:
        with open(CMD_FILE, "w", encoding="utf-8") as f:
            json.dump(cmd, f, separators=(',', ':'))
        return True
    except OSError:
        return False

def install_bridge() -> dict:
    """Copy genius_bridge.lua into REAPER's Scripts folder, quitting a running
    bridge first if the file is locked."""
    import shutil
    log = []
    if not os.path.exists(BRIDGE_SCRIPT):
        log.append(f"FAIL: Bridge script not found at: {BRIDGE_SCRIPT}")
        return {"success": False, "log": log}

    scripts_dir = os.path.join(REAPER_RESOURCE, "Scripts")
    os.makedirs(scripts_dir, exist_ok=True)
    dest = os.path.join(scripts_dir, "genius_bridge.lua")

    try:
        shutil.copy2(BRIDGE_SCRIPT, dest)
        log.append(f"OK: Copied bridge to: {dest}")
        log.append("Now in Reaper: Actions > Load ReaScript > select genius_bridge.lua > Run")
        return {"success": True, "log": log, "script_path": dest}
    except PermissionError:
        pass
    except OSError as e:
        log.append(f"FAIL: {e}")
        return {"success": False, "log": log}

    log.append("Bridge is running — sending quit command to release file lock...")
    if not send_command(action=0) or True:
        pass
    try:
        with open(CMD_FILE, "w", encoding="utf-8") as f:
            json.dump({"id": str(uuid.uuid4()), "quit": True}, f, separators=(',', ':'))
    except OSError as e:
        log.append(f"FAIL: Could not write quit command: {e}")
        return {"success": False, "log": log}

    for _ in range(30):
        time.sleep(0.1)
        if not bridge_connected():
            break
    time.sleep(0.3)

    try:
        shutil.copy2(BRIDGE_SCRIPT, dest)
        log.append(f"OK: Bridge terminated and updated at: {dest}")
        log.append("IMPORTANT: restart it — Actions > Run ReaScript > genius_bridge.lua")
        return {"success": True, "log": log, "script_path": dest, "needs_restart": True}
    except OSError as e:
        log.append(f"FAIL after termination: {e}")
        return {"success": False, "log": log}

# ── Static path (built frontend) ──────────────────────────────────────────────
def get_static_path():
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, "static")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

STATIC_PATH = get_static_path()

# ── Setlist persistence (in %APPDATA%\GeniusSetListMobile, survives reinstalls) ──
def get_setlists_path() -> str:
    return os.path.join(pairing.get_config_dir(), "genius_setlists.json")

# ── FastAPI ───────────────────────────────────────────────────────────────────
app = FastAPI(title="Genius SetList Mobile", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

# ── Auth ──────────────────────────────────────────────────────────────────────
# Pairing (host/port/token) is handed to the phone once via a QR code the tray
# app displays — there is no unauthenticated endpoint that reveals the token.
# Every real API route (REST + WS) requires it; the static app shell (index
# .html/js/css/manifest) does not, since it carries no data and the WebView's
# very first navigation is a plain GET with the token only in the query string.
def _valid_token(candidate: Optional[str]) -> bool:
    return bool(candidate) and secrets.compare_digest(candidate, pairing.get_or_create_token())

async def require_token(authorization: Optional[str] = Header(None), token: Optional[str] = Query(None)):
    provided = token
    if not provided and authorization and authorization.lower().startswith("bearer "):
        provided = authorization[7:]
    if not _valid_token(provided):
        raise HTTPException(401, "Invalid or missing pairing token")

async def require_admin(x_device_id: Optional[str] = Header(None, alias="X-Device-Id")):
    """Guards structural-edit endpoints (saving setlists) so a non-admin
    device can't bypass the frontend's Edit-mode gate by calling the API
    directly. Playback/transport endpoints are intentionally NOT gated the
    same way — see require_transport_control below. No admin assigned yet
    means nobody can edit — see pairing.get_admin_device_ids()."""
    if x_device_id not in pairing.get_admin_device_ids():
        raise HTTPException(403, "Only an admin device can edit setlists")

async def require_transport_control(x_device_id: Optional[str] = Header(None, alias="X-Device-Id")):
    """Guards play/stop/seek/etc. A device can be locked to view-only in
    Stage view (tray: uncheck 'Play/Stop') independently of admin status —
    admins are always exempt from this specific restriction."""
    if not pairing.can_control_playback(x_device_id):
        raise HTTPException(403, "This device doesn't have playback control")

api = APIRouter(dependencies=[Depends(require_token)])

# ── Connected-client tracking (shown in the tray status window) ──────────────
class ConnectionManager:
    def __init__(self):
        self.connections: List[dict] = []  # [{"ws":..., "label":..., "device_id":..., "connected_at":...}]

    async def connect(self, ws: WebSocket, label: str = "phone", device_id: str = ""):
        await ws.accept()
        self.connections.append({"ws": ws, "label": label, "device_id": device_id, "connected_at": time.time()})

    def disconnect(self, ws: WebSocket):
        self.connections = [c for c in self.connections if c["ws"] is not ws]

    async def broadcast(self, msg: dict):
        dead = []
        for c in self.connections:
            try:
                await c["ws"].send_json(msg)
            except Exception:
                dead.append(c["ws"])
        for ws in dead:
            self.disconnect(ws)

    async def broadcast_roles(self):
        """Tell every connected device its current isAdmin/canControl —
        called on connect and whenever the tray changes either one, so a
        role change takes effect live without needing a reconnect."""
        admin_ids = pairing.get_admin_device_ids()
        dead = []
        for c in self.connections:
            device_id = c["device_id"]
            is_admin = bool(device_id) and device_id in admin_ids
            can_control = is_admin or (bool(device_id) and pairing.can_control_playback(device_id))
            try:
                await c["ws"].send_json({"type": "role", "isAdmin": is_admin, "canControl": can_control})
            except Exception:
                dead.append(c["ws"])
        for ws in dead:
            self.disconnect(ws)

    def list_clients(self) -> List[dict]:
        admin_ids = pairing.get_admin_device_ids()
        return [{"label": c["label"], "device_id": c["device_id"], "connected_at": c["connected_at"],
                  "is_admin": bool(c["device_id"]) and c["device_id"] in admin_ids} for c in self.connections]

manager = ConnectionManager()

_last_playback: dict = {"type": "playback_state", "is_playing": False, "region_id": None, "item_id": None, "child_index": -1}

class PlayRequest(BaseModel):
    region_id: str; start: float; end: float
    item_id: Optional[str] = None
    child_index: Optional[int] = None

class SeekRequest(BaseModel):
    pos: float

class OpenProjectRequest(BaseModel):
    rpp_path: str

class SaveSetlistsRequest(BaseModel):
    setlists: list

class MidiSendCCRequest(BaseModel):
    device: str
    cc: int
    value: int = 127
    channel: int = 0

# ── API ───────────────────────────────────────────────────────────────────────
@api.get("/health")
async def health():
    import platform
    connected = bridge_connected()
    state = read_bridge_state() if connected else {}
    issues = []
    if not connected:
        if not os.path.exists(STATE_FILE):
            issues.append("Bridge not running. The Lua bridge script needs to be loaded in Reaper.")
        else:
            issues.append("Bridge state file is stale — is genius_bridge.lua still running in Reaper?")
        issues.append("In Reaper: Actions > Load ReaScript > genius_bridge.lua > Run")
    return {
        "reaper_connected": connected,
        "api_port": PORT,
        "interface": "Lua file bridge (genius_bridge.lua)",
        "platform": platform.system(),
        "python_version": platform.python_version(),
        "state_file": STATE_FILE,
        "bridge_script": BRIDGE_SCRIPT,
        "current_project": state.get("proj_path") or state.get("proj_name"),
        "region_count": len(state.get("regions", [])),
        "issues": issues or None,
    }

@api.get("/projects")
async def get_projects():
    if not bridge_connected(): return []
    state = read_bridge_state()
    path = state.get("proj_path", "")
    name = state.get("proj_name", "")
    if not name and path:
        name = os.path.splitext(os.path.basename(path))[0]
    if not name and not path:
        return []
    return [{"index": 0, "name": name, "path": path, "active": True}]

@api.get("/regions")
async def get_regions():
    if not bridge_connected(): return []
    return read_bridge_state().get("regions", [])

@api.get("/tracks")
async def get_tracks():
    if not bridge_connected(): return []
    return read_bridge_state().get("tracks", [])

MIDI_BLOCKLIST = {"microsoft gs wavetable synth", "virtual midi keyboard"}

@api.get("/midi-devices")
async def get_midi_devices():
    if not bridge_connected(): return []
    state = read_bridge_state()
    return [d for d in state.get("midi_devices", [])
            if d.get("name", "").lower() not in MIDI_BLOCKLIST]

@api.get("/instructions")
async def get_instructions():
    path = _bundled("instructions.txt")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return {"text": f.read()}
    return {"text": "Instructions file not found."}

@api.get("/config-status")
async def config_status():
    path = get_setlists_path()
    if not os.path.exists(path):
        return {"first_run": True}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {"first_run": not (isinstance(data, list) and len(data) > 0)}
    except (json.JSONDecodeError, OSError):
        return {"first_run": True}

@api.post("/seek", dependencies=[Depends(require_transport_control)])
async def seek(req: SeekRequest):
    if bridge_connected():
        send_command(pos=req.pos)
    return {"status": "sought"}

@api.post("/play", dependencies=[Depends(require_transport_control)])
async def play(req: PlayRequest):
    global _last_playback
    if bridge_connected():
        send_command(pos=req.start, action=1007)
    msg = {"type": "playback_state", "is_playing": True,
           "region_id": req.region_id, "position": req.start,
           "item_id": req.item_id, "child_index": req.child_index}
    _last_playback = msg
    await manager.broadcast(msg)
    return {"status": "playing"}

@api.post("/midi-reset", dependencies=[Depends(require_transport_control)])
async def midi_reset():
    if bridge_connected():
        send_command(action=40345)
    return {"status": "ok"}

@api.post("/midi/send-cc", dependencies=[Depends(require_transport_control)])
async def midi_send_cc(req: MidiSendCCRequest):
    """Send a MIDI CC message to a named output device via the Windows MIDI API."""
    import ctypes

    class MIDIOUTCAPSW(ctypes.Structure):
        _fields_ = [
            ("wMid", ctypes.c_ushort), ("wPid", ctypes.c_ushort),
            ("dwDriverVersion", ctypes.c_ulong), ("szPname", ctypes.c_wchar * 32),
            ("wTechnology", ctypes.c_ushort), ("wVoices", ctypes.c_ushort),
            ("wNotes", ctypes.c_ushort), ("wChannelMask", ctypes.c_ushort),
            ("dwSupport", ctypes.c_ulong),
        ]

    winmm = ctypes.windll.winmm
    num_devs = winmm.midiOutGetNumDevs()
    device_idx = None
    target = req.device.lower()
    for i in range(num_devs):
        caps = MIDIOUTCAPSW()
        if winmm.midiOutGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            name = caps.szPname.rstrip('\x00')
            if target in name.lower() or name.lower() in target:
                device_idx = i
                break
    if device_idx is None:
        return {"status": "error", "note": f"device '{req.device}' not found in MIDI outputs"}

    handle = ctypes.c_void_p()
    if winmm.midiOutOpen(ctypes.byref(handle), device_idx, 0, 0, 0) != 0:
        return {"status": "error", "note": "midiOutOpen failed"}
    ch = max(0, min(15, req.channel)); cc = max(0, min(127, req.cc)); val = max(0, min(127, req.value))
    winmm.midiOutShortMsg(handle, ctypes.c_ulong((0xB0 | ch) | (cc << 8) | (val << 16)))
    winmm.midiOutClose(handle)
    return {"status": "ok"}

@api.post("/loop-seek", dependencies=[Depends(require_transport_control)])
async def loop_seek(req: SeekRequest):
    if bridge_connected():
        send_command(loop_pos=req.pos)
    await manager.broadcast({"position": req.pos, "is_playing": True})
    return {"status": "looped"}

@api.post("/play-selected", dependencies=[Depends(require_transport_control)])
async def play_selected():
    if not bridge_connected(): return {"status": "bridge not running"}
    send_command(action=40718)
    time.sleep(0.08)
    send_command(action=1007)
    return {"status": "playing selected"}

@api.post("/stop", dependencies=[Depends(require_transport_control)])
async def stop():
    global _last_playback
    if bridge_connected():
        send_command(action=1016)
    msg = {"type": "playback_state", "is_playing": False, "region_id": None, "item_id": None, "child_index": -1}
    _last_playback = msg
    await manager.broadcast(msg)
    return {"status": "stopped"}

@api.post("/pause", dependencies=[Depends(require_transport_control)])
async def pause():
    if bridge_connected():
        send_command(action=1008)
    return {"status": "toggled pause"}

@api.get("/transport")
async def transport():
    if not bridge_connected():
        return {"is_playing": False, "position": 0.0}
    state = read_bridge_state()
    return {
        "is_playing": state.get("is_playing", False),
        "is_paused": state.get("is_paused", False),
        "position": state.get("position", 0.0),
    }

@api.get("/current-project-path")
async def current_project_path():
    if not bridge_connected(): return {"path": "", "name": ""}
    state = read_bridge_state()
    path = state.get("proj_path", "")
    name = state.get("proj_name", "")
    if not name and path:
        name = os.path.splitext(os.path.basename(path))[0]
    return {"path": path, "name": name}

@api.post("/open-project")
async def open_project(req: OpenProjectRequest):
    if not bridge_connected(): return {"status": "bridge not running"}
    send_command(open_project=req.rpp_path)
    return {"status": "open command sent", "path": req.rpp_path}

@api.post("/link-current-project")
async def link_current_project():
    """Replaces the old desktop app's native file-browse dialog (not available
    headless): link a setlist to whatever project REAPER currently has open."""
    if not bridge_connected():
        raise HTTPException(400, "REAPER bridge not connected — open a project in REAPER first.")
    state = read_bridge_state()
    path = state.get("proj_path", "")
    if not path:
        raise HTTPException(400, "No project is currently open in REAPER.")
    name = state.get("proj_name") or os.path.splitext(os.path.basename(path))[0]
    return {"path": path, "name": name}

@api.post("/open-reaper")
async def open_reaper_app():
    import subprocess, winreg
    paths = []
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
              r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\REAPER.exe")
        p, _ = winreg.QueryValueEx(key, None); paths.append(p)
    except OSError:
        pass
    paths += [
        r"C:\Program Files\REAPER (x64)\reaper.exe",
        r"C:\Program Files (x86)\REAPER\reaper.exe",
        r"C:\Program Files\REAPER\reaper.exe",
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                subprocess.Popen([p], creationflags=subprocess.DETACHED_PROCESS)
                return {"status": "launched", "path": p}
            except OSError as e:
                raise HTTPException(500, str(e))
    raise HTTPException(404, "Reaper not found. Please launch it manually.")

@api.post("/install-bridge")
async def install_bridge_endpoint():
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, install_bridge)

@api.get("/setlists")
async def load_setlists():
    path = get_setlists_path()
    if not os.path.exists(path): return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as e:
        print(f"load_setlists error: {e}"); return []

@api.post("/setlists", dependencies=[Depends(require_admin)])
async def save_setlists(req: SaveSetlistsRequest, x_device_id: Optional[str] = Header(None, alias="X-Device-Id")):
    path = get_setlists_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(req.setlists, f, indent=2, ensure_ascii=False)
        # Setlists live on this PC, not on any one phone — every connected
        # device (the admin included, so two admin sessions stay in sync too)
        # gets told to re-fetch. by_device_id lets the saving device ignore
        # its own echo instead of clobbering an in-progress local edit.
        await manager.broadcast({"type": "setlists_changed", "by_device_id": x_device_id or ""})
        return {"status": "saved", "path": path, "count": len(req.setlists)}
    except OSError as e:
        raise HTTPException(500, f"Could not save: {e}")

@api.get("/debug/bridge")
async def debug_bridge():
    return {
        "bridge_connected": bridge_connected(),
        "state_file": STATE_FILE,
        "state_file_exists": os.path.exists(STATE_FILE),
        "state_file_age_s": round(time.time() - os.path.getmtime(STATE_FILE), 1) if os.path.exists(STATE_FILE) else None,
        "reaper_resource": REAPER_RESOURCE,
        "bridge_script": BRIDGE_SCRIPT,
        "bridge_script_exists": os.path.exists(BRIDGE_SCRIPT),
        "raw_state": read_bridge_state(),
    }

@api.get("/clients")
async def clients():
    return manager.list_clients()

# ── WebSocket ─────────────────────────────────────────────────────────────────
def _find_matching_setlist(proj_path: str) -> Optional[dict]:
    """Find a saved setlist whose linked rppPath matches the given project path
    (case-insensitive; REAPER paths on Windows aren't case-sensitive)."""
    if not proj_path:
        return None
    path = get_setlists_path()
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, list):
        return None
    target = proj_path.strip().lower()
    for sl in data:
        if isinstance(sl, dict) and (sl.get("rppPath") or "").strip().lower() == target:
            return sl
    return None

@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, token: Optional[str] = None, device: Optional[str] = "phone",
                       device_id: Optional[str] = None):
    if not _valid_token(token):
        await websocket.close(code=1008)  # policy violation
        return

    device_id = device_id or ""
    # Remember this device (name + last-seen) regardless of admin status —
    # the tray's device list is built from this history, not just who's
    # currently online, so admin can be assigned to a device that isn't
    # connected at that exact moment.
    pairing.record_device(device_id, device or "")

    await manager.connect(websocket, label=device or "phone", device_id=device_id)
    loop = asyncio.get_event_loop()
    last_connected = None
    last_region_sig = None
    last_proj_sig = None
    last_switch_prompt_path = None
    slow_tick = 0

    try:
        ok = bridge_connected()
        last_connected = ok
        await websocket.send_json({"type": "connected", "reaper_connected": ok, "interface": "lua-bridge"})
        _is_admin = bool(device_id) and device_id in pairing.get_admin_device_ids()
        await websocket.send_json({"type": "role", "isAdmin": _is_admin,
                                   "canControl": _is_admin or (bool(device_id) and pairing.can_control_playback(device_id))})
        await websocket.send_json(_last_playback)
        while True:
            await asyncio.sleep(0.008)
            ok = bridge_connected()

            if ok != last_connected:
                last_connected = ok
                await websocket.send_json({"type": "connection_changed", "reaper_connected": ok})
                if ok:
                    await websocket.send_json({"type": "regions_changed"})
                    await websocket.send_json({"type": "projects_changed"})
                slow_tick = 0
                continue

            if not ok:
                await websocket.send_json({"type": "transport", "reaper_connected": False,
                                           "is_playing": False, "position": 0.0})
                continue

            state = await loop.run_in_executor(None, read_bridge_state)

            is_playing = state.get("is_playing", False)
            position = round(state.get("position", 0.0), 3)
            peaks = state.get("peaks", [])
            active_region_id = None
            if is_playing:
                for r in state.get("regions", []):
                    if r.get("start", -1) <= position < r.get("end", 0):
                        active_region_id = r.get("id")
                        break
            await websocket.send_json({"type": "transport", "reaper_connected": True,
                                       "is_playing": is_playing, "position": position,
                                       "peaks": peaks, "region_id": active_region_id})

            slow_tick += 1
            if slow_tick >= 62:
                slow_tick = 0

                regions = state.get("regions", [])
                region_sig = tuple((r.get("name"), r.get("start"), r.get("end")) for r in regions)
                if region_sig != last_region_sig:
                    if last_region_sig is not None:
                        await websocket.send_json({"type": "regions_changed"})
                    last_region_sig = region_sig

                proj_sig = state.get("proj_path", "")
                if proj_sig != last_proj_sig:
                    last_proj_sig = proj_sig
                    await websocket.send_json({"type": "projects_changed"})

                    # Project-switch prompt: only when the new project matches a
                    # saved setlist. Whether that setlist is already the one the
                    # phone has active is a client-side decision (the server has
                    # no concept of "active setlist" — that lives in the app UI).
                    if proj_sig and proj_sig != last_switch_prompt_path:
                        matched = await loop.run_in_executor(None, _find_matching_setlist, proj_sig)
                        if matched:
                            last_switch_prompt_path = proj_sig
                            await websocket.send_json({
                                "type": "project_switch_prompt",
                                "proj_name": state.get("proj_name", ""),
                                "proj_path": proj_sig,
                                "matched_setlist_id": matched.get("id"),
                                "matched_setlist_name": matched.get("name"),
                            })

                midi_devices = [d for d in state.get("midi_devices", [])
                                if d.get("name", "").lower() not in MIDI_BLOCKLIST]
                await websocket.send_json({"type": "midi_devices", "devices": midi_devices})

    except WebSocketDisconnect:
        manager.disconnect(websocket)

app.include_router(api)

# ── Static / SPA (no auth — app shell only, no data) ──────────────────────────
def _bundled(filename):
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, filename)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)

@app.get("/sw.js")
async def service_worker():
    sw = (
        "self.addEventListener('install', e => self.skipWaiting());\n"
        "self.addEventListener('activate', e => e.waitUntil(clients.claim()));\n"
        "self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => new Response('', {status: 503}))));\n"
    )
    return Response(content=sw, media_type="application/javascript",
                    headers={"Service-Worker-Allowed": "/"})

@app.get("/manifest.json")
async def manifest_json():
    return JSONResponse({
        "name": "Genius SetList Mobile",
        "short_name": "SetList",
        "description": "Control REAPER setlists from your phone",
        "start_url": "/",
        "display": "fullscreen",
        "background_color": "#0e0e10",
        "theme_color": "#0e0e10",
        "orientation": "portrait",
        "icons": [
            {"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        ]
    })

BACKEND_ICONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "icons")

@app.get("/icons/{filename}")
async def serve_icon(filename: str):
    path = os.path.join(BACKEND_ICONS, filename)
    if os.path.exists(path):
        return FileResponse(path)
    raise HTTPException(404, "Icon not found")

API_ROUTES = {"health", "projects", "regions", "transport", "play", "seek", "stop", "pause",
              "play-selected", "open-project", "link-current-project", "current-project-path",
              "install-bridge", "tracks", "open-reaper", "setlists", "debug", "ws", "clients",
              "manifest.json", "icons", "sw.js", "midi-devices", "midi-reset", "midi",
              "instructions", "config-status"}

if os.path.isdir(STATIC_PATH):
    sa = os.path.join(STATIC_PATH, "static")
    if os.path.isdir(sa):
        app.mount("/static", StaticFiles(directory=sa), name="static")
    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        if full_path.split("/")[0] in API_ROUTES:
            raise HTTPException(404)
        idx = os.path.join(STATIC_PATH, "index.html")
        return FileResponse(idx) if os.path.exists(idx) else {"error": "frontend not built"}

# ── Server lifecycle ──────────────────────────────────────────────────────────
_server_loop: Optional[asyncio.AbstractEventLoop] = None
_server_error: Optional[Exception] = None

def start_server():
    """Runs on a daemon thread — an unhandled exception here (e.g. the port
    is already held by a leftover instance) would otherwise just die silently:
    daemon threads print their traceback to stderr and vanish, and this is a
    windowed (no console) build, so stderr goes nowhere the user can see.
    Stashing the exception lets __main__ notice via wait_for_server()'s
    return value and show a real error dialog instead of a tray that looks
    fine but has no working server behind it."""
    global _server_loop, _server_error
    async def _serve():
        global _server_loop
        _server_loop = asyncio.get_running_loop()
        # log_config=None: a windowed (no-console) build has no real
        # sys.stdout/stderr for uvicorn's default logging.config.dictConfig()
        # to attach a formatter to — it raises "Unable to configure
        # formatter 'default'" and the whole server never starts. Skipping
        # uvicorn's own logging setup avoids that codepath entirely; nothing
        # here depends on uvicorn's console log formatting anyway.
        cfg = uvicorn.Config(app, host="0.0.0.0", port=PORT, log_level="warning", log_config=None)
        await uvicorn.Server(cfg).serve()
    try:
        asyncio.run(_serve())
    except Exception as e:
        _server_error = e
        print(f"  Server failed to start: {e}")

def wait_for_server(port, timeout=10):
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5): return True
        except OSError:
            time.sleep(0.15)
    return False

def start_discovery_server():
    """Answers the phone's 'who has this pairing phrase' broadcast with this
    machine's real {host, port, token} — the phrase is only a way to find the
    right PC on the Wi-Fi network, not the session credential itself."""
    import socket as _socket
    sock = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
    sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", pairing.DISCOVERY_PORT))
    except OSError as e:
        print(f"  Warning: pairing-phrase discovery disabled — {e}")
        return
    while True:
        try:
            data, addr = sock.recvfrom(1024)
            req = json.loads(data.decode("utf-8"))
            phrase = (req.get("discover") or "").strip().lower()
            if phrase and phrase == pairing.get_or_create_phrase().strip().lower():
                ip = pairing.get_local_ip()
                if not ip["ok"]:
                    continue
                reply = json.dumps({"host": ip["ip"], "port": PORT, "token": pairing.get_or_create_token()})
                sock.sendto(reply.encode("utf-8"), addr)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            continue

# ── Update check ──────────────────────────────────────────────────────────────
_latest_update: Optional[dict] = None  # {"version": str, "url": str} once a newer release is found

def _version_tuple(v: str):
    parts = []
    for p in v.strip().lstrip("v").split("."):
        digits = "".join(c for c in p if c.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)

def _check_for_update_once():
    """One GitHub Releases API hit, no auth needed (public repo). Any failure
    — offline, DNS, rate limit, whatever — just means no update is reported
    this cycle; the background loop tries again later on its own."""
    global _latest_update
    try:
        import urllib.request
        req = urllib.request.Request(
            f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "GeniusSetListMobile"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest = (data.get("tag_name") or "").strip()
        if latest and _version_tuple(latest) > _version_tuple(APP_VERSION):
            _latest_update = {"version": latest, "url": data.get("html_url") or f"https://github.com/{UPDATE_REPO}/releases/latest"}
        else:
            _latest_update = None
    except Exception:
        pass  # stays whatever it was — a transient failure shouldn't clear a real result

def update_check_loop():
    """Runs for the life of the app: checks immediately at startup, then every
    few hours — "when it has an internet connection" isn't an event this app
    can observe directly on Windows without extra dependencies, so periodic
    retry stands in for it (a failed check is silent and just tries again)."""
    while True:
        _check_for_update_once()
        time.sleep(6 * 3600)

def get_update_for_tray() -> dict:
    return {"current_version": APP_VERSION, "update": _latest_update}

def get_status_for_tray() -> dict:
    connected = bridge_connected()
    state = read_bridge_state() if connected else {}
    return {"reaper_connected": connected, "current_project": state.get("proj_name") or state.get("proj_path")}

def get_pairing_for_tray() -> dict:
    return pairing.build_pairing_payload(PORT)

def get_local_url_for_tray() -> str:
    """The tray's "Plan B" link: opens this same app directly on this PC via
    localhost, bypassing Wi-Fi/LAN entirely — a fallback control surface for
    when the phone can't reach the companion over the network."""
    return f"http://127.0.0.1:{PORT}/?token={pairing.get_or_create_token()}"

def get_clients_for_tray() -> list:
    """Every device that's ever connected (named, persistent history), not
    just who's online right now — so the tray can assign admin to a device
    that happens to be offline at the moment. Any number can be admin."""
    known = pairing.get_known_devices()
    admin_ids = pairing.get_admin_device_ids()
    online_ids = {c["device_id"] for c in manager.connections if c["device_id"]}
    result = [{
        "device_id": device_id,
        "label": info.get("label") or "Unnamed device",
        "is_admin": device_id in admin_ids,
        "can_control": device_id in admin_ids or pairing.can_control_playback(device_id),
        "online": device_id in online_ids,
        "last_seen": info.get("last_seen", 0),
    } for device_id, info in known.items()]
    result.sort(key=lambda d: (not d["online"], -d["last_seen"]))
    return result

def set_admin_for_tray(device_id: str, is_admin: bool):
    """Called from the tray's admin checkboxes. Persists the choice and
    pushes it live to every connected device (no reconnect needed)."""
    pairing.set_device_admin(device_id, is_admin)
    if _server_loop is not None:
        asyncio.run_coroutine_threadsafe(manager.broadcast_roles(), _server_loop)

def set_transport_control_for_tray(device_id: str, can_control: bool):
    """Called from the tray's Play/Stop checkboxes. Persists the choice and
    pushes it live (no reconnect needed)."""
    pairing.set_can_control_playback(device_id, can_control)
    if _server_loop is not None:
        asyncio.run_coroutine_threadsafe(manager.broadcast_roles(), _server_loop)

def remove_device_for_tray(device_id: str):
    """Called from the tray's device-list remove button — just tidies the
    history list; doesn't kick an already-connected session."""
    pairing.remove_device(device_id)

def get_phrase_for_tray() -> str:
    return pairing.get_or_create_phrase()

def set_phrase_for_tray(phrase: str) -> str:
    return pairing.set_phrase(phrase)

def ensure_autostart():
    """Create a Startup-folder shortcut (once) so the companion launches at
    login — no admin elevation needed, unlike the old exe's scheduled-task
    approach. Safe to call on every launch; skips if the shortcut exists."""
    try:
        import win32com.client
        startup_dir = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
        shortcut_path = os.path.join(startup_dir, "Genius SetList Mobile.lnk")
        if os.path.exists(shortcut_path):
            return
        target = sys.executable
        args = "" if getattr(sys, "frozen", False) else f'"{os.path.abspath(__file__)}"'
        workdir = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(shortcut_path)
        shortcut.TargetPath = target
        shortcut.Arguments = args
        shortcut.WorkingDirectory = workdir
        icon = _bundled("icon.ico")
        if os.path.exists(icon):
            shortcut.IconLocation = icon
        shortcut.Save()
        print(f"  Auto-start shortcut created: {shortcut_path}")
    except Exception as e:
        print(f"  Warning: could not set up auto-start: {e}")

FIREWALL_RULE_NAME = "Genius SetList Mobile"
FIREWALL_RULE_NAME_DISCOVERY = "Genius SetList Mobile (pairing discovery)"

def _firewall_rule_exists() -> bool:
    try:
        r = subprocess.run(
            ["netsh", "advfirewall", "firewall", "show", "rule", f"name={FIREWALL_RULE_NAME}"],
            capture_output=True, text=True, timeout=5,
        )
        return "No rules match" not in r.stdout
    except Exception:
        return True  # can't tell — fail open rather than nag with a UAC prompt every launch

def _create_firewall_rules() -> bool:
    """Adds inbound allow rules for the API port (TCP) and the pairing-phrase
    discovery port (UDP). Must run elevated: netsh silently no-ops without
    admin rights rather than raising, so callers should check afterward via
    _firewall_rule_exists() rather than trust the return value alone."""
    exe = sys.executable
    try:
        subprocess.run(["netsh", "advfirewall", "firewall", "add", "rule",
                        f"name={FIREWALL_RULE_NAME}", "dir=in", "action=allow",
                        f"program={exe}", "enable=yes", "profile=any"], timeout=10, check=True)
        subprocess.run(["netsh", "advfirewall", "firewall", "add", "rule",
                        f"name={FIREWALL_RULE_NAME_DISCOVERY}", "dir=in", "action=allow",
                        "protocol=UDP", f"localport={pairing.DISCOVERY_PORT}",
                        "enable=yes", "profile=any"], timeout=10, check=True)
        return True
    except Exception as e:
        print(f"  Firewall rule creation failed: {e}")
        return False

def request_firewall_access():
    """A fresh install (any machine) shouldn't need the phone to fail to
    connect before anyone realizes it's blocked — so ask Windows to let this
    exe through, once, right at startup. Creating the rule needs admin
    rights this normal-user process doesn't have; rather than elevate the
    WHOLE app (which would mean a UAC prompt on every single launch, tray
    app or not), this re-invokes ONLY a narrow "--create-firewall-rule" mode
    of itself via os.startfile's "runas" operation — one UAC prompt, a few
    seconds, then that helper exits and this process continues unelevated
    exactly as before. Declining the prompt just means asking again next
    launch, same as today's silent block.

    Uses os.startfile() rather than raw ShellExecuteW via ctypes: the latter
    hung indefinitely in testing — the "runas" verb goes through COM to talk
    to the elevation UI, and a calling thread with no message loop can block
    waiting for that COM call to unblock. os.startfile's C implementation
    doesn't have that problem. Still run from a background thread (see
    caller) as a second line of defense in case of some other UAC hang."""
    if not getattr(sys, "frozen", False):
        return  # dev-mode `python main.py` already inherits python.exe's own firewall trust
    if _firewall_rule_exists():
        return
    try:
        os.startfile(sys.executable, "runas", arguments="--create-firewall-rule")
    except Exception as e:
        print(f"  Warning: could not request firewall access: {e}")

if __name__ == "__main__":
    if "--create-firewall-rule" in sys.argv:
        # The elevated helper re-invocation described above — do the one
        # privileged thing and exit immediately, no server, no tray icon.
        _create_firewall_rules()
        sys.exit(0)

    print(f"\n{'='*55}")
    print(f"  Genius SetList Mobile — companion, port {PORT}")
    print(f"  Interface: Lua file bridge")
    print(f"  Resource path: {REAPER_RESOURCE}")
    print(f"{'='*55}\n")

    ensure_autostart()
    # On a real machine ShellExecuteW's "runas" should return immediately
    # after handing off to the elevation UI — but that UAC/secure-desktop
    # handoff turned out to hang indefinitely in this dev sandbox, and
    # blocking main() on it would mean a bad interaction on someone's actual
    # machine takes the whole app down with it, not just the one-time
    # firewall step. A daemon thread means the worst case is "the rule never
    # gets created," never "the app never starts."
    threading.Thread(target=request_firewall_access, daemon=True).start()
    threading.Thread(target=update_check_loop, daemon=True).start()

    _bi = install_bridge()
    for _line in _bi.get("log", []):
        print(f"  [bridge] {_line}")

    threading.Thread(target=start_server, daemon=True).start()
    if not wait_for_server(PORT):
        # Continuing here would show a tray icon that looks fine but has no
        # working server behind it — every request (including "Launch Local
        # App") would just fail to connect with no clue why.
        detail = str(_server_error) if _server_error else "Timed out waiting for the local server to start."
        # Only the port-already-taken case is actually "another copy is
        # running" — anything else (a startup exception in the server
        # itself, like a bad logging/config setup) needs different guidance,
        # so don't guess a cause the error text doesn't support.
        if "address" in detail.lower() or "10048" in detail or "in use" in detail.lower():
            hint = "This usually means another copy is already running — check your\nsystem tray (click the ^ arrow to see hidden icons) before\nlaunching this again."
        else:
            hint = "This looks like a startup error rather than a conflicting instance.\nTry reinstalling the latest version; if it keeps happening, save this\nexact message to report it."
        msg = f"Genius SetList Mobile couldn't start its local server.\n\n{detail}\n\n{hint}"
        print(f"  FATAL: {msg}")
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "Genius SetList Mobile", 0x10)  # MB_ICONERROR
        except Exception:
            pass
        sys.exit(1)
    threading.Thread(target=start_discovery_server, daemon=True).start()
    print(f"  Server ready on 0.0.0.0:{PORT} — starting tray icon\n")

    from tray import TrayApp

    def _on_quit():
        os._exit(0)

    tray_app = TrayApp(
        get_status_fn=get_status_for_tray,
        get_clients_fn=get_clients_for_tray,
        get_pairing_fn=get_pairing_for_tray,
        get_local_url_fn=get_local_url_for_tray,
        get_update_fn=get_update_for_tray,
        get_phrase_fn=get_phrase_for_tray,
        set_phrase_fn=set_phrase_for_tray,
        set_admin_fn=set_admin_for_tray,
        set_transport_control_fn=set_transport_control_for_tray,
        remove_device_fn=remove_device_for_tray,
        on_quit=_on_quit,
    )
    tray_app.run()
