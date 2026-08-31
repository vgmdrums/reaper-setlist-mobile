import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import React from "react";
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, DragOverlay,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, verticalListSortingStrategy,
  sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "./App.css";

// ─────────────────────────────────────────────────────────────────────────────
// Pairing token — the Android WebView navigates here as .../?token=<token>
// after the user scans the companion's QR code. Read it once, remember it in
// localStorage (so a plain reload doesn't need the query string again), then
// strip it from the address bar. Every REST call and the WS connection send
// it back so the companion's require_token() dependency accepts them.
// ─────────────────────────────────────────────────────────────────────────────
const urlToken = new URLSearchParams(window.location.search).get("token");
if (urlToken) {
  localStorage.setItem("pairToken", urlToken);
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.toString());
}
const PAIR_TOKEN = urlToken || localStorage.getItem("pairToken") || "";

// Stable per-install identifier — lets the tray app designate exactly one
// connected device as "admin" (Edit mode allowed); every other device is
// held to Stage view. Generated once and reused for the life of this
// browser/WebView install; unrelated to the pairing token.
function getOrCreateDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    localStorage.setItem("deviceId", id);
  }
  return id;
}
const DEVICE_ID = getOrCreateDeviceId();

// A real, human-chosen name — not a guessed "iPhone · Safari" — so the tray's
// admin picker is actually legible ("Kyle's Phone" vs. three identical
// "Android · Chrome" entries with no way to tell them apart). The Android app
// asks for this on its native pairing screen and passes it here as
// ?device_label=...; a plain-browser connection gets asked by DeviceNameGate
// below instead. Either way it's required — there's no auto-guess fallback
// used as the actual label, only as a suggested starting point to edit.
//
// Unlike the pair token, this only SEEDS localStorage if it's empty — once
// set (by either this seed or a rename in the Console drawer), it sticks.
// Otherwise Android would silently clobber a Console-drawer rename back to
// its own stored name on every app relaunch.
const urlDeviceLabel = new URLSearchParams(window.location.search).get("device_label");
if (urlDeviceLabel && !localStorage.getItem("deviceLabel")) {
  localStorage.setItem("deviceLabel", urlDeviceLabel);
}
if (new URL(window.location.href).searchParams.has("device_label")) {
  const url = new URL(window.location.href);
  url.searchParams.delete("device_label");
  window.history.replaceState({}, "", url.toString());
}
const HAS_DEVICE_LABEL = !!localStorage.getItem("deviceLabel");

function guessDeviceLabel() {
  const ua = navigator.userAgent || "";
  const platform = /iPhone|iPad/.test(ua) ? "iPhone/iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : "Device";
  const browser = /CriOS|Chrome/.test(ua) ? "Chrome"
    : /Safari/.test(ua) ? "Safari"
    : /Firefox/.test(ua) ? "Firefox"
    : "Browser";
  return `${platform} · ${browser}`;
}
function getDeviceLabel() {
  return localStorage.getItem("deviceLabel") || guessDeviceLabel();
}

// Every fetch() call in this file targets the companion API with a relative
// path — rather than threading the Authorization header through every call
// site, attach it once here so existing fetch(...) calls need no changes.
const _rawFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const headers = { ...(init.headers || {}), "X-Device-Id": DEVICE_ID };
  if (PAIR_TOKEN) headers["Authorization"] = `Bearer ${PAIR_TOKEN}`;
  return _rawFetch(input, { ...init, headers });
};

const API = "";
// In dev (port 3000) webpack-dev-server claims /ws for HMR — connect directly to the backend instead
const wsParams = new URLSearchParams({ device_id: DEVICE_ID, device: getDeviceLabel() });
if (PAIR_TOKEN) wsParams.set("token", PAIR_TOKEN);
const WS_URL = (window.location.port === "3000"
  ? "ws://127.0.0.1:9760/ws"
  : `ws://${window.location.host}/ws`) + `?${wsParams.toString()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const fmt = s => { const m = Math.floor(s/60), sec = Math.floor(s%60); return `${m}:${sec.toString().padStart(2,"0")}`; };
const fmtClock = s => { const t = Math.max(0, s); const m = Math.floor(t/60), sec = Math.floor(t%60); return `${m.toString().padStart(2,"0")}:${sec.toString().padStart(2,"0")}`; };
const rppName = path => path ? path.replace(/\\/g, "/").split("/").pop().replace(/\.rpp$/i, "") : "";
const uid = () => `sl_${Date.now()}_${Math.random().toString(36).slice(2)}`;

// ─────────────────────────────────────────────────────────────────────────────
// Setlist persistence — saved to disk via backend API (survives rebuilds)
// ─────────────────────────────────────────────────────────────────────────────
async function loadAllSetlistsFromDisk() {
  try {
    const data = await fetch(`${API}/setlists`).then(r => r.json());
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function saveAllSetlistsToDisk(lists) {
  try {
    await fetch(`${API}/setlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setlists: lists }),
    });
  } catch (e) { console.error("Failed to save setlists:", e); }
}
function makeNewSetlist(name = "New Setlist", rppPath = "") {
  return { id: uid(), name, rppPath, items: [], midiDevices: [], createdAt: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// DeviceNameGate — blocks the whole app until this device has a real name.
// Only shown when HAS_DEVICE_LABEL is false; on submit, saves the name and
// reloads so every module-level const that bakes the label into a URL
// (WS_URL, etc.) picks it up fresh rather than needing live re-computation.
// ─────────────────────────────────────────────────────────────────────────────
function DeviceNameGate() {
  const [name, setName] = useState(guessDeviceLabel());
  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    localStorage.setItem("deviceLabel", trimmed);
    window.location.reload();
  }
  return (
    <div className="overlay welcome-overlay">
      <div className="welcome-modal" onClick={e => e.stopPropagation()}>
        <div className="welcome-header">
          <span className="logo-gem">◈</span>
          <span className="welcome-title">NAME THIS DEVICE</span>
        </div>
        <div className="welcome-body">
          <p className="welcome-subtitle">
            Whoever's running the show needs to tell devices apart at a glance —
            give this one a name (e.g. "Kyle's Phone", "Stage Left Tablet").
          </p>
          <input className="modal-input" autoFocus value={name} maxLength={40}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            placeholder="Device name" spellCheck={false} />
        </div>
        <div className="welcome-footer">
          <button className="welcome-start-btn" onClick={submit} disabled={!name.trim()}>CONTINUE</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge
// ─────────────────────────────────────────────────────────────────────────────
function StatusBadge({ reaperConnected, wsConnected }) {
  const [state, label] = !wsConnected
    ? ["offline",  "OFFLINE"]
    : !reaperConnected
    ? ["warning", "REAPER NOT FOUND"]
    : ["live",    "REAPER LIVE"];
  return (
    <div className={`status-badge status-${state}`}>
      <span className="status-pip" />
      {label}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RegionRow (browser panel)
// ─────────────────────────────────────────────────────────────────────────────
function RegionRow({ region, highlighted, onClick, onAdd, onPlay }) {
  return (
    <div
      className={`region-row${highlighted ? " hl" : ""}`}
      style={{ "--rc": region.color }}
      onClick={onClick}
    >
      <span className="region-dot" style={{ background: region.color }} />
      <div className="region-row-info">
        <span className="region-row-name">{region.name}</span>
        <span className="region-row-time">{fmt(region.start)}–{fmt(region.end)} · {fmt(region.end - region.start)}</span>
      </div>
      {onPlay && <button className="row-play" onClick={e => { e.stopPropagation(); onPlay(region); }} title="Play in Reaper">▶</button>}
      <button className="row-add" onClick={e => { e.stopPropagation(); onAdd(region); }} title="Add to setlist">+</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Child row (inside a folder item)
// ─────────────────────────────────────────────────────────────────────────────
function ChildRow({ child, parentIdx, childIdx, isSelected, isCurrent, isPlaying, editMode, onSelect, onRemove, onPlay, position, dragAttrs, dragListeners }) {
  const live = child; // caller passes getLiveItem(child) already
  const dur = live.end - live.start;
  const progress = isCurrent && dur > 0 ? Math.max(0, Math.min(1, (position - live.start) / dur)) : 0;
  return (
    <div className={"child-row" + (isCurrent ? " current" : "") + (isCurrent && isPlaying ? " playing" : "")}>
      {isCurrent && progress > 0 && <div className="sl-progress-fill" style={{width: (progress*100)+"%"}} />}
      <div className="child-connector" />
      {editMode && dragListeners && (
        <div className="sl-drag child-drag" {...dragAttrs} {...dragListeners} title="Drag to reorder">⣿</div>
      )}
      <div className="sl-color" style={{background: live.color}} />
      <div className="sl-info">
        <span className="sl-name">{live.name}</span>
        <span className="sl-dur">{fmt(live.end - live.start)}</span>
      </div>
      <div className="sl-actions">
        {editMode ? (<>
          <button className={"sl-btn" + (isSelected ? " sel-child" : "")} onClick={onSelect} title="Use this for total time">●</button>
          <button className="sl-btn remove" onClick={onRemove} title="Remove">✕</button>
        </>) : (
          <button className="sl-btn play" onClick={onPlay} title="Play">▶</button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ContainerHeader component
// ─────────────────────────────────────────────────────────────────────────────
function ContainerHeader({ item, editMode, onCollapse, onRename, onRemove, onAddChild, onToggleSoundcheck, onToggleDisabled, onSelectFirst, activeChildName, hasPACWaiting, totalTime, dragAttrs, dragListeners }) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(item.name);
  function commit() { setEditing(false); onRename(item.id, name); }
  return (
    <div className={`container-header${item.isSoundcheck ? " soundcheck-hdr" : ""}${item.disabled ? " disabled-hdr" : ""}`}>
      {editMode && (
        <div className="container-drag" {...dragAttrs} {...dragListeners} title="Drag to reorder">⣿</div>
      )}
      <button className="container-collapse-btn" onClick={() => onCollapse(item.id)}>
        {item.collapsed ? "▶" : "▼"}
      </button>
      {editing ? (
        <input className="container-name-input" autoFocus value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if(e.key==="Enter") commit(); if(e.key==="Escape") setEditing(false); }} />
      ) : (
        <span className="container-name"
          onClick={() => { if (!editing) onSelectFirst?.(); }}
          onDoubleClick={() => editMode && setEditing(true)}>
          {item.name}
          {activeChildName && <span style={{color:'var(--blue)',marginLeft:8,fontWeight:400,textTransform:'none',fontSize:'0.85em'}}>→ {activeChildName}</span>}
        </span>
      )}
      {hasPACWaiting && <span className="waiting-input-flash">WAITING</span>}
      {totalTime > 0 && <span className="container-total-time">{fmt(totalTime)}</span>}
      {editMode && (
        <div className="container-actions">
          <button className="container-btn" onClick={() => onAddChild(item.id)} title="Add highlighted region">+ Region</button>
          <button
            className={`container-btn${item.isSoundcheck ? " soundcheck-active" : ""}`}
            onClick={() => onToggleSoundcheck(item.id)}
            title="Toggle soundcheck (manual play only, excluded from auto-advance)">
            SC
          </button>
          <button
            className={`container-btn${item.disabled ? " disabled-off" : " disabled-on"}`}
            onClick={() => onToggleDisabled(item.id)}
            title="Disable section (hidden in stage view, excluded from playback)">
            {item.disabled ? "OFF" : "ON"}
          </button>
          <button className="container-btn remove" onClick={() => onRemove(item.id)} title="Remove section">✕</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable container block wrapper
// ─────────────────────────────────────────────────────────────────────────────
function SortableContainerBlock({ id, editMode, className, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !editMode });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.2 : 1 }}
      className={`container-block${className ? " " + className : ""}`}
    >
      {children({ dragAttrs: attributes, dragListeners: listeners })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable PAC leaf wrapper
// ─────────────────────────────────────────────────────────────────────────────
function SortableLeafItem({ id, disabled, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.2 : 1 }}
    >
      {children(attributes, listeners)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable setlist row
// ─────────────────────────────────────────────────────────────────────────────
function SetlistRow({ item, index, displayIndex, isCurrent, isPlaying, editMode, onPlay, onPause, onRemove, onFocus, isFocused, position, onToggleLoop, onToggleFolder, onToggleCollapsed, onToggleKeycommand }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !editMode });
  const ref = useRef(null);
  useEffect(() => { if (isFocused && ref.current) ref.current.focus(); }, [isFocused]);

  const dur = item.end - item.start;
  const progress = (isCurrent && dur > 0)
    ? Math.max(0, Math.min(1, (position - item.start) / dur))
    : 0;

  return (
    <div
      ref={el => { setNodeRef(el); ref.current = el; }}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.2 : 1 }}
      className={"sl-row" + (isCurrent ? " current" : "") + (isCurrent && isPlaying ? " playing" : "") + (isFocused ? " focused" : "")}
      tabIndex={0} onFocus={onFocus}
      onDoubleClick={() => onPlay(item, index)}
    >
      {isCurrent && progress > 0 && (
        <div className="sl-progress-fill" style={{ width: (progress * 100) + "%" }} />
      )}
      <div className="sl-num">{displayIndex ?? (index + 1)}</div>
      <div className="sl-color" style={{ background: item.color }} />
      {editMode && <div className="sl-drag" {...attributes} {...listeners} title="Drag">⣿</div>}
      <div className="sl-info">
        <span className="sl-name">{item.name}</span>
        {item.infiniteLoop && <span className="sl-badge loop-badge">∞</span>}
        {item.isFolder && <span className="sl-badge folder-badge">⊞ {(item.children||[]).length}</span>}
        {item.isFolder && item.keycommand && <span className="sl-badge kc-folder-badge">⌨</span>}
        <span className="sl-dur">{fmt(item.end - item.start)}</span>
      </div>
      {editMode ? (
        <div className="sl-actions">
          <button className="sl-btn play" onClick={() => onPlay(item, index)} title="Play">▶</button>
          <button className="sl-btn remove" onClick={() => onRemove(item.id)} title="Remove">✕</button>
          <div className="sl-flags">
            <button className={"sl-flag-btn" + (item.infiniteLoop ? " active" : "")} onClick={e => { e.stopPropagation(); onToggleLoop(item.id); }} title="Infinite loop">∞</button>
            <button className={"sl-flag-btn" + (item.isFolder ? " active" : "")} onClick={e => { e.stopPropagation(); onToggleFolder(item.id); }} title="Folder/nested">⊞</button>
            {item.isFolder && <button className="sl-flag-btn" onClick={e => { e.stopPropagation(); onToggleCollapsed(item.id); }} title="Expand/collapse">{item.collapsed ? "▶" : "▼"}</button>}
            {item.isFolder && (
              <button className={"sl-flag-btn" + (item.keycommand ? " active" : "")}
                onClick={e => { e.stopPropagation(); onToggleKeycommand(item.id); }}
                title="Keycommand folder (1-9 triggers children)">⌨</button>
            )}
          </div>
        </div>
      ) : (
        <div className="sl-actions">
          {isCurrent && isPlaying
            ? <button className="sl-btn pause" onClick={onPause} title="Pause">⏸</button>
            : <button className="sl-btn play" onClick={() => onPlay(item, index)} title="Play">▶</button>}
        </div>
      )}
      {isCurrent && isPlaying && <div className="sl-playing-bar" />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// File Menu
// ─────────────────────────────────────────────────────────────────────────────
function FileMenu({ setlists, activeId, onNew, onLoad, onRename, onDelete, onClose }) {
  const [renaming, setRenaming] = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const sorted = [...setlists].sort((a,b) => (b.lastUsed || b.createdAt||0) - (a.lastUsed || a.createdAt||0));

  function startRename(sl, e) { e.stopPropagation(); setRenaming(sl.id); setRenameVal(sl.name); }
  function commitRename(id) { if (renameVal.trim()) onRename(id, renameVal.trim()); setRenaming(null); }

  return (
    <div className="fm-overlay" onClick={onClose}>
      <div className="fm-drawer" onClick={e => e.stopPropagation()}>
        <div className="fm-header">
          <span>SETLISTS</span>
          <button className="fm-close" onClick={onClose}>✕</button>
        </div>
        <div className="fm-new-row">
          <button className="fm-new-btn" onClick={onNew}>+ NEW SETLIST</button>
        </div>
        <div className="fm-list">
          {sorted.length === 0 && <div className="fm-empty">No setlists yet — create one!</div>}
          {sorted.map(sl => (
            <div key={sl.id} className={"fm-row" + (sl.id === activeId ? " active" : "")}>
              {renaming === sl.id ? (
                <input autoFocus className="fm-rename-input" value={renameVal}
                  maxLength={100}
                  onChange={e => setRenameVal(e.target.value)}
                  onBlur={() => commitRename(sl.id)}
                  onKeyDown={e => { if(e.key==="Enter") commitRename(sl.id); if(e.key==="Escape") setRenaming(null); }} />
              ) : (<>
                <div className="fm-row-info" onClick={() => { onLoad(sl.id); onClose(); }}>
                  <span className="fm-row-name">{sl.name}</span>
                  <span className="fm-row-meta">
                    {sl.items?.length || 0} items
                    {sl.rppPath ? " · " + sl.rppPath.split(/[\/]/).pop().replace(/\.rpp$/i,"") : ""}
                  </span>
                </div>
                <div className="fm-row-actions">
                  <button className="fm-btn" onClick={e => startRename(sl,e)} title="Rename">✎</button>
                  <button className="fm-btn danger" onClick={e => { e.stopPropagation(); onDelete(sl.id); }} title="Delete">✕</button>
                </div>
              </>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Project Drawer — link a .rpp file to the current setlist
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// MidiDeviceBar — shows selected MIDI devices with connection indicator
// ─────────────────────────────────────────────────────────────────────────────
function MidiDeviceBar({ devices, availableDevices }) {
  const getStatus = (dev) => {
    const match = (availableDevices || []).find(d => d.name === dev.name && d.type === dev.type);
    if (!match) return "missing";       // not detected by Reaper at all
    if (match.enabled === false) return "disabled";  // detected but disabled in prefs
    return "connected";
  };

  const handleClick = (dev) => {
    if (dev.testCC != null && dev.testCC !== "" && dev.type === "output") {
      fetch(`${API}/midi/send-cc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: dev.name, cc: parseInt(dev.testCC, 10), value: 127 }),
      }).catch(() => {});
    } else {
      fetch(`${API}/midi-reset`, { method: "POST" }).catch(() => {});
    }
  };

  if (!devices || devices.length === 0) return null;
  return (
    <div className="midi-device-bar">
      <span className="tabs-lbl">MIDI</span>
      {devices.map((dev, i) => {
        const status = getStatus(dev);
        const label = status === "connected" ? "Connected"
                    : status === "disabled"  ? "Disabled in Reaper prefs"
                    : "Not detected";
        const hasCC = dev.testCC != null && dev.testCC !== "" && dev.type === "output";
        const clickHint = hasCC ? `Click to send CC${dev.testCC}` : "Click to reset MIDI devices";
        return (
          <div key={i} className={`midi-chip midi-chip-${status}`}
            title={`${dev.type === "input" ? "IN" : "OUT"}: ${dev.name} — ${label}\n${clickHint}`}
            onClick={() => handleClick(dev)} style={{cursor:"pointer"}}>
            <span className={`midi-pip midi-pip-${status}`} />
            <span className="midi-chip-name">{dev.name}</span>
            <span className="midi-chip-dir">{dev.type === "input" ? "↓" : "↑"}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProjectDrawer({ setlist, onUpdateRpp, onClose, tracks, clickTrackIdx, mainTrackIdx, onClickTrack, onMainTrack, autoAdvance, onAutoAdvance, availableMidi, onUpdateMidiDevices }) {
  const [fetching,      setFetching]      = useState(false);
  const [flash,         setFlash]         = useState(false);

  async function useCurrent() {
    setFetching(true);
    try {
      const data = await fetch(`${API}/link-current-project`, { method: "POST" }).then(r => r.json());
      if (data.path) { onUpdateRpp(data.path); setFlash(true); setTimeout(() => setFlash(false), 1400); }
    } catch (e) { console.error(e); }
    finally { setFetching(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="side-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-hdr">
          <span>PROJECT SETTINGS{setlist ? ` — ${setlist.name}` : ""}</span>
          <button className="fm-close" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-scroll">

          {/* ── LEFT COLUMN ── */}
          <div className="drawer-col">
            <label className="sd-label">REAPER PROJECT (.rpp)</label>
            <p className="sd-hint">When this setlist is loaded, Genius SetList will save the current project and open this one automatically.</p>

            <button className={`sd-use-current${flash ? " flash" : ""}`}
              onClick={useCurrent} disabled={fetching}>
              {fetching ? "FETCHING..." : flash ? "✓ PROJECT SET" : "⟳ USE CURRENT PROJECT"}
            </button>

            <div className="sd-row">
              <input className="sd-input" type="text"
                value={setlist?.rppPath || ""}
                onChange={e => onUpdateRpp(e.target.value)}
                placeholder="C:\path\to\project.rpp"
                spellCheck={false} />
            </div>
            {setlist?.rppPath && (
              <button className="sd-clear" onClick={() => onUpdateRpp("")}>✕ Clear project link</button>
            )}

            <label className="sd-label" style={{marginTop: 20}}>CLICK TRACK</label>
            <select className="sd-select" value={clickTrackIdx} onChange={e => onClickTrack(Number(e.target.value))}>
              <option value={-1}>— None</option>
              {(tracks || []).map(t => (
                <option key={t.index} value={t.index}>{t.name || `Track ${t.index + 1}`}</option>
              ))}
            </select>

            <label className="sd-label" style={{marginTop: 12}}>MAIN TRACKS</label>
            <select className="sd-select" value={mainTrackIdx} onChange={e => onMainTrack(Number(e.target.value))}>
              <option value={-1}>— None</option>
              {(tracks || []).map(t => (
                <option key={t.index} value={t.index}>{t.name || `Track ${t.index + 1}`}</option>
              ))}
            </select>
          </div>

          {/* ── RIGHT COLUMN ── */}
          <div className="drawer-col">
            <label className="sd-label">PLAYBACK</label>
            <label className="sd-checkbox-row">
              <input type="checkbox" checked={autoAdvance} onChange={e => onAutoAdvance(e.target.checked)} />
              <span>Auto-advance to next song</span>
            </label>

            <label className="sd-label" style={{marginTop: 20}}>MIDI DEVICES</label>
            <p className="sd-hint">Select devices to monitor. For output devices, set a CC# to send a test message when you click the device indicator.</p>
            {(() => {
              const selectedDevs = setlist?.midiDevices || [];
              // Devices that are selected but not currently visible in Reaper
              const missingDevs = selectedDevs.filter(d =>
                !(availableMidi || []).some(a => a.name === d.name && a.type === d.type)
              );
              const updateCC = (dev, cc) => {
                const next = selectedDevs.map(d =>
                  d.name === dev.name && d.type === dev.type ? { ...d, testCC: cc } : d
                );
                onUpdateMidiDevices(next);
              };
              return (
                <div className="sd-midi-list">
                  {(!availableMidi || availableMidi.length === 0) && missingDevs.length === 0 && (
                    <p className="sd-hint" style={{color:"var(--text3)",fontStyle:"italic"}}>No MIDI devices detected — connect the Reaper bridge to see available devices.</p>
                  )}
                  {(availableMidi || []).map(dev => {
                    const sel = selectedDevs.find(d => d.name === dev.name && d.type === dev.type);
                    const selected = !!sel;
                    return (
                      <div key={`${dev.type}-${dev.index}`} className="sd-midi-row">
                        <label className="sd-checkbox-row" style={{flex:1,marginBottom:0}}>
                          <input type="checkbox" checked={selected}
                            onChange={e => {
                              const next = e.target.checked
                                ? [...selectedDevs, { index: dev.index, name: dev.name, type: dev.type }]
                                : selectedDevs.filter(d => !(d.name === dev.name && d.type === dev.type));
                              onUpdateMidiDevices(next);
                            }} />
                          <span className="midi-type-badge">{dev.type === "input" ? "↓ IN" : "↑ OUT"}</span>
                          <span>{dev.name}</span>
                        </label>
                        {selected && dev.type === "output" && (
                          <input type="number" min="0" max="127" placeholder="CC#"
                            className="sd-cc-input"
                            value={sel?.testCC ?? ""}
                            onChange={e => updateCC(dev, e.target.value)}
                            title="CC number to send on chip click (0–127)" />
                        )}
                      </div>
                    );
                  })}
                  {missingDevs.map(dev => {
                    return (
                      <div key={`missing-${dev.type}-${dev.name}`} className="sd-midi-row">
                        <label className="sd-checkbox-row sd-midi-missing" style={{flex:1,marginBottom:0}}
                          title="This device is no longer detected by Reaper">
                          <input type="checkbox" checked={true}
                            onChange={() => {
                              const next = selectedDevs.filter(d => !(d.name === dev.name && d.type === dev.type));
                              onUpdateMidiDevices(next);
                            }} />
                          <span className="midi-type-badge">{dev.type === "input" ? "↓ IN" : "↑ OUT"}</span>
                          <span>{dev.name}</span>
                          <span className="sd-midi-missing-badge">⚠ offline</span>
                        </label>
                        {dev.type === "output" && (
                          <input type="number" min="0" max="127" placeholder="CC#"
                            className="sd-cc-input"
                            value={dev.testCC ?? ""}
                            onChange={e => updateCC(dev, e.target.value)}
                            title="CC number to send on chip click (0–127)" />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>

        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Console Drawer — diagnostics and reapy setup
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function ConsoleDrawer({ onClose, onHelp, trackPeaks, clickTrackIdx, mainTrackIdx, tracks }) {
  const [diagData,    setDiagData]    = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [diagLog,     setDiagLog]     = useState([]);
  const [deviceName,  setDeviceName]  = useState(getDeviceLabel());
  const logRef = useRef(null);

  function saveDeviceName() {
    const name = deviceName.trim() || guessDeviceLabel();
    localStorage.setItem("deviceLabel", name);
    // The label only travels at WS-connect time, so reload to reconnect
    // with the new name — the tray's device list picks it up immediately.
    window.location.reload();
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [diagLog]);

  function addLog(type, text) {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setDiagLog(prev => [...prev, { type, text, ts }]);
  }

  async function runDiagnostics() {
    setDiagLoading(true);
    setDiagLog([]);
    addLog("info", "Running diagnostics...");
    try {
      const data = await fetch(`${API}/health`).then(r => r.json());
      setDiagData(data);
      addLog("ok",   `API responding on port ${data.api_port}`);
      addLog("info", `Python ${data.python_version} on ${data.platform}`);
      addLog("info", `Interface: ${data.interface}`);
      addLog("info", `State file: ${data.state_file}`);

      if (data.reaper_connected) {
        addLog("ok",  "Reaper bridge connected");
        if (data.current_project) addLog("ok",   `Project: ${data.current_project}`);
        addLog("info", `Regions: ${data.region_count}`);

        // Peak / track diagnostics
        try {
          const dbg = await fetch(`${API}/debug/bridge`).then(r => r.json());
          const rawPeaks = dbg.raw_state?.peaks;
          if (!rawPeaks || rawPeaks.length === 0) {
            addLog("warn", "No peaks in bridge state — reload genius_bridge.lua in Reaper");
          } else {
            addLog("ok",   `Peaks in bridge: ${rawPeaks.length} tracks`);
            rawPeaks.forEach((p, i) => {
              const db = p > 0 ? (20 * Math.log10(p)).toFixed(1) : "-∞";
              addLog("info", `  Track ${i}: ${db} dBFS (amp=${p})`);
            });
          }
        } catch(e) { addLog("warn", `Could not fetch peak debug: ${e.message}`); }

        addLog("sep", "--- Track assignments -------------------------");
        addLog(clickTrackIdx >= 0 ? "ok" : "warn",
          `Click track: ${clickTrackIdx >= 0 ? `#${clickTrackIdx} (${tracks[clickTrackIdx]?.name || "?"})` : "NOT ASSIGNED — open setlist settings"}`);
        addLog(mainTrackIdx >= 0 ? "ok" : "warn",
          `Main tracks: ${mainTrackIdx >= 0 ? `#${mainTrackIdx} (${tracks[mainTrackIdx]?.name || "?"})` : "NOT ASSIGNED — open setlist settings"}`);
        if (trackPeaks.length > 0) {
          addLog("ok", `Frontend receiving peaks: ${trackPeaks.length} tracks`);
        } else {
          addLog("warn", "Frontend trackPeaks array is empty (WS not delivering peaks)");
        }

        addLog("sep", "--- All systems go ----------------------------");
        addLog("ok",  "Genius SetList is fully connected to Reaper.");
      } else {
        addLog("err", "Bridge not connected");
        if (data.issues) data.issues.forEach(i => addLog("warn", i));
        addLog("sep", "--- Setup steps -------------------------------");
        addLog("fix", "1. Click INSTALL BRIDGE SCRIPT below");
        addLog("fix", "2. Open Reaper");
        addLog("fix", "3. Actions > Load ReaScript > genius_bridge.lua > Run");
        addLog("fix", "4. Optionally: Actions > Add to startup actions");
        addLog("fix", "5. Click Refresh — regions will appear automatically");
      }
      addLog("info", `WS: ws://${window.location.host}/ws`);
    } catch (e) {
      addLog("err", `Cannot reach API: ${e.message}`);
    } finally {
      setDiagLoading(false);
      addLog("info", "Done.");
    }
  }

  async function installBridge() {
    setDiagLoading(true);
    addLog("sep", "--- Installing bridge script -------------------");
    try {
      const data = await fetch(`${API}/install-bridge`, { method: "POST" }).then(r => r.json());
      data.log.forEach(line => {
        const type = line.startsWith("OK:") ? "ok" : line.startsWith("FAIL:") ? "err" : "fix";
        addLog(type, line);
      });
      if (data.script_path) addLog("ok", `Script ready at: ${data.script_path}`);
    } catch(e) {
      addLog("err", `Install failed: ${e.message}`);
    } finally {
      setDiagLoading(false);
    }
  }

  // Run on open
  useEffect(() => { runDiagnostics(); }, []);

  const LOG_ICONS = { ok: "✓", err: "✗", warn: "⚠", info: "·", fix: "→", sep: "" };
  const LOG_CLS   = { ok: "log-ok", err: "log-err", warn: "log-warn", info: "log-info", fix: "log-fix", sep: "log-sep" };
  const busy = diagLoading;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="side-drawer console-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-hdr">
          <span>CONSOLE</span>
          <div style={{display:"flex",gap:6}}>
            <button className="console-refresh" onClick={onHelp} title="View setup instructions">
              ? HELP
            </button>
            <button className="console-refresh" onClick={runDiagnostics} disabled={busy}>
              {diagLoading ? "RUNNING..." : "↺ REFRESH"}
            </button>
            <button className="fm-close" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Device name — shown in the tray app's device list so you can tell devices apart */}
        <div className="con-row" style={{padding:"0 16px"}}>
          <div className="con-lbl">THIS DEVICE'S NAME</div>
          <div style={{display:"flex",gap:6}}>
            <input className="sd-input" value={deviceName} spellCheck={false}
              onChange={e => setDeviceName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveDeviceName()}
              style={{flex:1}} />
            <button className="console-refresh" onClick={saveDeviceName}>SAVE</button>
          </div>
        </div>

        {/* Status pills */}
        {diagData && (
          <div className="console-pills">
            <span className={`cpill ${diagData.reaper_connected ? "green" : "red"}`}>
              {diagData.reaper_connected ? "● REAPER" : "○ REAPER"}
            </span>
            <span className="cpill blue">● API :{diagData.api_port}</span>
            {diagData.reaper_version && (
              <span className="cpill grey">v{diagData.reaper_version}</span>
            )}
          </div>
        )}

        {/* Log */}
        <div className="console-log" ref={logRef}>
          {diagLog.map((line, i) => (
            <div key={i} className={`log-line ${LOG_CLS[line.type] || ""}`}>
              <span className="log-ts">{line.ts}</span>
              <span className="log-icon">{LOG_ICONS[line.type] || ""}</span>
              <span className="log-text">{line.text}</span>
            </div>
          ))}
          {busy && (
            <div className="log-line log-info">
              <span className="log-ts"></span>
              <span className="log-icon">·</span>
              <span className="log-blink">_</span>
            </div>
          )}
        </div>

        {diagData && !diagData.reaper_connected && !busy && (
          <div className="configure-cta">
            <div className="chelp-title">SETUP — ONE TIME ONLY</div>
            <div className="cta-steps">
              <div className="cta-step"><span className="cta-num">1</span><span>Click <strong>INSTALL BRIDGE</strong> below</span></div>
              <div className="cta-step"><span className="cta-num">2</span><span>Open <strong>Reaper</strong></span></div>
              <div className="cta-step"><span className="cta-num">3</span><span><strong>Actions &gt; Load ReaScript &gt; genius_bridge.lua &gt; Run</strong></span></div>
              <div className="cta-step"><span className="cta-num">4</span><span>Optional: <strong>Actions &gt; Add to startup actions</strong> so it auto-runs</span></div>
            </div>
            <button className="configure-reapy-btn" onClick={installBridge} disabled={busy}>
              ⬇ INSTALL BRIDGE SCRIPT
            </button>
          </div>
        )}

        {diagData?.reaper_connected && !busy && (
          <div className="console-all-good">
            <span className="cag-icon">✓</span>
            <span>Connected — everything is working</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Regions Drawer (mobile / narrow)
// ─────────────────────────────────────────────────────────────────────────────
function RegionsDrawer({ regions, loading, search, setSearch, highlightedIdx, setHighlightedIdx,
                          onAdd, onPlaySelected, reaperConnected, onClose, listRef, onKeyDown }) {
  const filtered = regions.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="regions-drawer" onClick={e => e.stopPropagation()}>
        <div className="rd-header">
          <span>REGIONS</span>
          <button className="fm-close" onClick={onClose}>✕</button>
        </div>
        <div className="rd-search">
          <span className="search-icon">⌕</span>
          <input className="search-input" autoFocus value={search}
            onChange={e => setSearch(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search regions…" spellCheck={false} />
          {search && <button className="search-clear" onClick={() => setSearch("")}>✕</button>}
        </div>
        <div className="rd-list" ref={listRef}>
          {loading ? <div className="loading"><div className="spinner"/><span>Loading…</span></div>
          : filtered.length === 0 ? <div className="empty-state"><span>No regions found</span></div>
          : filtered.map((r, i) => (
            <RegionRow key={r.id} region={r} highlighted={i === highlightedIdx}
              onClick={() => setHighlightedIdx(i)} onAdd={reg => { onAdd(reg); onClose(); }} />
          ))}
        </div>
        <div className="search-hint">↑↓ navigate · Enter add · Esc close</div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// VU Meter — vertical audio level meter with track selector
// Uses Web Audio API to capture system audio (requires browser support)
// ─────────────────────────────────────────────────────────────────────────────
// dB scale: -50 dBFS (floor) to +12 dBFS (ceiling)
const DB_MIN = -50;
const DB_MAX = 12;
const DB_RANGE = DB_MAX - DB_MIN; // 62

function ampToPos(amp) {
  if (!amp || amp <= 0) return 0;
  const db = 20 * Math.log10(amp);
  return Math.max(0, Math.min(1, (db - DB_MIN) / DB_RANGE));
}

function ampToDb(amp) {
  if (!amp || amp <= 0) return null;
  return 20 * Math.log10(amp);
}

// -6 dBFS threshold: 10^(-6/20) ≈ 0.5012
const CLICK_THRESHOLD = Math.pow(10, -6 / 20);

function ClickFlash({ level, stage }) {
  const prevRef = useRef(0);
  const cur = level || 0;
  const prev = prevRef.current;
  // Light on rising edge only — turn off immediately when level starts to drop
  const lit = cur > CLICK_THRESHOLD && cur >= prev;
  prevRef.current = cur;
  const noTrack = level === undefined;
  return (
    <div className={`click-flash${lit ? " lit" : ""}${noTrack ? " no-track" : ""}${stage ? " stage" : ""}`} title="CLICK TRACK">
      <svg className="click-flash-icon" viewBox="0 0 10 18" aria-hidden="true" fill="currentColor">
        <polygon points="5,0 10,18 0,18" />
      </svg>
    </div>
  );
}

function VUMeter({ label, level: externalLevel }) {
  const [pos,     setPos]     = useState(0); // normalized 0–1 on dB scale
  const [peakPos, setPeakPos] = useState(0);
  const peakTimer = useRef(null);

  // Real level from Reaper (linear amplitude, 1.0 = 0 dBFS, ~3.98 = +12 dBFS)
  // externalLevel is undefined when no track is assigned → meter stays at 0
  useEffect(() => {
    setPos(externalLevel !== undefined ? ampToPos(externalLevel) : 0);
  }, [externalLevel]);

  // Peak hold
  useEffect(() => {
    if (pos > peakPos) {
      setPeakPos(pos);
      clearTimeout(peakTimer.current);
      peakTimer.current = setTimeout(() => setPeakPos(0), 1500);
    }
  }, [pos]);

  const SEGMENTS = 40;
  const segments = Array.from({length: SEGMENTS}, (_, i) => {
    const segPos = i / SEGMENTS;
    const segDb  = DB_MIN + segPos * DB_RANGE;
    const lit    = pos >= segPos;
    const isPeak = peakPos > 0 && Math.abs(peakPos - segPos) < (1 / SEGMENTS);
    const isHot  = segDb >= 0;          // 0 dBFS to +12 dBFS → red
    const isWarm = segDb >= -6;         // -6 dBFS to 0 dBFS → yellow
    return { lit, isPeak, isHot, isWarm };
  }).reverse(); // top = loudest

  const noTrack = externalLevel === undefined;
  const dbVal   = noTrack ? null : ampToDb(externalLevel);
  const dbText  = noTrack ? "NO TRK" : dbVal === null ? "-∞" : `${dbVal >= 0 ? "+" : ""}${dbVal.toFixed(1)}`;

  return (
    <div className={`vu-meter${noTrack ? " vu-notrack" : " vu-connected"}`}>
      <div className="vu-label">{label}</div>
      <div className="vu-bar">
        {segments.map((seg, i) => (
          <div key={i} className={
            "vu-seg" +
            (seg.lit    ? (seg.isHot ? " hot" : seg.isWarm ? " warm" : " lit") : "") +
            (seg.isPeak ? " peak" : "")
          } />
        ))}
      </div>
      <div className="vu-db">{dbText}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MobileStageView — phone-shaped performance screen, modeled directly on the
// old desktop app's standalone mobile.html (numbered rows, PAC slide-up
// panel, big "selected song" bar) rather than the desktop 3-column Stage
// view, which assumes a wide monitor. All the underlying state (playback
// items, focus tracking, PAC/soundcheck containers) is identical to the
// desktop view — this only changes what gets rendered and how it's tapped.
// ─────────────────────────────────────────────────────────────────────────────
// Hotkeys are per-device (stored in this browser's localStorage, so each
// phone/laptop keeps its own bindings) and only meaningful on a device that
// actually has a keyboard attached — a Bluetooth remote/pedal sends the same
// keydown events a real keyboard would.
const HOTKEY_STORAGE_KEY = "stageHotkeys";
const HOTKEY_ACTIONS = [
  { id: "playPause", label: "Play / Pause" },
  { id: "stop", label: "Stop" },
  { id: "next", label: "Next Song" },
  { id: "prev", label: "Previous Song" },
  { id: "pac1", label: "Pick A Cover — Option 1" },
  { id: "pac2", label: "Pick A Cover — Option 2" },
  { id: "pac3", label: "Pick A Cover — Option 3" },
];

function loadHotkeys() {
  try { return JSON.parse(localStorage.getItem(HOTKEY_STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function normalizeKey(e) {
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

function formatKeyLabel(k) {
  return k ? k : "Not set";
}

function MobileStageView({
  activeSetlist, setlistItems, playbackItems,
  currentIndex, currentChildIndex, focusedIndex, focusedSCItemId, focusedNestedItemId,
  isPlaying, position, stageElapsed, stageTotalTime,
  stageCollapsed, toggleStageCollapsed, getLiveItem,
  setFocusedIndex, setFocusedSCItemId, setFocusedNestedItemId,
  playItem, clickTrackIdx, mainTrackIdx, trackPeaks, canControl,
  onPlayPause, onStop, onNext, onPrev,
}) {
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const [listeningFor, setListeningFor] = useState(null);
  const currentPlayingItemId = currentIndex >= 0 ? playbackItems[currentIndex]?.id : null;
  const currentPlayingParent = currentIndex >= 0 ? playbackItems[currentIndex] : null;

  // PAC panel only appears while its folder is the item actually PLAYING and
  // no child has been picked yet — matches mobile.html's renderPACPanel().
  const showPacPanel = !!(currentPlayingParent?.isFolder && currentPlayingParent?.keycommand
    && isPlaying && currentChildIndex === -1);

  // Fires bound actions on keydown. Disabled while capturing a new binding
  // (the effect below owns the keyboard then) and for view-only devices —
  // same gate the transport buttons already respect.
  useEffect(() => {
    if (listeningFor || !canControl) return;
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = normalizeKey(e);
      const action = Object.keys(hotkeys).find(a => hotkeys[a] === k);
      if (!action) return;
      e.preventDefault();
      if (action === "playPause") onPlayPause();
      else if (action === "stop") onStop();
      else if (action === "next") onNext();
      else if (action === "prev") onPrev();
      else if (action.startsWith("pac")) {
        const idx = parseInt(action.slice(3), 10) - 1;
        if (showPacPanel && currentPlayingParent?.children?.[idx]) {
          playItem(currentPlayingParent, currentIndex, idx);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkeys, listeningFor, canControl, showPacPanel, currentPlayingParent, currentIndex,
      onPlayPause, onStop, onNext, onPrev, playItem]);

  // Captures the next keypress to bind it to whichever action's "Set" button
  // was clicked. Rebinding a key that's already used elsewhere removes the
  // old binding so two actions can never fire off the same key.
  useEffect(() => {
    if (!listeningFor) return;
    function onKeyDown(e) {
      e.preventDefault();
      if (e.key === "Escape") { setListeningFor(null); return; }
      const k = normalizeKey(e);
      setHotkeys(prev => {
        const next = {};
        for (const [action, boundKey] of Object.entries(prev)) {
          if (boundKey !== k) next[action] = boundKey;
        }
        next[listeningFor] = k;
        localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      setListeningFor(null);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listeningFor]);

  function clearHotkey(action) {
    setHotkeys(prev => {
      const next = { ...prev };
      delete next[action];
      localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  // "Selected" bar — same three focus sources the desktop clock panel reads
  // (a top-level/child leaf, a soundcheck item, or a PAC sub-choice).
  let selName = null, selContainer = null, selPlaying = false;
  if (focusedIndex >= 0 && playbackItems[focusedIndex]) {
    const item = playbackItems[focusedIndex];
    selName = getLiveItem(item).name || item.name;
    selPlaying = focusedIndex === currentIndex && isPlaying;
    const parent = setlistItems.find(si => si.isContainer && (si.children || []).some(c => c.id === item.id));
    if (parent) selContainer = parent.name;
  } else if (focusedSCItemId) {
    for (const si of setlistItems) {
      if (si.isContainer && si.isSoundcheck) {
        const found = (si.children || []).find(c => c.id === focusedSCItemId);
        if (found) { selName = getLiveItem(found).name || found.name; selContainer = si.name; break; }
      }
    }
  } else if (focusedNestedItemId) {
    // A PAC (keycommand) folder's leaf can live either inside a container
    // or as a top-level item on its own — both are tappable in the row
    // list, so both have to be checked here too.
    outer: for (const si of setlistItems) {
      if (si.isContainer) {
        for (const child of si.children || []) {
          if (child.isFolder && child.keycommand) {
            const found = (child.children || []).find(l => l.id === focusedNestedItemId);
            if (found) {
              selName = getLiveItem(found).name || found.name;
              selContainer = si.name;
              const pbIdx = playbackItems.findIndex(p => p.id === child.id);
              selPlaying = pbIdx === currentIndex && isPlaying;
              break outer;
            }
          }
        }
      } else if (si.isFolder && si.keycommand) {
        const found = (si.children || []).find(l => l.id === focusedNestedItemId);
        if (found) {
          selName = getLiveItem(found).name || found.name;
          const pbIdx = playbackItems.findIndex(p => p.id === si.id);
          selPlaying = pbIdx === currentIndex && isPlaying;
          break outer;
        }
      }
    }
  }

  // Tap-once-to-select, tap-again-to-play — mobile.html's exact row behavior;
  // there's no double-tap gesture to lean on like the desktop mouse UI does.
  function tapLeaf(pbIdx, item, childIndex, isFocused, focus) {
    if (isFocused) playItem(item, pbIdx, childIndex);
    else focus();
  }

  function renderRow(item, pbIdx, { sub = false, kcNum = null } = {}) {
    const live = getLiveItem(item);
    const isCurrent = item.id === currentPlayingItemId;
    const isFocused = item.id === focusedNestedItemId || (!sub && pbIdx === focusedIndex);
    const dur = (live.end || 0) - (live.start || 0);
    const progress = isCurrent && isPlaying && dur > 0
      ? Math.max(0, Math.min(1, (position - (live.start || 0)) / dur)) : 0;
    const cls = "mstage-row" + (sub ? " sub" : "")
      + (isCurrent && isFocused ? " sel-play" : isCurrent ? " playing" : isFocused ? " selected" : "");
    return (
      <div key={item.id} className={cls}
        onClick={() => tapLeaf(pbIdx, item, sub ? kcNum : -1, isFocused, () => {
          if (sub) { setFocusedNestedItemId(item.id); setFocusedIndex(-1); }
          else { setFocusedIndex(pbIdx); }
          setFocusedSCItemId(null);
        })}>
        <span className="mstage-dot" style={{ background: live.color }} />
        <span className="mstage-name">{live.name}</span>
        {item.infiniteLoop && <span className="mstage-flag loop">∞</span>}
        <span className="mstage-dur">{item.infiniteLoop ? "∞" : dur ? fmt(dur) : ""}</span>
        {progress > 0 && <div className="mstage-prog" style={{ width: `${progress * 100}%` }} />}
      </div>
    );
  }

  const clickLevel = clickTrackIdx >= 0 ? trackPeaks[clickTrackIdx] : undefined;
  const mainLevel = mainTrackIdx >= 0 ? trackPeaks[mainTrackIdx] : undefined;
  const setPct = stageTotalTime > 0 ? Math.min(100, (stageElapsed / stageTotalTime) * 100) : 0;

  return (
    <div className="mstage">
      <div className="mstage-setprog"><div className="mstage-setprog-fill" style={{ width: `${setPct}%` }} /></div>

      {(clickLevel !== undefined || mainLevel !== undefined) && (
        <div className="mstage-meters">
          {clickLevel !== undefined && <ClickFlash level={clickLevel} />}
          {mainLevel !== undefined && (
            <div className="mstage-vu-bar"><div className="mstage-vu-fill" style={{ width: `${Math.min(100, mainLevel * 100)}%` }} /></div>
          )}
        </div>
      )}

      <div className="mstage-list">
        {!activeSetlist ? (
          <div className="mstage-empty">No setlist loaded</div>
        ) : playbackItems.length === 0 ? (
          <div className="mstage-empty">Setlist is empty</div>
        ) : setlistItems.map(item => {
          if (item.disabled) return null;
          if (item.isContainer) {
            const children = item.children || [];
            if (children.length === 0) return null;
            const collapsed = stageCollapsed.has(item.id);
            const playingChild = children.find(c =>
              c.id === currentPlayingItemId || (c.children || []).some(l => l.id === currentPlayingItemId));
            return (
              <div key={item.id}>
                <div className={`mstage-sec-hdr${item.isSoundcheck ? " sc" : ""}`} onClick={() => toggleStageCollapsed(item.id)}>
                  {item.isSoundcheck && <span className="mstage-sc-badge">SC</span>}
                  <span className="mstage-sec-name">{item.name}</span>
                  {playingChild && <span className="mstage-sec-playing">→ {getLiveItem(playingChild).name}</span>}
                  <span className="mstage-sec-toggle">{collapsed ? "▶" : "▼"}</span>
                </div>
                {!collapsed && children.map(child => {
                  const pbIdx = playbackItems.findIndex(p => p.id === child.id);
                  if (child.isFolder && child.keycommand) {
                    return (
                      <React.Fragment key={child.id}>
                        {renderRow(child, pbIdx)}
                        {(child.children || []).map((leaf, li) => renderRow(leaf, pbIdx, { sub: true, kcNum: li }))}
                      </React.Fragment>
                    );
                  }
                  return renderRow(child, pbIdx);
                })}
              </div>
            );
          }
          const pbIdx = playbackItems.findIndex(p => p.id === item.id);
          if (item.isFolder && item.keycommand) {
            return (
              <React.Fragment key={item.id}>
                {renderRow(item, pbIdx)}
                {(item.children || []).map((leaf, li) => renderRow(leaf, pbIdx, { sub: true, kcNum: li }))}
              </React.Fragment>
            );
          }
          return renderRow(item, pbIdx);
        })}
      </div>

      {showPacPanel && (
        <div className="mstage-pac">
          <div className="mstage-pac-hdr">⌨ SELECT SONG</div>
          <div className="mstage-pac-keys">
            {(currentPlayingParent.children || []).map((leaf, li) => {
              const lr = getLiveItem(leaf);
              return (
                <button key={leaf.id} className="mstage-pac-key"
                  onClick={() => playItem(currentPlayingParent, currentIndex, li)}>
                  <span className="mstage-pac-num">{li + 1}</span>
                  <span className="mstage-pac-name">{lr.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selName && (
        <div className="mstage-sel">
          <div className="mstage-sel-lbl">SELECTED{selContainer ? ` · ${selContainer}` : ""}</div>
          <div className={`mstage-sel-name${selPlaying ? " playing" : ""}`}>{selName}</div>
        </div>
      )}

      {/* So whoever's running the show can glance at a phone and know which
          one it is — matches the name shown in the tray's device list. */}
      <div className="mstage-identity">
        <span className="mstage-identity-text">
          Connected as {getDeviceLabel()}{!canControl && <span className="mstage-view-only"> · VIEW ONLY</span>}
        </span>
        {canControl && (
          <button className="mstage-hotkeys-btn" onClick={() => setShowHotkeys(true)} title="Hotkeys">⌨</button>
        )}
      </div>

      {showHotkeys && (
        <div className="overlay" onClick={() => { setShowHotkeys(false); setListeningFor(null); }}>
          <div className="new-sl-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span>HOTKEYS — THIS DEVICE</span>
              <button className="fm-close" onClick={() => { setShowHotkeys(false); setListeningFor(null); }}>✕</button>
            </div>
            <div className="modal-body">
              <p className="sd-hint">
                Bindings are saved on this device only. Pick A Cover keys only fire while a
                Pick A Cover folder is playing and waiting for a choice.
              </p>
              <div className="hotkey-list">
                {HOTKEY_ACTIONS.map(({ id, label }) => (
                  <div className="hotkey-row" key={id}>
                    <span className="hotkey-label">{label}</span>
                    <div className="hotkey-controls">
                      <button
                        className={`hotkey-keybtn${listeningFor === id ? " listening" : ""}`}
                        onClick={() => setListeningFor(id)}>
                        {listeningFor === id ? "Press a key…" : formatKeyLabel(hotkeys[id])}
                      </button>
                      {hotkeys[id] && (
                        <button className="hotkey-clear" onClick={() => clearHotkey(id)} title="Clear">✕</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-confirm" onClick={() => { setShowHotkeys(false); setListeningFor(null); }}>DONE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Connection ──────────────────────────────────────────────────────────────
  const [wsConnected,     setWsConnected]     = useState(false);
  const [reaperConnected, setReaperConnected] = useState(false);
  const [position,        setPosition]        = useState(0);
  const [isPlaying,       setIsPlaying]       = useState(false);
  const wsRef = useRef(null);

  // ── Projects / Regions ─────────────────────────────────────────────────────
  const [projects,     setProjects]     = useState([]);
  const [activeProjIdx,setActiveProjIdx]= useState(0);
  const [regions,      setRegions]      = useState([]);
  const [loadingRegions,setLoadingR]    = useState(false);

  // ── Search ─────────────────────────────────────────────────────────────────
  const [search,        setSearch]       = useState("");
  const [highlightedIdx,setHighlightIdx] = useState(0);
  const searchRef   = useRef(null);
  const regionListRef = useRef(null);

  // ── Setlists ───────────────────────────────────────────────────────────────
  const [allSetlists,   setAllSetlists]  = useState([]);
  const [activeSetlistId, setActiveId]   = useState(null);
  const activeSetlistIdRef = useRef(null); // WS onmessage closure needs current value, not stale
  useEffect(() => { activeSetlistIdRef.current = activeSetlistId; }, [activeSetlistId]);
  const activeSetlist = allSetlists.find(s => s.id === activeSetlistId) || null;
  const setlistItems  = activeSetlist?.items || [];

  // ── Playback items (containers are transparent — children promoted to top level) ──
  // Soundcheck children are included but tagged _isSoundcheck: true
  const playbackItems = React.useMemo(() => {
    const result = [];
    for (const item of setlistItems) {
      if (item.isContainer) {
        if (!item.disabled) {
          for (const child of (item.children || [])) {
            result.push(item.isSoundcheck ? { ...child, _isSoundcheck: true } : child);
          }
        }
      } else {
        result.push(item);
      }
    }
    return result;
  }, [setlistItems]);

  const playbackItemsRef = useRef([]);
  useEffect(() => { playbackItemsRef.current = playbackItems; }, [playbackItems]);

  // ── Playback ───────────────────────────────────────────────────────────────
  const reaperIsPlayingRef = useRef(false); // always tracks real Reaper state from WS
  const [currentIndex,      setCurrentIndex]      = useState(-1);
  const [currentChildIndex, setCurrentChildIndex] = useState(-1); // -1 = not in a child
  const [focusedIndex,      setFocusedIndex]      = useState(-1);
  const [autoAdvance,       setAutoAdvance]        = useState(true);
  const [activeId,          setDragId]             = useState(null);
  const currentChildIndexRef = useRef(-1);
  useEffect(() => { currentChildIndexRef.current = currentChildIndex; }, [currentChildIndex]);

  // Focused soundcheck item (by ID — soundcheck items aren't in playbackItems)
  const [focusedSCItemId, setFocusedSCItemId] = useState(null);
  const focusedSCItemIdRef = useRef(null);
  useEffect(() => { focusedSCItemIdRef.current = focusedSCItemId; }, [focusedSCItemId]);

  // Focused nested item (PAC folder child — not in playbackItems, not soundcheck)
  const [focusedNestedItemId, setFocusedNestedItemId] = useState(null);
  const focusedNestedItemIdRef = useRef(null);
  useEffect(() => { focusedNestedItemIdRef.current = focusedNestedItemId; }, [focusedNestedItemId]);

  // Whether the tray has designated THIS device as admin — only the admin
  // device gets Edit mode; everyone else is held to Stage view (server also
  // enforces this on /setlists POST, this just controls what's shown/usable).
  const [isAdmin, setIsAdmin] = useState(false); // locked down until the WS "role" message confirms otherwise
  const [canControl, setCanControl] = useState(true); // playback control — separate from admin, tray-assignable

  // ── UI mode ────────────────────────────────────────────────────────────────
  const [mode,          setMode]         = useState("edit"); // "edit" | "stage"
  const [showFileMenu,  setShowFileMenu] = useState(false);
  const [showProject,   setShowProject]  = useState(false);
  const [showConsole,   setShowConsole]  = useState(false);
  const [showDrawer,    setShowDrawer]   = useState(false);
  const [narrow,        setNarrow]       = useState(false);
  const [showNewSetlist, setShowNewSetlist] = useState(false);
  const [newSetlistDraft, setNewSetlistDraft] = useState(null);

  // Bounce out of Edit mode the moment this device isn't (or stops being)
  // admin — covers the initial locked-down default and a live role change
  // pushed mid-session by the tray.
  useEffect(() => { if (!isAdmin && mode === "edit") setMode("stage"); }, [isAdmin, mode]);

  // REAPER opened a project that matches a saved (but not currently active) setlist
  const [projectSwitchPrompt, setProjectSwitchPrompt] = useState(null); // {proj_name, matched_setlist_id, matched_setlist_name} | null

  // ── Tracks / VU meters ─────────────────────────────────────────────────────
  const [tracks,        setTracks]       = useState([]);
  const [trackPeaks,    setTrackPeaks]   = useState([]);
  const [clickTrackIdx, setClickTrackIdx]= useState(-1);
  const [mainTrackIdx,  setMainTrackIdx] = useState(-1);

  // ── MIDI devices (available from bridge) ────────────────────────────────────
  const [midiDevices, setMidiDevices] = useState([]);

  // ── First-run detection ─────────────────────────────────────────────────────
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [showWelcome,     setShowWelcome]     = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructionsText, setInstructionsText] = useState("");

  // ── Focus panel — "regions" or "setlist" (determines arrow key target) ─────
  const [focusPanel, setFocusPanel] = useState("setlist"); // "regions" | "setlist"
  const focusPanelRef = useRef("setlist");
  useEffect(() => { focusPanelRef.current = focusPanel; }, [focusPanel]);

  const sensors = useSensors(
    // Touch-first: a short press-and-hold starts a drag so a quick swipe still
    // scrolls the list normally (a plain distance threshold fights scrolling
    // on a phone, where the same gesture is used for both).
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Responsive detection ───────────────────────────────────────────────────
  useEffect(() => {
    const obs = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 720));
    obs.observe(document.body);
    return () => obs.disconnect();
  }, []);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!HAS_DEVICE_LABEL) return; // DeviceNameGate below blocks the UI until named, then reloads
    connectWS();
    return () => wsRef.current?.close();
  }, []);

  // Load setlists from disk on startup
  useEffect(() => {
    loadAllSetlistsFromDisk().then(lists => {
      if (lists.length > 0) {
        setAllSetlists(lists);
        // Auto-select the most recently used setlist (last in list or by lastUsed timestamp)
        const sorted = [...lists].sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0));
        setActiveId(sorted[0].id);
        if ((sorted[0].items || []).length > 0) setMode("stage");
      } else {
        setShowWelcome(true);
      }
      setInitialLoadDone(true);
    });
  }, []);

  // Poll MIDI devices every 2s (WS slow-tick also updates this as a faster path)
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const data = await fetch(`${API}/midi-devices`).then(r => r.json());
        if (mounted && Array.isArray(data)) setMidiDevices(data);
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { mounted = false; clearInterval(iv); };
  }, []);

  // Prefetch instructions on mount so they're ready instantly when the modal opens
  useEffect(() => {
    fetch(`${API}/instructions`).then(r => r.json())
      .then(data => { if (data?.text) setInstructionsText(data.text); })
      .catch(() => {});
  }, []);

  function fetchInstructions() { setShowInstructions(true); }

  // If Reaper isn't open yet and the setlist has an RPP, launch Reaper with the project directly
  const didLaunchRef = useRef(false);
  useEffect(() => {
    if (reaperConnected || didLaunchRef.current) return;
    const setlist = allSetlists.find(s => s.id === activeSetlistId);
    if (!setlist?.rppPath) return;
    didLaunchRef.current = true;
    openReaper(setlist.rppPath);
  }, [reaperConnected, activeSetlistId, allSetlists]);

  // Once Reaper IS connected, switch to the correct project if it doesn't already match
  const didAutoOpenRef = useRef(false);
  useEffect(() => {
    if (!reaperConnected || !activeSetlistId || didAutoOpenRef.current) return;
    didAutoOpenRef.current = true;
    const setlist = allSetlists.find(s => s.id === activeSetlistId);
    if (!setlist?.rppPath) return;
    fetch(`${API}/current-project-path`).then(r => r.json()).then(cur => {
      if (cur.path && cur.path.toLowerCase() === setlist.rppPath.toLowerCase()) return;
      fetch(`${API}/open-project`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ rpp_path: setlist.rppPath }),
      }).catch(() => {});
    }).catch(() => {});
  }, [reaperConnected, activeSetlistId]);


  // Use a ref for fetchProjects/fetchRegions so the WS closure always sees current version
  const fetchProjectsRef = useRef(null);
  const fetchRegionsRef  = useRef(null);
  const activeProjIdxRef = useRef(0);
  const refreshSetlistsRef = useRef(null);

  function connectWS() {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen  = () => { setWsConnected(true); fetchProjectsRef.current?.(); };
    ws.onclose = () => {
      setWsConnected(false);
      setReaperConnected(false);
      setRegions([]);       // clear regions when disconnected
      setProjects([]);
      setTimeout(connectWS, 2000);
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.reaper_connected !== undefined) setReaperConnected(m.reaper_connected);
      if (m.is_playing !== undefined) { reaperIsPlayingRef.current = m.is_playing; setIsPlaying(m.is_playing); }
      if (m.position   !== undefined) setPosition(m.position);
      if (m.peaks      !== undefined) setTrackPeaks(m.peaks);
      // Sync playback selection from another client (e.g. mobile)
      if (m.type === "playback_state" && m.item_id) {
        const idx = playbackItemsRef.current.findIndex(i => i.id === m.item_id);
        if (idx >= 0) {
          setCurrentIndex(idx);
          setCurrentChildIndex(m.child_index ?? -1);
          setFocusedSCItemId(null);
          const childIdx = m.child_index ?? -1;
          if (childIdx >= 0) {
            // Playing a PAC child — move focus to the leaf, not the folder
            const parentItem = playbackItemsRef.current[idx];
            const leaf = (parentItem?.children || [])[childIdx];
            if (leaf) { setFocusedNestedItemId(leaf.id); setFocusedIndex(-1); }
            else      { setFocusedIndex(idx); setFocusedNestedItemId(null); }
          } else {
            setFocusedIndex(idx);
            setFocusedNestedItemId(null);
          }
        } else {
          // Check if it's a soundcheck item (not in playbackItems)
          const scContainer = setlistItemsRef.current.find(
            si => si.isContainer && si.isSoundcheck &&
                  (si.children || []).some(c => c.id === m.item_id)
          );
          if (scContainer) {
            setFocusedSCItemId(m.item_id);
            setFocusedIndex(-1);
            setFocusedNestedItemId(null);
          }
        }
      }
      if (m.type === "midi_devices") {
        setMidiDevices(Array.isArray(m.devices) ? m.devices : []);
      }
      // Server detected a change — auto-refresh
      if (m.type === "regions_changed") {
        fetchRegionsRef.current?.(activeProjIdxRef.current);
      }
      if (m.type === "projects_changed") {
        fetchProjectsRef.current?.();
      }
      // Just (re)connected — fetch everything fresh
      if (m.type === "connection_changed" && m.reaper_connected) {
        fetchProjectsRef.current?.();
      }
      // REAPER opened a project that matches a saved setlist — only worth a
      // prompt if that setlist isn't already the one we're on.
      if (m.type === "project_switch_prompt") {
        if (m.matched_setlist_id && m.matched_setlist_id !== activeSetlistIdRef.current) {
          setProjectSwitchPrompt(m);
        }
      }
      // Tray assigned/changed the admin device — takes effect immediately,
      // including for devices already mid-session (no reconnect needed).
      if (m.type === "role") {
        setIsAdmin(!!m.isAdmin);
        setCanControl(m.canControl !== false);
      }
      // Setlists live on this PC (companion), not on any one phone — when a
      // DIFFERENT device saves a change, pull the fresh copy. Skip our own
      // echo so an in-progress local edit (e.g. mid-drag reorder) never gets
      // clobbered by the server confirming the save we just made.
      if (m.type === "setlists_changed" && m.by_device_id !== DEVICE_ID) {
        refreshSetlistsRef.current?.();
      }
    };
  }

  // ── Data fetching ──────────────────────────────────────────────────────────
  async function fetchProjects() {
    try {
      const d = await fetch(`${API}/projects`).then(r => r.json());
      setProjects(d);
      if (!d || d.length === 0) { setRegions([]); return; }
      const act = d.find(p => p.active) || d[0];
      const idx = act?.index ?? 0;
      setActiveProjIdx(idx);
      activeProjIdxRef.current = idx;
      fetchRegions(idx);
      fetchTracks();
    } catch(e) { console.error(e); }
  }

  async function fetchRegions(idx = activeProjIdx) {
    setLoadingR(true); setHighlightIdx(0);
    try {
      const d = await fetch(`${API}/regions?project_index=${idx}`).then(r => r.json());
      setRegions(d || []);
      if (d && d.length > 0) syncSetlistPositions(d);
    } catch(e) { console.error(e); setRegions([]); }
    finally { setLoadingR(false); }
  }

  function syncSetlistPositions(regions) {
    if (!allSetlists || allSetlists.length === 0) return;
    // Index by both id and enumeration index so we can find regions even after they've moved
    const byId    = {};
    const byIndex = {};
    regions.forEach(r => { byId[r.id] = r; byIndex[r.index] = r; });

    function syncItem(item) {
      if (item.isContainer) {
        return { ...item, children: (item.children || []).map(syncItem) };
      }
      if (item.isFolder) {
        const r = byId[item.region_id] ?? (item.region_index !== undefined ? byIndex[item.region_index] : undefined);
        const base = r ? { ...item, start: r.start, end: r.end, name: r.name, color: r.color, region_id: r.id, region_index: r.index } : item;
        return { ...base, children: (item.children || []).map(syncItem) };
      }
      const r = byId[item.region_id] ?? (item.region_index !== undefined ? byIndex[item.region_index] : undefined);
      if (!r) return item;
      return { ...item, start: r.start, end: r.end, name: r.name, color: r.color, region_id: r.id, region_index: r.index };
    }

    const updated = allSetlists.map(setlist => ({
      ...setlist,
      items: (setlist.items || []).map(syncItem),
    }));

    setAllSetlists(updated);
    saveAllSetlistsToDisk(updated);
  }

  async function fetchTracks() {
    try {
      const d = await fetch(`${API}/tracks`).then(r => r.json());
      setTracks(d || []);
    } catch(e) { setTracks([]); }
  }

  // Keep refs up to date so WS closure can call them
  useEffect(() => { fetchProjectsRef.current = fetchProjects; });
  useEffect(() => { fetchRegionsRef.current  = fetchRegions; });
  useEffect(() => { activeProjIdxRef.current = activeProjIdx; }, [activeProjIdx]);

  // Re-fetch regions whenever Reaper connects or active setlist changes
  useEffect(() => { if (reaperConnected) fetchProjects(); }, [reaperConnected]);
  useEffect(() => { if (reaperConnected && activeSetlistId) fetchProjects(); }, [activeSetlistId]);

  function selectProject(idx) {
    setActiveProjIdx(idx);
    setSearch("");
    fetchRegions(idx);
  }

  // ── Filtered regions ───────────────────────────────────────────────────────
  const [regionSort, setRegionSort] = useState(() => localStorage.getItem("regionSort") || "id-desc"); // "default" | "name" | "id" | "id-desc"
  const filtered = React.useMemo(() => {
    const base = regions.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
    if (regionSort === "name")    return [...base].sort((a, b) => a.name.localeCompare(b.name));
    if (regionSort === "id")      return [...base].sort((a, b) => a.index - b.index);
    if (regionSort === "id-desc") return [...base].sort((a, b) => b.index - a.index);
    return base;
  }, [regions, search, regionSort]);
  useEffect(() => setHighlightIdx(0), [search, regionSort]);
  useEffect(() => {
    if (!regionListRef.current) return;
    regionListRef.current.querySelector(`[data-idx="${highlightedIdx}"]`)?.scrollIntoView({ block:"nearest" });
  }, [highlightedIdx]);

  // Scroll focused setlist item into view
  const slListRef = useRef(null);
  useEffect(() => {
    if (!slListRef.current || focusedIndex < 0) return;
    const el = slListRef.current.querySelector(`[data-sli="${focusedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  // Scroll stage list current/focused item into view
  const stageListRef = useRef(null);
  useEffect(() => {
    if (!stageListRef.current || currentIndex < 0) return;
    const el = stageListRef.current.querySelector(`[data-stage-idx="${currentIndex}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex]);
  useEffect(() => {
    if (!stageListRef.current || focusedIndex < 0) return;
    const el = stageListRef.current.querySelector(`[data-stage-idx="${focusedIndex}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIndex]);

  function handleSearchKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx(i => Math.min(i+1, filtered.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = filtered[highlightedIdx]; if(r) addToSetlist(r); }
    else if (e.key === "Escape") { setSearch(""); searchRef.current?.blur(); }
  }

  // ── Setlist mutations ──────────────────────────────────────────────────────
  function mutateSetlist(fn) {
    setAllSetlists(prev => {
      const next = prev.map(s => s.id === activeSetlistId ? { ...s, items: fn(s.items || []) } : s);
      saveAllSetlistsToDisk(next);
      return next;
    });
  }

  function addToSetlist(region) {
    const newItem = { ...region, id: uid(), region_id: region.id, region_index: region.index };
    const focusedId = focusedIndexRef.current >= 0 ? playbackItemsRef.current[focusedIndexRef.current]?.id : null;

    const focusedItem = focusedId ? playbackItemsRef.current.find(i => i.id === focusedId) : null;

    // If focused item is a PAC folder, add as a child of that folder (check before container)
    if (focusedItem?.isFolder) {
      mutateSetlist(items => items.map(item => {
        if (item.id === focusedItem.id)
          return { ...item, children: [...(item.children||[]), newItem] };
        if (item.isContainer)
          return { ...item, children: (item.children||[]).map(c =>
            c.id === focusedItem.id ? { ...c, children: [...(c.children||[]), newItem] } : c
          )};
        return item;
      }));
      return;
    }

    // If focused item lives inside a container, add to that container after the focused child
    const parentContainer = focusedId
      ? setlistItemsRef.current.find(si => si.isContainer && (si.children||[]).some(c => c.id === focusedId))
      : null;
    if (parentContainer) {
      mutateSetlist(items => items.map(item => {
        if (item.id !== parentContainer.id) return item;
        const children = item.children || [];
        const idx = children.findIndex(c => c.id === focusedId);
        const next = [...children];
        next.splice(idx >= 0 ? idx + 1 : next.length, 0, newItem);
        return { ...item, children: next };
      }));
      return;
    }

    // Default: add at top level after focused item (or at end)
    mutateSetlist(items => {
      if (!focusedId) return [...items, newItem];
      const topIdx = items.findIndex(item =>
        item.id === focusedId || (item.isContainer && (item.children||[]).some(c => c.id === focusedId))
      );
      if (topIdx < 0) return [...items, newItem];
      const next = [...items];
      next.splice(topIdx + 1, 0, newItem);
      return next;
    });
  }

  function removeFromSetlist(id) {
    mutateSetlist(items => {
      const pbItems = playbackItemsRef.current;
      const pbIdx = pbItems.findIndex(i => i.id === id);
      setCurrentIndex(ci => ci > pbIdx ? ci-1 : ci === pbIdx ? -1 : ci);
      return items.filter(i => i.id !== id);
    });
  }

  function toggleItemFlag(itemId, flag) {
    mutateSetlist(items => items.map(item => {
      // Check inside containers too
      if (item.isContainer) {
        return {
          ...item, children: (item.children || []).map(child => {
            if (child.id !== itemId) return child;
            if (flag === 'isFolder') {
              return child.isFolder
                ? { ...child, isFolder: false, children: [], selectedChildIdx: 0 }
                : { ...child, isFolder: true, children: child.children || [], selectedChildIdx: child.selectedChildIdx ?? 0 };
            }
            return { ...child, [flag]: !child[flag] };
          })
        };
      }
      if (item.id !== itemId) return item;
      if (flag === 'isFolder') {
        return item.isFolder
          ? { ...item, isFolder: false, children: [], selectedChildIdx: 0 }
          : { ...item, isFolder: true, children: item.children || [], selectedChildIdx: item.selectedChildIdx ?? 0 };
      }
      return { ...item, [flag]: !item[flag] };
    }));
  }

  function toggleFolderCollapsed(itemId) {
    setAllSetlists(prev => prev.map(s => s.id === activeSetlistId
      ? { ...s, items: (s.items || []).map(i => i.id === itemId ? { ...i, collapsed: !i.collapsed } : i) }
      : s
    ));
  }

  function addChildToFolder(parentIdx) {
    const region = filteredRef.current[highlightedIdxRef.current];
    if (!region) return;
    // parentIdx is index into playbackItems, find the item in setlistItems
    const pbItems = playbackItemsRef.current;
    const parentItem = pbItems[parentIdx];
    if (!parentItem) return;
    mutateSetlist(items => items.map(item => {
      if (item.id === parentItem.id) {
        const child = { ...region, id: uid(), region_id: region.id, region_index: region.index };
        return { ...item, children: [...(item.children || []), child] };
      }
      return item;
    }));
  }

  function removeChildFromFolder(parentIdx, childId) {
    const pbItems = playbackItemsRef.current;
    const parentItem = pbItems[parentIdx];
    if (!parentItem) return;
    mutateSetlist(items => items.map(item => {
      if (item.id === parentItem.id) {
        return { ...item, children: (item.children || []).filter(c => c.id !== childId) };
      }
      return item;
    }));
  }

  function setSelectedChild(parentIdx, childIdx) {
    const pbItems = playbackItemsRef.current;
    const parentItem = pbItems[parentIdx];
    if (!parentItem) return;
    mutateSetlist(items => items.map(item =>
      item.id === parentItem.id ? { ...item, selectedChildIdx: childIdx } : item
    ));
  }

  // ── Container functions ────────────────────────────────────────────────────
  function createContainer() {
    const newItem = { id: uid(), name: "New Section", isContainer: true, collapsed: false, children: [] };
    mutateSetlist(items => {
      const focusedId = focusedIndexRef.current >= 0 ? playbackItemsRef.current[focusedIndexRef.current]?.id : null;
      if (!focusedId) return [...items, newItem];
      const topIdx = items.findIndex(item =>
        item.id === focusedId || (item.isContainer && (item.children||[]).some(c => c.id === focusedId))
      );
      if (topIdx < 0) return [...items, newItem];
      const next = [...items];
      next.splice(topIdx + 1, 0, newItem);
      return next;
    });
  }

  function addToContainer(containerItemId, region) {
    const newItem = { ...region, id: uid(), region_id: region.id, region_index: region.index };
    mutateSetlist(items => items.map(item => {
      if (item.id !== containerItemId) return item;
      const children = item.children || [];
      const focusedId = focusedIndexRef.current >= 0 ? playbackItemsRef.current[focusedIndexRef.current]?.id : null;
      const focusedChildIdx = focusedId ? children.findIndex(c => c.id === focusedId) : -1;
      if (focusedChildIdx < 0) return { ...item, children: [...children, newItem] };
      const next = [...children];
      next.splice(focusedChildIdx + 1, 0, newItem);
      return { ...item, children: next };
    }));
  }

  function addFolderToContainer(containerItemId) {
    mutateSetlist(items => items.map(item =>
      item.id === containerItemId
        ? { ...item, children: [...(item.children||[]), { id: uid(), name: "New Folder", isFolder: true, keycommand: false, children: [], collapsed: false }] }
        : item
    ));
  }

  function removeContainerChild(containerItemId, childId) {
    mutateSetlist(items => items.map(item =>
      item.id === containerItemId
        ? { ...item, children: (item.children||[]).filter(c => c.id !== childId) }
        : item
    ));
  }

  function toggleContainerCollapsed(itemId) {
    setAllSetlists(prev => prev.map(s => s.id === activeSetlistId
      ? { ...s, items: (s.items||[]).map(i => i.id === itemId ? { ...i, collapsed: !i.collapsed } : i) }
      : s
    ));
  }

  function toggleContainerSoundcheck(itemId) {
    setAllSetlists(prev => {
      const next = prev.map(s => s.id === activeSetlistId
        ? { ...s, items: (s.items||[]).map(i => i.id === itemId ? { ...i, isSoundcheck: !i.isSoundcheck } : i) }
        : s
      );
      saveAllSetlistsToDisk(next);
      return next;
    });
  }

  function toggleContainerDisabled(itemId) {
    setAllSetlists(prev => {
      const next = prev.map(s => s.id === activeSetlistId
        ? { ...s, items: (s.items||[]).map(i => i.id === itemId ? { ...i, disabled: !i.disabled } : i) }
        : s
      );
      saveAllSetlistsToDisk(next);
      return next;
    });
  }

  function expandAllContainers() {
    setAllSetlists(prev => prev.map(s => s.id === activeSetlistId
      ? { ...s, items: (s.items||[]).map(i => i.isContainer ? { ...i, collapsed: false } : i) }
      : s
    ));
  }
  function collapseAllContainers() {
    setAllSetlists(prev => prev.map(s => s.id === activeSetlistId
      ? { ...s, items: (s.items||[]).map(i => i.isContainer ? { ...i, collapsed: true } : i) }
      : s
    ));
  }

  // Disabled section collapse (edit view)
  const [disabledSectionCollapsed, setDisabledSectionCollapsed] = useState(false);

  // Stage-view independent collapse state — default all containers collapsed
  const [stageCollapsed, setStageCollapsed] = useState(() => new Set());
  const stageCollapsedRef = useRef(new Set());
  useEffect(() => { stageCollapsedRef.current = stageCollapsed; }, [stageCollapsed]);
  function toggleStageCollapsed(itemId) {
    setStageCollapsed(prev => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  }
  function collapseAllStage() {
    setStageCollapsed(new Set(setlistItems.filter(i => i.isContainer).map(i => i.id)));
  }
  function expandAllStage() {
    setStageCollapsed(new Set());
  }

  function toggleKeycommand(itemId) {
    mutateSetlist(items => items.map(item => {
      if (item.id === itemId) {
        const next = !item.keycommand;
        return { ...item, keycommand: next, ...(next ? { infiniteLoop: true } : {}) };
      }
      // Also check inside containers
      if (item.isContainer) {
        return { ...item, children: (item.children||[]).map(c => {
          if (c.id !== itemId) return c;
          const next = !c.keycommand;
          return { ...c, keycommand: next, ...(next ? { infiniteLoop: true } : {}) };
        })};
      }
      return item;
    }));
  }

  function renameItem(itemId, newName) {
    mutateSetlist(items => items.map(item => {
      if (item.id === itemId) return { ...item, name: newName };
      if (item.isContainer) return { ...item, children: (item.children||[]).map(c => c.id === itemId ? { ...c, name: newName } : c) };
      return item;
    }));
  }

  // ── Playback ───────────────────────────────────────────────────────────────
  async function playItem(item, index, childIndex = -1, updateFocus = true) {
    if (!canControl) return; // view-only device — tray revoked Play/Stop
    const targetItem = childIndex >= 0 ? item.children[childIndex] : item;
    const live = getLiveItem(targetItem);
    positionConfirmedRef.current = false; // require position to settle before gate can fire
    setCurrentIndex(index);
    setCurrentChildIndex(childIndex);
    if (updateFocus) {
      if (childIndex >= 0) {
        // PAC leaf played — keep selection on the leaf, not the folder
        const leaf = item.children[childIndex];
        if (leaf) { setFocusedNestedItemId(leaf.id); setFocusedIndex(-1); setFocusedSCItemId(null); }
      } else {
        setFocusedIndex(index);
        setFocusedNestedItemId(null);
        setFocusedSCItemId(null);
      }
    }
    setIsPlaying(true);
    setPosition(live.start);
    try {
      await fetch(`${API}/play`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ region_id: targetItem.region_id, start: live.start, end: live.end, item_id: item.id, child_index: childIndex }),
      });
    } catch(e) { console.error(e); }
  }

  async function pausePlayback() {
    if (!canControl) return;
    setIsPlaying(false);
    try { await fetch(`${API}/pause`, { method:"POST" }); } catch(e){}
  }

  async function stopPlayback() {
    if (!canControl) return;
    setIsPlaying(false);
    try { await fetch(`${API}/stop`, { method:"POST" }); } catch(e){}
  }

  async function playDirect(item) {
    if (!canControl) return;
    const live = getLiveItem(item);
    try {
      await fetch(`${API}/play`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region_id: live.region_id || "", start: live.start, end: live.end }),
      });
    } catch(e) { console.error(e); }
  }

  async function playSelected() {
    if (!canControl) return;
    try {
      await fetch(`${API}/play-selected`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ project_index: activeProjIdx }),
      });
    } catch(e) { console.error(e); }
  }

  function playNext() {
    const items = playbackItemsRef.current;
    const n = currentIndexRef.current + 1;
    if (n < items.length) playItem(items[n], n, -1, false);
    else { stopPlayback(); setCurrentIndex(-1); }
  }

  function launchShow() {
    const items = playbackItemsRef.current;
    const firstIdx = items.findIndex(i => !i._isSoundcheck);
    if (firstIdx < 0) return;
    setMode("stage");
    playItem(items[firstIdx], firstIdx);
  }

  function playPrev() {
    const items = playbackItemsRef.current;
    const p = currentIndexRef.current - 1;
    if (p >= 0) playItem(items[p], p);
  }

  // Same play/pause decision the transport bar's PLAY button makes — pulled
  // out so the Stage-view hotkey can trigger the identical behavior.
  function handleTransportPlayPause() {
    const selIsPlaying = isPlaying && !focusedSCItemId && focusedIndex === currentIndex;
    if (selIsPlaying) { pausePlayback(); return; }
    if (focusedSCItemId) {
      for (const si of setlistItems) {
        if (si.isContainer && si.isSoundcheck) {
          const ch = (si.children || []).find(c => c.id === focusedSCItemId);
          if (ch) { playDirect(ch); return; }
        }
      }
      return;
    }
    const fi = focusedIndex >= 0 ? focusedIndex : (currentIndex >= 0 ? currentIndex : 0);
    if (playbackItems[fi]) playItem(playbackItems[fi], fi);
  }

  // Gate prevents the auto-advance effect from firing more than once per trigger window.
  const autoAdvanceFiredRef = useRef(false);
  // Requires position to be clearly inside the region before the gate can fire.
  // Prevents a stale WebSocket position (from the previous item) from triggering advance
  // immediately after advancing to a duplicate song (same region, same end time).
  const positionConfirmedRef = useRef(false);

  // Auto-advance / region-end stop
  useEffect(() => {
    if (currentIndex < 0) return;
    const items = playbackItems;
    const item = items[currentIndex];
    if (!item) return;
    // Determine active item: child or top-level
    const activeItem = currentChildIndex >= 0 && item.children?.[currentChildIndex]
      ? item.children[currentChildIndex]
      : item;
    const live = getLiveItem(activeItem);
    if (!live) return;
    // Infinite loop fires slightly early to seek before Reaper stops at region end
    const triggerOffset = item.infiniteLoop ? 0.3 : 0.1;
    // Before the trigger window: reset gate and confirm position
    if (position < live.end - triggerOffset) {
      autoAdvanceFiredRef.current = false;
      positionConfirmedRef.current = true; // position is genuinely inside this region
      return;
    }
    // Well past the end: reset gate (seek may have overshot)
    // Don't reset for infinite loops — keep gate locked until position is confirmed back near start
    if (position > live.end + 2.0) {
      if (!item.infiniteLoop) autoAdvanceFiredRef.current = false;
      return;
    }
    // In trigger window — infinite loop fires even if Reaper already stopped (race condition fix)
    if (item.infiniteLoop && currentChildIndex === -1) {
      if (!positionConfirmedRef.current) return;
      if (autoAdvanceFiredRef.current) return;
      autoAdvanceFiredRef.current = true;
      positionConfirmedRef.current = false; // require re-confirmation after seek before next trigger
      const liveLoop = getLiveItem(item);
      fetch(`${API}/loop-seek`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ pos: liveLoop.start }),
      }).catch(() => {});
      return;
    }
    // All other auto-advance requires Reaper to be actively playing
    if (!isPlaying) return;
    if (!positionConfirmedRef.current) return; // WS position may be stale from previous item
    if (autoAdvanceFiredRef.current) return;   // already fired for this window
    autoAdvanceFiredRef.current = true;
    if (item.isFolder && currentChildIndex === -1 && (item.children || []).length > 0) {
      if (!item.keycommand) {
        // Non-keycommand folder: auto-play selected child
        playItem(item, currentIndex, item.selectedChildIdx ?? 0, false);
      }
      // keycommand folders wait for key press, do nothing here
    } else if (currentChildIndex >= 0) {
      // Child finished: advance to next top-level item
      playNext();
    } else if (autoAdvance) {
      playNext();
    } else {
      stopPlayback();
    }
  }, [position, autoAdvance, isPlaying, currentIndex, currentChildIndex]);

  // ── Global keyboard nav — works in both edit and stage modes ─────────────
  // Uses a ref so the closure always sees current state
  const focusedIndexRef           = useRef(-1);
  const setlistItemsRef           = useRef([]);
  const isPlayingRef              = useRef(false);
  const currentIndexRef           = useRef(-1);
  const filteredRef               = useRef([]);
  const highlightedIdxRef         = useRef(0);
  const regionsRef                = useRef([]);
  const toggleContainerCollapsedRef = useRef(null);
  useEffect(() => { focusedIndexRef.current   = focusedIndex; },   [focusedIndex]);
  useEffect(() => { setlistItemsRef.current   = setlistItems; },   [setlistItems]);
  useEffect(() => { isPlayingRef.current      = isPlaying; },      [isPlaying]);
  useEffect(() => { currentIndexRef.current   = currentIndex; },   [currentIndex]);
  useEffect(() => { filteredRef.current       = filtered; },       [filtered]);
  useEffect(() => { highlightedIdxRef.current = highlightedIdx; }, [highlightedIdx]);
  useEffect(() => { regionsRef.current        = regions; },        [regions]);
  useEffect(() => { toggleContainerCollapsedRef.current = toggleContainerCollapsed; });

  // Always look up live region positions from Reaper rather than stale stored values.
  // Match by region_id first; fall back to region_index (stable enumeration order)
  // because region IDs embed position and change when a region is moved in Reaper.
  function getLiveItem(item) {
    if (!item) return item;
    if (item.isContainer) return item;
    const regs = regionsRef.current;
    const r = regs.find(r => r.id === item.region_id)
           ?? (item.region_index !== undefined ? regs.find(r => r.index === item.region_index) : undefined);
    return r ? { ...item, start: r.start, end: r.end, name: r.name, color: r.color, region_id: r.id } : item;
  }

  // Helper: effective duration for Pick A Cover items uses the selected child (timingChildIdx = selectedChildIdx, default 0)
  function getEffectiveDuration(item) {
    const r = getLiveItem(item);
    if (item.isFolder && item.keycommand && (item.children || []).length > 0) {
      const idx = Math.min(item.selectedChildIdx ?? 0, item.children.length - 1);
      const cr = getLiveItem(item.children[idx]);
      return (cr.end || 0) - (cr.start || 0);
    }
    return (r.end || 0) - (r.start || 0);
  }

  useEffect(() => {
    function onKey(e) {
      if (showFileMenu || showProject || showConsole || showDrawer) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const panel = focusPanelRef.current;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;

        if (panel === "regions") {
          // Drive region list highlight
          setHighlightIdx(i => {
            const newI = Math.max(0, Math.min(i + dir, filteredRef.current.length - 1));
            return newI;
          });
        } else {
          // Drive setlist focus — includes soundcheck items for navigation
          const items = playbackItemsRef.current;
          const slItems = setlistItemsRef.current;
          const fi = focusedIndexRef.current;
          const scId = focusedSCItemIdRef.current;
          const nid = focusedNestedItemIdRef.current;

          function applyFocusEntry(entry) {
            if (!entry) return;
            if (entry.isSC) { setFocusedSCItemId(entry.id); setFocusedIndex(-1); setFocusedNestedItemId(null); }
            else if (entry.isNested) { setFocusedNestedItemId(entry.id); setFocusedIndex(-1); setFocusedSCItemId(null); }
            else { setFocusedSCItemId(null); setFocusedNestedItemId(null); setFocusedIndex(entry.pbIdx); }
          }

          const navList = [];
          for (const slItem of slItems) {
            if (slItem.isContainer) {
              const isCollapsed = slItem.collapsed ?? false;
              if (isCollapsed) {
                // Collapsed: one nav stop = first child
                const first = (slItem.children || [])[0];
                if (first) {
                  const pbIdx = items.findIndex(p => p.id === first.id);
                  if (pbIdx >= 0) navList.push({ id: first.id, pbIdx, isSC: false });
                }
              } else {
                // Expanded: every item at every depth is a nav stop
                const addAll = (children) => {
                  for (const child of children) {
                    const pbIdx = items.findIndex(p => p.id === child.id);
                    if (pbIdx >= 0) navList.push({ id: child.id, pbIdx, isSC: false });
                    else navList.push({ id: child.id, pbIdx: -1, isNested: true });
                    if ((child.children || []).length > 0) addAll(child.children);
                  }
                };
                addAll(slItem.children || []);
              }
            } else {
              const pbIdx = items.findIndex(p => p.id === slItem.id);
              if (pbIdx >= 0) navList.push({ id: slItem.id, pbIdx, isSC: false });
              for (const child of (slItem.children || [])) {
                const cPbIdx = items.findIndex(p => p.id === child.id);
                if (cPbIdx >= 0) navList.push({ id: child.id, pbIdx: cPbIdx, isSC: false });
                else navList.push({ id: child.id, pbIdx: -1, isNested: true });
              }
            }
          }

          if (navList.length === 0) return;
          const curId = (fi >= 0 ? items[fi]?.id : null) || scId || nid;
          let curNavPos = navList.findIndex(n =>
            n.isSC ? n.id === scId : n.isNested ? n.id === nid : n.pbIdx === fi && fi >= 0
          );
          if (curNavPos === -1 && curId) {
            const findHost = (id) => {
              for (const si of slItems) {
                if (!si.isContainer) continue;
                const check = (ch) => ch.some(c => c.id === id || ((c.children||[]).length > 0 && check(c.children)));
                if (check(si.children || [])) return si;
              }
              return null;
            };
            const host = findHost(curId);
            if (host) {
              const firstChild = (host.children || [])[0];
              if (firstChild) curNavPos = navList.findIndex(n => n.id === firstChild.id);
            }
          }
          const newNavPos = curNavPos === -1
            ? (dir > 0 ? 0 : navList.length - 1)
            : Math.max(0, Math.min(curNavPos + dir, navList.length - 1));
          applyFocusEntry(navList[newNavPos]);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (panel === "setlist") {
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const items = playbackItemsRef.current;
          const slItems = setlistItemsRef.current;
          const fi = focusedIndexRef.current;
          const scId = focusedSCItemIdRef.current;
          const nid = focusedNestedItemIdRef.current;
          const curId = (fi >= 0 ? items[fi]?.id : null) || scId || nid;

          function applyFocus(entry) {
            if (!entry) return;
            if (entry.isSC) { setFocusedSCItemId(entry.id); setFocusedIndex(-1); setFocusedNestedItemId(null); }
            else if (entry.isNested) { setFocusedNestedItemId(entry.id); setFocusedIndex(-1); setFocusedSCItemId(null); }
            else { setFocusedSCItemId(null); setFocusedNestedItemId(null); setFocusedIndex(entry.pbIdx); }
          }

          if (mode === "stage") {
            // Stage collapsed: Left/Right cycles through ALL children of the focused container
            // Stage expanded: Left/Right = same as Up/Down (full depth flat navigation)
            const focusedContainerCollapsed = (() => {
              if (!curId) return false;
              for (const si of slItems) {
                if (!si.isContainer) continue;
                const check = (ch) => ch.some(c => c.id === curId || ((c.children||[]).length > 0 && check(c.children)));
                if (check(si.children || [])) return si.collapsed ?? false;
              }
              return false; // top-level item, not in a container
            })();

            if (focusedContainerCollapsed) {
              // Find the host container and cycle through ALL its children
              let hostContainer = null;
              for (const si of slItems) {
                if (!si.isContainer) continue;
                const check = (ch) => ch.some(c => c.id === curId || ((c.children||[]).length > 0 && check(c.children)));
                if (check(si.children || [])) { hostContainer = si; break; }
              }
              if (!hostContainer) return;
              const flat = [];
              const addAll = (children) => {
                for (const child of children) {
                  const pbIdx = items.findIndex(p => p.id === child.id);
                  if (pbIdx >= 0) flat.push({ id: child.id, pbIdx, isSC: false });
                  else flat.push({ id: child.id, pbIdx: -1, isNested: true });
                  if ((child.children || []).length > 0) addAll(child.children);
                }
              };
              addAll(hostContainer.children || []);
              if (flat.length === 0) return;
              const curIdx = flat.findIndex(f => f.id === curId);
              const newIdx = curIdx === -1
                ? (dir > 0 ? 0 : flat.length - 1)
                : ((curIdx + dir + flat.length) % flat.length); // wrap-around
              applyFocus(flat[newIdx]);
            } else {
              // Expanded (or top-level): same full-depth navigation as Up/Down
              const flat = [];
              for (const slItem of slItems) {
                if (slItem.isContainer) {
                  const addAll = (children) => {
                    for (const child of children) {
                      const pbIdx = items.findIndex(p => p.id === child.id);
                      if (pbIdx >= 0) flat.push({ id: child.id, pbIdx, isSC: false });
                      else flat.push({ id: child.id, pbIdx: -1, isNested: true });
                      if ((child.children || []).length > 0) addAll(child.children);
                    }
                  };
                  addAll(slItem.children || []);
                } else {
                  const pbIdx = items.findIndex(p => p.id === slItem.id);
                  if (pbIdx >= 0) flat.push({ id: slItem.id, pbIdx, isSC: false });
                  for (const child of (slItem.children || [])) {
                    const cPbIdx = items.findIndex(p => p.id === child.id);
                    if (cPbIdx >= 0) flat.push({ id: child.id, pbIdx: cPbIdx, isSC: false });
                    else flat.push({ id: child.id, pbIdx: -1, isNested: true });
                  }
                }
              }
              if (flat.length === 0) return;
              const curIdx = flat.findIndex(f => f.id === curId);
              const newIdx = curIdx === -1
                ? (dir > 0 ? 0 : flat.length - 1)
                : Math.max(0, Math.min(curIdx + dir, flat.length - 1));
              if (newIdx !== curIdx) applyFocus(flat[newIdx]);
            }
          } else {
            // Edit mode: global flat navigation (original behavior)
            const flat = [];
            for (const slItem of slItems) {
              if (slItem.isContainer) {
                const addChildren = (children) => {
                  for (const child of children) {
                    const pbIdx = items.findIndex(p => p.id === child.id);
                    if (pbIdx >= 0) flat.push({ id: child.id, pbIdx, isSC: false });
                    else flat.push({ id: child.id, pbIdx: -1, isNested: true });
                    if ((child.children || []).length > 0) addChildren(child.children);
                  }
                };
                addChildren(slItem.children || []);
              } else {
                const pbIdx = items.findIndex(p => p.id === slItem.id);
                if (pbIdx >= 0) flat.push({ id: slItem.id, pbIdx, isSC: false });
                for (const child of (slItem.children || [])) {
                  const cPbIdx = items.findIndex(p => p.id === child.id);
                  if (cPbIdx >= 0) flat.push({ id: child.id, pbIdx: cPbIdx, isSC: false });
                  else flat.push({ id: child.id, pbIdx: -1, isNested: true });
                }
              }
            }
            if (flat.length === 0) return;
            const curIdx = flat.findIndex(f => f.id === curId);
            const newIdx = curIdx === -1
              ? (dir > 0 ? 0 : flat.length - 1)
              : Math.max(0, Math.min(curIdx + dir, flat.length - 1));
            if (newIdx !== curIdx) applyFocus(flat[newIdx]);
          }
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (panel === "regions") {
          const r = filteredRef.current[highlightedIdxRef.current];
          if (r) {
            fetch(`${API}/play`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ region_id: r.id, start: r.start, end: r.end }),
            }).catch(() => {});
          }
        } else {
          const scId = focusedSCItemIdRef.current;
          const nestedId = focusedNestedItemIdRef.current;
          if (nestedId) {
            // Nested item — find parent folder (inside container or top-level) and play with child index
            outer: for (const slItem of setlistItemsRef.current) {
              if (slItem.isContainer) {
                for (const child of (slItem.children || [])) {
                  if (child.isFolder) {
                    const cIdx = (child.children || []).findIndex(gc => gc.id === nestedId);
                    if (cIdx >= 0) {
                      const pbIdx = playbackItemsRef.current.findIndex(p => p.id === child.id);
                      if (pbIdx >= 0) playItem(child, pbIdx, cIdx);
                      break outer;
                    }
                  }
                }
              } else if (slItem.isFolder) {
                const cIdx = (slItem.children || []).findIndex(gc => gc.id === nestedId);
                if (cIdx >= 0) {
                  const pbIdx = playbackItemsRef.current.findIndex(p => p.id === slItem.id);
                  if (pbIdx >= 0) playItem(slItem, pbIdx, cIdx);
                  break outer;
                }
              }
            }
          } else {
            const items = playbackItemsRef.current;
            const fi = focusedIndexRef.current;
            if (fi >= 0 && fi < items.length) {
              const item = items[fi];
              // Detect if this item is acting as the nav proxy for a collapsed container.
              // When a container is collapsed, the nav stop is its first child. If that
              // first child is a PAC folder, we must NOT apply PAC folder logic — we
              // should play the item directly (its own region, e.g. "Loading").
              const isCollapsedContainerProxy = (() => {
                for (const slItem of setlistItemsRef.current) {
                  if (!slItem.isContainer) continue;
                  const isCollapsed = (slItem.collapsed ?? false) || stageCollapsedRef.current.has(slItem.id);
                  if (isCollapsed) {
                    const firstChild = (slItem.children || [])[0];
                    if (firstChild && firstChild.id === item.id) return true;
                  }
                }
                return false;
              })();
              // Enter always plays the item/header directly; number keys 1-9 select PAC children
              playItem(items[fi], fi);
            }
          }
        }
      } else if (e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1; // 0-based
        const items = playbackItemsRef.current;
        const ci = currentIndexRef.current;
        if (ci >= 0 && ci < items.length) {
          const item = items[ci];
          if (item.isFolder && item.keycommand && item.children && item.children[idx]) {
            e.preventDefault();
            playItem(item, ci, idx); // immediately play that child
          }
        }
      } else if (e.key === " ") {
        e.preventDefault();
        stopPlayback();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, showFileMenu, showProject, showConsole, showDrawer]);

  // ── Drag & drop ────────────────────────────────────────────────────────────
  function findContainerOfItem(items, itemId) {
    for (const item of items) {
      if (item.isContainer && (item.children || []).some(c => c.id === itemId)) return item.id;
    }
    return null;
  }

  // Find the PAC folder that owns a leaf (nested 3 levels deep)
  // Returns { folderId, containerId } or null
  function findFolderOfLeaf(items, leafId) {
    for (const item of items) {
      if (item.isFolder && (item.children||[]).some(c => c.id === leafId))
        return { folderId: item.id, containerId: null };
      if (item.isContainer) {
        for (const child of (item.children||[])) {
          if (child.isFolder && (child.children||[]).some(c => c.id === leafId))
            return { folderId: child.id, containerId: item.id };
        }
      }
    }
    return null;
  }

  function onDragEnd({ active, over }) {
    setDragId(null);
    if (!over || active.id === over.id) return;

    // PAC leaf reorder (highest priority — check before container/top-level)
    const activeFolderInfo = findFolderOfLeaf(setlistItems, active.id);
    const overFolderInfo   = findFolderOfLeaf(setlistItems, over.id);
    if (activeFolderInfo && overFolderInfo && activeFolderInfo.folderId === overFolderInfo.folderId) {
      mutateSetlist(items => items.map(item => {
        if (activeFolderInfo.containerId) {
          // Folder is inside a container
          if (item.id !== activeFolderInfo.containerId) return item;
          return { ...item, children: (item.children||[]).map(child => {
            if (child.id !== activeFolderInfo.folderId) return child;
            const leaves = child.children || [];
            const oi = leaves.findIndex(l => l.id === active.id);
            const ni = leaves.findIndex(l => l.id === over.id);
            if (oi < 0 || ni < 0) return child;
            return { ...child, children: arrayMove(leaves, oi, ni) };
          })};
        } else {
          // Top-level folder
          if (item.id !== activeFolderInfo.folderId) return item;
          const leaves = item.children || [];
          const oi = leaves.findIndex(l => l.id === active.id);
          const ni = leaves.findIndex(l => l.id === over.id);
          if (oi < 0 || ni < 0) return item;
          return { ...item, children: arrayMove(leaves, oi, ni) };
        }
      }));
      return;
    }

    const activeContainerId = findContainerOfItem(setlistItems, active.id);
    const overContainerId   = findContainerOfItem(setlistItems, over.id);

    if (activeContainerId && activeContainerId === overContainerId) {
      // Reorder within container
      mutateSetlist(items => items.map(item => {
        if (item.id !== activeContainerId) return item;
        const children = item.children || [];
        const oi = children.findIndex(c => c.id === active.id);
        const ni = children.findIndex(c => c.id === over.id);
        if (oi < 0 || ni < 0) return item;
        return { ...item, children: arrayMove(children, oi, ni) };
      }));
    } else {
      mutateSetlist(items => {
        const oi = items.findIndex(i => i.id === active.id);
        let ni = items.findIndex(i => i.id === over.id);
        // over.id may be a child inside a container — fall back to that container's index
        if (ni < 0) ni = items.findIndex(i => i.isContainer && (i.children||[]).some(c => c.id === over.id));
        if (oi < 0 || ni < 0) return items;
        const currentId = currentIndex >= 0 ? playbackItemsRef.current[currentIndex]?.id : null;
        const reordered = arrayMove(items, oi, ni);
        if (currentId) {
          const newPbItems = [];
          for (const item of reordered) {
            if (item.isContainer) { for (const child of (item.children || [])) newPbItems.push(child); }
            else newPbItems.push(item);
          }
          setCurrentIndex(newPbItems.findIndex(i => i.id === currentId));
        }
        return reordered;
      });
    }
  }

  // ── Setlist file management ─────────────────────────────────────────────────
  async function newSetlist() {
    let defaultRpp = "";
    try {
      const d = await fetch(`${API}/current-project-path`).then(r => r.json());
      defaultRpp = d.path || "";
    } catch(e){}
    // Default name to the RPP filename, fall back to numbered setlist
    const defaultName = defaultRpp
      ? rppName(defaultRpp)
      : `Setlist ${allSetlists.length + 1}`;
    setNewSetlistDraft({ name: defaultName, rppPath: defaultRpp, error: "" });
    setShowNewSetlist(true);
    setShowFileMenu(false);
  }

  async function confirmNewSetlist() {
    if (!newSetlistDraft.name.trim()) {
      setNewSetlistDraft(d => ({ ...d, error: "Please enter a name." })); return;
    }
    if (!newSetlistDraft.rppPath.trim()) {
      setNewSetlistDraft(d => ({ ...d, error: "A Reaper project (.rpp) is required." })); return;
    }
    const sl = makeNewSetlist(newSetlistDraft.name.trim(), newSetlistDraft.rppPath.trim());
    const next = [...allSetlists, sl];
    setAllSetlists(next);
    saveAllSetlistsToDisk(next);
    setActiveId(sl.id);
    setCurrentIndex(-1);
    setFocusedIndex(-1);
    setShowNewSetlist(false);
    setNewSetlistDraft(null);
  }

  async function useCurrentForNewSetlist() {
    try {
      const d = await fetch(`${API}/current-project-path`).then(r => r.json());
      if (d.path) {
        const name = rppName(d.path);
        setNewSetlistDraft(dr => ({
          ...dr,
          rppPath: d.path,
          // Only overwrite name if user hasn't changed it from default
          name: (!dr.name || dr.name === `Setlist ${allSetlists.length + 1}`) ? name : dr.name,
          error: ""
        }));
      }
    } catch(e) { console.error(e); }
  }

  async function refreshSetlistsFromServer() {
    const lists = await loadAllSetlistsFromDisk();
    setAllSetlists(lists);
    // Stay on whatever setlist is currently open if it still exists; only
    // fall back to auto-selecting one if it was deleted from elsewhere.
    setActiveId(prev => (prev && lists.some(s => s.id === prev)) ? prev : (lists[0]?.id || null));
  }
  useEffect(() => { refreshSetlistsRef.current = refreshSetlistsFromServer; });

  async function loadSetlist(id) {
    const target = allSetlists.find(s => s.id === id);
    if (!target) return;
    // If different rpp, open it in Reaper
    if (target.rppPath && reaperConnected) {
      try {
        const cur = await fetch(`${API}/current-project-path`).then(r => r.json());
        if (cur.path && cur.path.toLowerCase() !== target.rppPath.toLowerCase()) {
          await fetch(`${API}/open-project`, {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ rpp_path: target.rppPath }),
          });
          await new Promise(r => setTimeout(r, 800));
          fetchProjects();
        }
      } catch(e){ console.error(e); }
    }
    setActiveId(id);
    setCurrentIndex(-1);
    setFocusedIndex(-1);
    setShowFileMenu(false);
    // Update lastUsed timestamp for sort order
    const updated = allSetlists.map(s => s.id === id ? {...s, lastUsed: Date.now()} : s);
    setAllSetlists(updated);
    saveAllSetlistsToDisk(updated);
  }

  function saveCurrentSetlist() {
    saveAllSetlistsToDisk(allSetlists);
    setShowFileMenu(false);
  }

  function renameSetlist(id) {
    const sl = allSetlists.find(s => s.id === id);
    const name = prompt("Rename setlist:", sl?.name || "");
    if (!name) return;
    const next = allSetlists.map(s => s.id === id ? { ...s, name } : s);
    setAllSetlists(next);
    saveAllSetlistsToDisk(next);
  }

  function deleteSetlist(id) {
    if (!confirm("Delete this setlist?")) return;
    const next = allSetlists.filter(s => s.id !== id);
    setAllSetlists(next);
    saveAllSetlistsToDisk(next);
    if (activeSetlistId === id) { setActiveId(next[0]?.id || null); setCurrentIndex(-1); }
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function updateRpp(path) {
    const next = allSetlists.map(s => s.id === activeSetlistId ? { ...s, rppPath: path } : s);
    setAllSetlists(next);
    saveAllSetlistsToDisk(next);
  }

  async function openReaper(rppPath) {
    try {
      await fetch(`${API}/open-reaper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rpp_path: rppPath || null }),
      });
    } catch(e) { console.error(e); }
  }

  // ── Active drag item ───────────────────────────────────────────────────────
  const dragItem = activeId ? setlistItems.find(i => i.id === activeId) : null;

  // ── Stage timing ───────────────────────────────────────────────────────────
  const isPickACover = (item) => !!(item && item.isFolder && item.keycommand);
  const stageTotalTime = playbackItems
    .filter(i => !i.infiniteLoop && !i._isSoundcheck)
    .reduce((sum, item) => sum + getEffectiveDuration(item), 0);
  const stageElapsed = playbackItems.slice(0, Math.max(0, currentIndex))
    .filter(i => !i.infiniteLoop && !i._isSoundcheck)
    .reduce((sum, item) => sum + getEffectiveDuration(item), 0)
    + (currentIndex >= 0 && playbackItems[currentIndex] && !playbackItems[currentIndex]._isSoundcheck
      ? (() => {
          const item = playbackItems[currentIndex];
          if (item.infiniteLoop || isPickACover(item)) {
            // Pick A Cover: use position within the active child's region
            if (isPickACover(item) && (item.children || []).length > 0) {
              const activeChild = item.children[currentChildIndex >= 0 ? currentChildIndex : 0];
              const cr = getLiveItem(activeChild);
              return Math.max(0, position - (cr?.start || 0));
            }
            const r = getLiveItem(item);
            return Math.max(0, position - (r.start||0));
          }
          const r = getLiveItem(item);
          return Math.max(0, Math.min(position - (r.start||0), (r.end||0) - (r.start||0)));
        })()
      : 0);

  // Load saved settings when setlist changes; collapse all stage containers by default
  useEffect(() => {
    if (activeSetlist) {
      setClickTrackIdx(activeSetlist.clickTrackIdx ?? -1);
      setMainTrackIdx(activeSetlist.mainTrackIdx  ?? -1);
      setAutoAdvance(activeSetlist.autoAdvance ?? true);
      setStageCollapsed(new Set(activeSetlist.items.filter(i => i.isContainer).map(i => i.id)));
    }
  }, [activeSetlistId]);

  function handleUpdateSetlistMidi(devices) {
    const next = allSetlists.map(s => s.id === activeSetlistId ? {...s, midiDevices: devices} : s);
    setAllSetlists(next); saveAllSetlistsToDisk(next);
  }

  function handleAutoAdvance(val) {
    setAutoAdvance(val);
    const next = allSetlists.map(s => s.id === activeSetlistId ? {...s, autoAdvance: val} : s);
    setAllSetlists(next); saveAllSetlistsToDisk(next);
  }
  function handleClickTrack(idx) {
    setClickTrackIdx(idx);
    const next = allSetlists.map(s => s.id === activeSetlistId ? {...s, clickTrackIdx: idx} : s);
    setAllSetlists(next); saveAllSetlistsToDisk(next);
  }
  function handleMainTrack(idx) {
    setMainTrackIdx(idx);
    const next = allSetlists.map(s => s.id === activeSetlistId ? {...s, mainTrackIdx: idx} : s);
    setAllSetlists(next); saveAllSetlistsToDisk(next);
  }
  // Derived: are all containers collapsed? (used for single-toggle button)
  const allContainersCollapsed = setlistItems.filter(i => i.isContainer).length > 0 &&
    setlistItems.filter(i => i.isContainer).every(i => i.collapsed);
  const allStageContainersCollapsed = setlistItems.filter(i => i.isContainer).length > 0 &&
    setlistItems.filter(i => i.isContainer).every(i => stageCollapsed.has(i.id));

  // ID-based focused/current tracking — avoids false matches when items share a region name
  const focusedItemId      = focusedIndex >= 0      ? playbackItems[focusedIndex]?.id      ?? null : null;
  const currentPlayingItemId = currentIndex >= 0    ? playbackItems[currentIndex]?.id      ?? null : null;

  // Master now-playing name for header timer
  const nowPlayingName = (() => {
    if (currentIndex >= 0 && playbackItems[currentIndex]) {
      const item = playbackItems[currentIndex];
      if (isPickACover(item) && currentChildIndex >= 0) {
        const child = (item.children || [])[currentChildIndex];
        return child ? (getLiveItem(child).name || child.name) : (item.name);
      }
      return getLiveItem(item).name || item.name;
    }
    return null;
  })();
  const stageRemaining = Math.max(0, stageTotalTime - stageElapsed);

  // Soundcheck item timing — shown in place of set timing when an SC item is playing
  const scLiveItem = (() => {
    if (currentIndex < 0) return null;
    const cur = playbackItems[currentIndex];
    if (!cur?._isSoundcheck) return null;
    return getLiveItem(cur);
  })();
  const scTotal   = scLiveItem ? Math.max(0, (scLiveItem.end || 0) - (scLiveItem.start || 0)) : 0;
  const scElapsed = scLiveItem ? Math.max(0, Math.min(position - (scLiveItem.start || 0), scTotal)) : 0;
  const scRemaining = Math.max(0, scTotal - scElapsed);

  // ── Auto-stop when a soundcheck item reaches its end ───────────────────
  const scStopTriggeredRef = useRef(null);
  useEffect(() => {
    const cur = currentIndex >= 0 ? playbackItems[currentIndex] : null;
    if (!isPlaying || !cur?._isSoundcheck) { scStopTriggeredRef.current = null; return; }
    if (scStopTriggeredRef.current === cur.id) return;
    const live = getLiveItem(cur);
    if (live?.end && position >= live.end - 0.15) {
      scStopTriggeredRef.current = cur.id;
      fetch(`${API}/stop`, { method: "POST" });
    }
  }, [position]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`app mode-${mode}${narrow ? " narrow" : ""}`}>

      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-left">
          {isAdmin && <button className="hdr-btn" onClick={() => setShowFileMenu(true)} title="Setlists">☰</button>}
          <div className="logo">
            <span className="logo-gem">◈</span>
            <span className="logo-g">GENIUS</span>
            <span className="logo-s">SETLIST</span>
          </div>
          {isAdmin && activeSetlist && (
            <div className="active-setlist-name">{activeSetlist.name}</div>
          )}
        </div>

        <div className="header-center">
          <StatusBadge reaperConnected={reaperConnected} wsConnected={wsConnected} />
        </div>

        {/* Everything past the connection badge is admin-only chrome — a
            non-admin device is always in Stage view anyway, so there's
            nothing here for it to do. */}
        {isAdmin && (
        <div className="header-right">
          <button className="hdr-btn" onClick={() => openReaper(activeSetlist?.rppPath)} title="Launch Reaper">
            <span className="reaper-ico">▣</span>
          </button>
          <div className="mode-toggle">
            <button className={`mode-btn${mode==="edit" ? " on" : ""}`} onClick={() => setMode("edit")}>EDIT</button>
            <button className={`mode-btn${mode==="stage" ? " on" : ""}`} onClick={() => setMode("stage")}>STAGE</button>
          </div>
          {activeSetlist && (
            <button className="hdr-btn" onClick={() => setShowProject(true)} title="Project settings">⚙</button>
          )}
          <button className="hdr-btn" onClick={fetchInstructions} title="Help / Setup Instructions" style={{fontFamily:"var(--mono)",fontWeight:700}}>?</button>
          <button className="hdr-btn" onClick={() => setShowConsole(true)} title="Console / Diagnostics">⌨</button>
          <div className="pos-disp">
            {nowPlayingName && <span className="pos-track">{nowPlayingName}</span>}
            <div className="pos-times">
              <span className="pos-elapsed">{fmtClock(scLiveItem ? scElapsed : stageElapsed)}</span>
              <span className="pos-sep"> / </span>
              <span className="pos-total">{fmtClock(scLiveItem ? scTotal : stageTotalTime)}</span>
              {(scLiveItem ? scTotal > 0 : stageTotalTime > 0) && <><span className="pos-sep"> | </span><span className="pos-remaining">-{fmtClock(scLiveItem ? scRemaining : stageRemaining)}</span></>}
            </div>
          </div>
        </div>
        )}
      </header>

      {/* ── Project / MIDI toolbar (admin only — project linking/MIDI setup) ── */}
      {isAdmin && (projects.length > 0 || (activeSetlist?.midiDevices?.length > 0)) && (
        <div className="project-tabs">
          {projects.length > 0 && <>
            <span className="tabs-lbl">PROJECT</span>
            {projects.map(p => (
              <button key={p.index}
                className={`proj-tab${p.index === activeProjIdx ? " on" : ""}`}
                onClick={() => selectProject(p.index)} title={p.path}>
                {p.name}
              </button>
            ))}
            <button className="tab-refresh" onClick={fetchProjects} title="Refresh">↺</button>
          </>}
          <MidiDeviceBar devices={activeSetlist?.midiDevices || []} availableDevices={midiDevices} />
        </div>
      )}

      {/* ── Main ── */}
      {mode === "edit" && <div className="edit-shell"><main className="app-main">

        {/* ── Regions panel ── */}
        {!narrow && (
          <section className="panel regions-panel" data-active={focusPanel==="regions"} onMouseDown={() => setFocusPanel("regions")}>
            <div className="panel-hdr">
              <div className="panel-hdr-left">
                <h2>REGIONS <span className="rcount">{filtered.length}/{regions.length}</span></h2>
              </div>
              <div className="panel-hdr-right">
                <div className="sort-btns">
                  <button className={`sort-btn${regionSort === "default" ? " on" : ""}`} onClick={() => { setRegionSort("default"); localStorage.setItem("regionSort","default"); }} title="Default order">·</button>
                  <button className={`sort-btn${regionSort === "name" ? " on" : ""}`} onClick={() => { setRegionSort("name"); localStorage.setItem("regionSort","name"); }} title="Sort by name">A</button>
                  <button className={`sort-btn${regionSort === "id" ? " on" : ""}`} onClick={() => { setRegionSort("id"); localStorage.setItem("regionSort","id"); }} title="Sort by ID asc">#↑</button>
                  <button className={`sort-btn${regionSort === "id-desc" ? " on" : ""}`} onClick={() => { setRegionSort("id-desc"); localStorage.setItem("regionSort","id-desc"); }} title="Sort by ID desc (newest first)">#↓</button>
                </div>
              </div>
            </div>

            <div className="search-bar">
              <span className="search-icon">⌕</span>
              <input ref={searchRef} className="search-input" value={search}
                onChange={e => setSearch(e.target.value)} onKeyDown={handleSearchKey}
                placeholder="Search regions…" spellCheck={false} />
              {search && <button className="search-clear" onClick={() => setSearch("")}>✕</button>}
            </div>

            {loadingRegions
              ? <div className="loading"><div className="spinner"/><span>Loading…</span></div>
              : regions.length > 0 && filtered.length === 0
              ? <div className="empty-state"><span>No match for "{search}"</span></div>
              : regions.length > 0
              ? (
                <div className="region-list" ref={regionListRef}>
                  {filtered.map((r, i) => (
                    <div key={r.id} data-idx={i}>
                      <RegionRow key={r.id} region={r} highlighted={i === highlightedIdx}
                        onClick={() => setHighlightIdx(i)} onAdd={addToSetlist}
                        onPlay={r => {
                          fetch(`${API}/play`, {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ region_id: r.id, start: r.start, end: r.end }),
                          }).catch(() => {});
                        }}
                      />
                    </div>
                  ))}
                </div>
              )
              : !reaperConnected
              ? <div className="empty-state regions-disconnected">
                  <span className="empty-ico">⬡</span>
                  <span>Reaper not connected</span>
                  <small>Open Reaper and run the bridge script,<br/>then regions will appear here automatically.</small>
                  <small className="hint-settings">Open Console (⌨) for setup steps.</small>
                </div>
              : <div className="empty-state">
                  <span className="empty-ico pulse">○</span>
                  <span>No regions in project</span>
                  <small>Add regions in Reaper — this list updates automatically.</small>
                </div>
            }
            <div className="search-hint">↑↓ navigate · Enter add · Esc clear</div>
          </section>
        )}

        {/* ── Setlist panel ── */}
        <section className="panel setlist-panel" data-active={focusPanel==="setlist"} onMouseDown={() => setFocusPanel("setlist")}>
          <div className="panel-hdr">
            <div className="panel-hdr-left">
              {narrow && mode === "edit" && (
                <button className="hdr-btn sm" onClick={() => setShowDrawer(true)} title="Browse regions">⊞ REGIONS</button>
              )}
              <h2>SETLIST</h2>
              {mode === "edit" && (
                <button className="hdr-btn sm" onClick={createContainer} title="Add section container">+ Section</button>
              )}
              {setlistItems.some(i => i.isContainer) && (
                <button className="hdr-btn sm"
                  onClick={allContainersCollapsed ? expandAllContainers : collapseAllContainers}
                  title={allContainersCollapsed ? "Expand all sections" : "Collapse all sections"}>
                  {allContainersCollapsed ? "▼ All" : "▶ All"}
                </button>
              )}
            </div>
            <div className="panel-hdr-right">
              {mode === "edit" && setlistItems.length > 0 && (
                <button className="clear-btn" onClick={() => {
                  if (confirm("Clear setlist?")) { mutateSetlist(() => []); setCurrentIndex(-1); stopPlayback(); }
                }}>CLEAR</button>
              )}
              {mode === "stage" && (
                <span className="stage-badge">STAGE MODE</span>
              )}
            </div>
          </div>

          {!activeSetlist ? (
            <div className="empty-state full-center">
              <span className="big-icon">◈</span>
              <span>No setlist selected</span>
              <small>Open ☰ to create or load a setlist</small>
              <button className="cta-btn" onClick={() => setShowFileMenu(true)}>OPEN SETLISTS</button>
            </div>
          ) : setlistItems.length === 0 ? (
            <div className="empty-state full-center">
              {mode === "edit"
                ? <><span className="big-arrow">←</span><span>Add regions from the left panel</span><small>Search · click + or press Enter</small></>
                : <><span>Setlist is empty</span><small>Switch to Edit mode to add regions</small></>
              }
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter}
              onDragStart={e => setDragId(e.active.id)} onDragEnd={onDragEnd}>
              <SortableContext items={setlistItems.filter(i => !i.disabled).map(i => i.id)} strategy={verticalListSortingStrategy}>
                <div className="sl-list" role="listbox" ref={slListRef}>
                  {setlistItems.filter(i => !i.disabled).map((item, idx) => {
                    if (item.isContainer) {
                      const containerPlayingCollapsed = (item.children || []).some(c => c.id === currentPlayingItemId && isPlaying);
                      const containerFocused = (item.children || []).some(c =>
                        c.id === focusedItemId || c.id === focusedSCItemId ||
                        (c.isFolder && (c.children||[]).some(l => l.id === focusedNestedItemId))
                      );
                      const hasPACWaiting = (item.children || []).some(c =>
                        c.isFolder && c.keycommand && c.id === currentPlayingItemId && isPlaying && currentChildIndex === -1
                      );
                      return (
                        <SortableContainerBlock key={item.id} id={item.id} editMode={mode === "edit"} className={[item.isSoundcheck ? "soundcheck" : "", containerPlayingCollapsed ? "playing-collapsed" : "", containerFocused ? "container-focused" : "", item.disabled ? "disabled-container" : ""].filter(Boolean).join(" ")}>
                          {({ dragAttrs, dragListeners }) => (<>
                            {(() => {
                              // Header shows the PLAYING song; chip highlight shows the SELECTED song.
                              // Priority: currentPlayingItemId (with PAC leaf) > focused fallback
                              let activeChildName = null;
                              if (item.collapsed) {
                                const children = item.children || [];
                                const playingMatch = children.find(c => c.id === currentPlayingItemId);
                                if (playingMatch) {
                                  if (playingMatch.isFolder && playingMatch.keycommand && currentChildIndex >= 0) {
                                    const leaf = (playingMatch.children || [])[currentChildIndex];
                                    activeChildName = leaf ? getLiveItem(leaf).name : getLiveItem(playingMatch).name;
                                  } else {
                                    activeChildName = getLiveItem(playingMatch).name;
                                  }
                                } else {
                                  // Nothing playing — fall back to focused item
                                  if (focusedNestedItemId) {
                                    for (const c of children) {
                                      if (c.isFolder && c.keycommand) {
                                        const leafIdx = (c.children || []).findIndex(l => l.id === focusedNestedItemId);
                                        if (leafIdx >= 0) { activeChildName = getLiveItem(c.children[leafIdx]).name; break; }
                                      }
                                    }
                                  }
                                  if (!activeChildName) {
                                    const focusedMatch = children.find(c => c.id === focusedItemId || c.id === focusedSCItemId);
                                    if (focusedMatch) activeChildName = getLiveItem(focusedMatch).name;
                                  }
                                }
                              }
                              return (
                                <>
                                <ContainerHeader
                                  item={item} editMode={mode === "edit"}
                                  onCollapse={toggleContainerCollapsed}
                                  onRename={renameItem}
                                  onRemove={id => mutateSetlist(items => items.filter(i => i.id !== id))}
                                  onAddChild={id => { const r = filteredRef.current[highlightedIdxRef.current]; if(r) addToContainer(id, r); }}
                                  onToggleSoundcheck={toggleContainerSoundcheck}
                                  onToggleDisabled={toggleContainerDisabled}
                                  activeChildName={activeChildName}
                                  hasPACWaiting={hasPACWaiting}
                                  totalTime={(() => {
                                    let t = 0;
                                    for (const child of item.children || []) {
                                      if (child.infiniteLoop) continue;
                                      if (child.isFolder && child.keycommand) {
                                        // PAC: use selectedChildIdx (default 0)
                                        const leaves = child.children || [];
                                        if (leaves.length > 0) {
                                          const idx = Math.min(child.selectedChildIdx ?? 0, leaves.length - 1);
                                          const lr = getLiveItem(leaves[idx]);
                                          t += (lr.end || 0) - (lr.start || 0);
                                        }
                                      } else {
                                        t += getEffectiveDuration(child);
                                      }
                                    }
                                    return t;
                                  })()}
                                  onSelectFirst={() => {
                                    if (item.isSoundcheck) {
                                      const first = (item.children || [])[0];
                                      if (first) { setFocusedSCItemId(first.id); setFocusedIndex(-1); }
                                    } else {
                                      const first = (item.children || []).find(c => playbackItems.some(p => p.id === c.id));
                                      if (first) { const idx = playbackItems.findIndex(p => p.id === first.id); if (idx >= 0) setFocusedIndex(idx); }
                                    }
                                  }}
                                  dragAttrs={dragAttrs} dragListeners={dragListeners}
                                />
                                {/* Collapsed container: show ALL children as small chips */}
                                {item.collapsed && (item.children || []).length > 0 && (
                                  <div className="container-collapsed-chips">
                                    {(item.children || []).map((child) => {
                                      if (child.isFolder && child.keycommand) {
                                        const isPACFolderFoc = child.id === focusedItemId;
                                        return [
                                          <span key={`${child.id}-lbl`} className={`container-pac-name${isPACFolderFoc ? ' focused' : ''}`}>
                                            {child.name}{child.infiniteLoop && <span className="chip-badge chip-badge-loop">∞</span>}<span className="chip-badge chip-badge-kc">⌨</span>
                                          </span>,
                                          ...(child.children || []).map((leaf, li) => {
                                            const lr = getLiveItem(leaf);
                                            const isActive = child.id === currentPlayingItemId && li === currentChildIndex;
                                            const isFocLeaf = leaf.id === focusedNestedItemId;
                                            return <span key={leaf.id} className={`container-pac-chip${isActive ? ' active' : ''}${isFocLeaf ? ' focused' : ''}`}>{li + 1} {lr.name}{leaf.infiniteLoop && <span className="chip-badge chip-badge-loop">∞</span>}</span>;
                                          })
                                        ];
                                      }
                                      const live = getLiveItem(child);
                                      const isActive = child.id === currentPlayingItemId;
                                      const isFoc = child.id === focusedItemId || child.id === focusedSCItemId;
                                      return <span key={child.id} className={`container-track-chip${isActive ? ' active' : ''}${isFoc ? ' focused' : ''}`}>
                                        {live.name}{child.infiniteLoop && <span className="chip-badge chip-badge-loop">∞</span>}{child.isFolder && !child.keycommand && <span className="chip-badge chip-badge-folder">⊞</span>}
                                      </span>;
                                    })}
                                  </div>
                                )}
                                </>
                              );
                            })()}
                            {!item.collapsed && (
                              <div className="container-children">
                                <SortableContext items={(item.children || []).map(c => c.id)} strategy={verticalListSortingStrategy}>
                                {(item.children || []).map((child, childIdx) => {
                                const playbackIdx = playbackItems.findIndex(p => p.id === child.id);
                                return (
                                  <div key={child.id} className="container-child-wrap" data-sli={playbackIdx >= 0 ? playbackIdx : undefined}>
                                    <SetlistRow item={getLiveItem(child)} index={playbackIdx} displayIndex={childIdx + 1}
                                      isCurrent={playbackIdx >= 0 && playbackIdx === currentIndex}
                                      isPlaying={isPlaying}
                                      isFocused={playbackIdx >= 0 && playbackIdx === focusedIndex}
                                      editMode={mode === "edit"}
                                      position={position}
                                      onPlay={playItem}
                                      onPause={pausePlayback}
                                      onRemove={() => removeContainerChild(item.id, child.id)}
                                      onFocus={() => playbackIdx >= 0 && setFocusedIndex(playbackIdx)}
                                      onToggleLoop={id => toggleItemFlag(id, 'infiniteLoop')}
                                      onToggleFolder={id => toggleItemFlag(id, 'isFolder')}
                                      onToggleCollapsed={toggleFolderCollapsed}
                                      onToggleKeycommand={toggleKeycommand}
                                    />
                                    {child.isFolder && !child.collapsed && (
                                      <div className="folder-children container-folder-children">
                                        <SortableContext items={(child.children||[]).map(l => l.id)} strategy={verticalListSortingStrategy}>
                                        {(child.children || []).map((leaf, leafIdx) => (
                                          <SortableLeafItem key={leaf.id} id={leaf.id} disabled={mode !== "edit"}>
                                            {(dragAttrs, dragListeners) => (
                                              <div className="keycommand-child-wrap">
                                                {child.keycommand && <span className="kc-badge">{leafIdx + 1}</span>}
                                                <ChildRow
                                                  child={getLiveItem(leaf)}
                                                  parentIdx={playbackIdx}
                                                  childIdx={leafIdx}
                                                  isSelected={(child.selectedChildIdx ?? 0) === leafIdx}
                                                  isCurrent={playbackIdx === currentIndex && leafIdx === currentChildIndex}
                                                  isPlaying={isPlaying}
                                                  editMode={mode === "edit"}
                                                  position={position}
                                                  dragAttrs={dragAttrs}
                                                  dragListeners={dragListeners}
                                                  onSelect={() => setSelectedChild(playbackIdx, leafIdx)}
                                                  onRemove={() => {
                                                    mutateSetlist(items => items.map(i => i.id === item.id
                                                      ? { ...i, children: (i.children||[]).map(c => c.id === child.id
                                                          ? { ...c, children: (c.children||[]).filter(l => l.id !== leaf.id) }
                                                          : c) }
                                                      : i
                                                    ));
                                                  }}
                                                  onPlay={() => playItem(child, playbackIdx, leafIdx)}
                                                />
                                              </div>
                                            )}
                                          </SortableLeafItem>
                                        ))}
                                        </SortableContext>
                                        {mode === "edit" && (
                                          <button className="folder-add-child-btn" onClick={() => {
                                            const r = filteredRef.current[highlightedIdxRef.current];
                                            if (!r) return;
                                            mutateSetlist(items => items.map(i => i.id === item.id
                                              ? { ...i, children: (i.children||[]).map(c => c.id === child.id
                                                  ? { ...c, children: [...(c.children||[]), { ...r, id: uid(), region_id: r.id, region_index: r.index }] }
                                                  : c) }
                                              : i
                                            ));
                                          }}>+ Add highlighted region as child</button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                                })}
                                </SortableContext>
                              </div>
                            )}
                          </>)}
                        </SortableContainerBlock>
                      );
                    }

                    // Regular top-level item
                    const pbIdx = playbackItems.findIndex(p => p.id === item.id);
                    return (
                      <div key={item.id} data-sli={pbIdx >= 0 ? pbIdx : idx}>
                        <SetlistRow item={getLiveItem(item)} index={pbIdx}
                          isCurrent={pbIdx === currentIndex}
                          isPlaying={isPlaying}
                          isFocused={pbIdx === focusedIndex}
                          editMode={mode === "edit"}
                          position={position}
                          onPlay={playItem}
                          onPause={pausePlayback}
                          onRemove={removeFromSetlist}
                          onFocus={() => setFocusedIndex(pbIdx)}
                          onToggleLoop={id => toggleItemFlag(id, 'infiniteLoop')}
                          onToggleFolder={id => toggleItemFlag(id, 'isFolder')}
                          onToggleCollapsed={toggleFolderCollapsed}
                          onToggleKeycommand={toggleKeycommand}
                        />
                        {item.isFolder && !item.collapsed && (
                          <div className="folder-children">
                            <SortableContext items={(item.children||[]).map(c => c.id)} strategy={verticalListSortingStrategy}>
                            {(item.children || []).map((child, childIdx) => (
                              <SortableLeafItem key={child.id} id={child.id} disabled={mode !== "edit"}>
                                {(dragAttrs, dragListeners) => (
                                  <div className="keycommand-child-wrap">
                                    {item.keycommand && <span className="kc-badge">{childIdx + 1}</span>}
                                    <ChildRow
                                      child={getLiveItem(child)}
                                      parentIdx={pbIdx}
                                      childIdx={childIdx}
                                      isSelected={(item.selectedChildIdx ?? 0) === childIdx}
                                      isCurrent={pbIdx === currentIndex && childIdx === currentChildIndex}
                                      isPlaying={isPlaying}
                                      editMode={mode === "edit"}
                                      position={position}
                                      dragAttrs={dragAttrs}
                                      dragListeners={dragListeners}
                                      onSelect={() => setSelectedChild(pbIdx, childIdx)}
                                      onRemove={() => removeChildFromFolder(pbIdx, child.id)}
                                      onPlay={() => playItem(item, pbIdx, childIdx)}
                                    />
                                  </div>
                                )}
                              </SortableLeafItem>
                            ))}
                            </SortableContext>
                            {mode === "edit" && (
                              <button className="folder-add-child-btn" onClick={() => addChildToFolder(pbIdx)}>
                                + Add highlighted region as child
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </SortableContext>
              {mode === "edit" && setlistItems.some(i => i.disabled) && (
                <div className="disabled-section">
                  <div className="disabled-section-hdr" onClick={() => setDisabledSectionCollapsed(c => !c)}>
                    <span className="disabled-section-arrow">{disabledSectionCollapsed ? "▶" : "▼"}</span>
                    <span>Disabled</span>
                    <span className="disabled-section-count">{setlistItems.filter(i => i.disabled).length}</span>
                  </div>
                  {!disabledSectionCollapsed && <div className="disabled-items-scroll">
                  {setlistItems.filter(i => i.disabled).map(item => (
                    <div key={item.id} className="container-block disabled-container" style={{margin:'2px 0'}}>
                      <ContainerHeader
                        item={item}
                        editMode={true}
                        onCollapse={() => {}}
                        onRename={renameItem}
                        onRemove={id => mutateSetlist(items => items.filter(i => i.id !== id))}
                        onAddChild={() => {}}
                        onToggleSoundcheck={toggleContainerSoundcheck}
                        onToggleDisabled={toggleContainerDisabled}
                        onSelectFirst={() => {}}
                        activeChildName={null}
                        hasPACWaiting={false}
                        totalTime={null}
                        dragAttrs={{}}
                        dragListeners={{}}
                      />
                    </div>
                  ))}</div>}
                </div>
              )}
              <DragOverlay>
                {dragItem && (
                  <div className="sl-row drag-ghost">
                    <div className="sl-color" style={{ background: dragItem.color }} />
                    <span className="sl-name">{dragItem.name}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          )}
        </section>
      </main>
        <aside className="vu-panel">
          <ClickFlash level={clickTrackIdx >= 0 ? trackPeaks[clickTrackIdx] : undefined} />
          <VUMeter label="TRACKS" level={mainTrackIdx >= 0 ? trackPeaks[mainTrackIdx] : undefined} />
        </aside>
      </div>}

      {/* ── Stage view ── */}
      {/* Stage mode always uses the phone-style view — same look on every
          connected device, admin or not, regardless of screen width. The
          old desktop 3-column layout (song list + big clock + VU sidebar)
          is retired; MobileStageView is now the only Stage view. */}
      {mode === "stage" && (
        <MobileStageView
          activeSetlist={activeSetlist} setlistItems={setlistItems} playbackItems={playbackItems}
          currentIndex={currentIndex} currentChildIndex={currentChildIndex}
          focusedIndex={focusedIndex} focusedSCItemId={focusedSCItemId} focusedNestedItemId={focusedNestedItemId}
          isPlaying={isPlaying} position={position} stageElapsed={stageElapsed} stageTotalTime={stageTotalTime}
          stageCollapsed={stageCollapsed} toggleStageCollapsed={toggleStageCollapsed} getLiveItem={getLiveItem}
          setFocusedIndex={setFocusedIndex} setFocusedSCItemId={setFocusedSCItemId} setFocusedNestedItemId={setFocusedNestedItemId}
          playItem={playItem} clickTrackIdx={clickTrackIdx} mainTrackIdx={mainTrackIdx} trackPeaks={trackPeaks}
          canControl={canControl}
          onPlayPause={handleTransportPlayPause} onStop={stopPlayback} onNext={playNext} onPrev={playPrev}
        />
      )}

      {/* ── Transport bar ── */}
      <footer className="transport-bar">
        <div className="t-left">
          {currentIndex >= 0 && activeSetlist ? (
            <div className="now-playing">
              <span className="np-dot" style={{ background: playbackItems[currentIndex]?.color, boxShadow: `0 0 7px ${playbackItems[currentIndex]?.color}` }} />
              <div>
                <div className="np-lbl">
                  NOW PLAYING
                  {playbackItems[currentIndex]?.isFolder && playbackItems[currentIndex]?.keycommand && (
                    <span className="np-pac-badge">PICK A COVER</span>
                  )}
                </div>
                <div className="np-name">{playbackItems[currentIndex]?.name}</div>
                {playbackItems[currentIndex]?.isFolder && playbackItems[currentIndex]?.keycommand && currentChildIndex >= 0 && (() => {
                  const activeChild = playbackItems[currentIndex].children?.[currentChildIndex];
                  if (!activeChild) return null;
                  const cr = getLiveItem(activeChild);
                  return <div className="np-pac-child">Playing: {currentChildIndex + 1} {cr.name}</div>;
                })()}
                {(() => {
                  const nextItem = currentIndex >= 0 ? playbackItems[currentIndex + 1] : null;
                  if (!nextItem) return null;
                  const nextParent = setlistItems.find(si => si.isContainer && (si.children||[]).some(c => c.id === nextItem.id));
                  return (
                    <div className="np-next">
                      <span className="np-next-lbl">NEXT</span>
                      {nextParent && <span className="np-next-container">{nextParent.name} ·</span>}
                      <span className="np-next-name">{nextItem.name}</span>
                    </div>
                  );
                })()}
              </div>
              <span className="np-idx">{currentIndex+1}/{playbackItems.length}</span>
            </div>
          ) : (
            <div className="np-ready">READY</div>
          )}
        </div>

        <div className="t-center">
          <button className="t-btn t-launch" onClick={launchShow}
            disabled={!canControl || !activeSetlist || playbackItems.length === 0}
            title={canControl ? "Launch Show — go to Stage view and play from top" : "This device is view-only"}>
            LAUNCH SHOW
          </button>
          <button className="t-btn" onClick={playPrev} disabled={!canControl || currentIndex <= 0} title="Prev">⏮</button>
          {(() => {
            const selIsPlaying = isPlaying && !focusedSCItemId && focusedIndex === currentIndex;
            return (
              <button className={`t-btn t-play${selIsPlaying ? " on" : ""}`}
                onClick={handleTransportPlayPause}
                disabled={!canControl || !activeSetlist || playbackItems.length === 0}
                title={canControl ? undefined : "This device is view-only"}>
                {selIsPlaying ? <span className="icon-pause"><span /><span /></span> : "▶ PLAY"}
              </button>
            );
          })()}
          <button className="t-btn t-stop" onClick={stopPlayback} disabled={!canControl || !isPlaying} title="Stop">■</button>
          <button className="t-btn" onClick={playNext} disabled={!canControl || currentIndex >= playbackItems.length-1} title="Next">⏭</button>
        </div>

        <div className="t-right">
          <span className="t-count">{playbackItems.length} ITEMS</span>
          {playbackItems.length > 0 && (
            <span className="t-total">{fmt(playbackItems.filter(i => !i.infiniteLoop).reduce((a,i) => a+getEffectiveDuration(i), 0))} TOTAL</span>
          )}
        </div>
      </footer>

      {/* ── Overlays ── */}
      {showFileMenu && (
        <FileMenu setlists={allSetlists} activeId={activeSetlistId}
          onNew={newSetlist} onLoad={loadSetlist}
          onRename={(id, name) => {
            const next = allSetlists.map(s => s.id === id ? {...s, name} : s);
            setAllSetlists(next); saveAllSetlistsToDisk(next);
          }}
          onDelete={deleteSetlist}
          onClose={() => setShowFileMenu(false)} />
      )}

      {showProject && activeSetlist && isAdmin && (
        <ProjectDrawer setlist={activeSetlist}
          onUpdateRpp={updateRpp}
          onClose={() => setShowProject(false)}
          tracks={tracks}
          clickTrackIdx={clickTrackIdx} mainTrackIdx={mainTrackIdx}
          onClickTrack={handleClickTrack} onMainTrack={handleMainTrack}
          autoAdvance={autoAdvance} onAutoAdvance={handleAutoAdvance}
          availableMidi={midiDevices}
          onUpdateMidiDevices={handleUpdateSetlistMidi} />
      )}

      {showConsole && (
        <ConsoleDrawer onClose={() => setShowConsole(false)}
          onHelp={() => { setShowConsole(false); fetchInstructions(); }}
          trackPeaks={trackPeaks} clickTrackIdx={clickTrackIdx}
          mainTrackIdx={mainTrackIdx} tracks={tracks} />
      )}

      {showDrawer && (
        <RegionsDrawer regions={regions} loading={loadingRegions}
          search={search} setSearch={setSearch}
          highlightedIdx={highlightedIdx} setHighlightedIdx={setHighlightIdx}
          onAdd={addToSetlist} onPlaySelected={playSelected}
          reaperConnected={reaperConnected}
          onClose={() => setShowDrawer(false)}
          listRef={regionListRef} onKeyDown={handleSearchKey} />
      )}

      {/* ── Project-switch prompt (REAPER opened a project with a matching setlist) ── */}
      {projectSwitchPrompt && (
        <div className="overlay" onClick={() => setProjectSwitchPrompt(null)}>
          <div className="new-sl-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span>PROJECT CHANGED</span>
              <button className="fm-close" onClick={() => setProjectSwitchPrompt(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="sd-hint">
                REAPER opened <strong>{projectSwitchPrompt.proj_name}</strong>, which is linked to the setlist{" "}
                <strong>{projectSwitchPrompt.matched_setlist_name}</strong>.
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-cancel" onClick={() => setProjectSwitchPrompt(null)}>STAY HERE</button>
              <button className="modal-confirm" onClick={() => {
                loadSetlist(projectSwitchPrompt.matched_setlist_id);
                setProjectSwitchPrompt(null);
              }}>SWITCH SETLIST</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Setlist Modal ── */}
      {showNewSetlist && newSetlistDraft && (
        <div className="overlay" onClick={() => setShowNewSetlist(false)}>
          <div className="new-sl-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span>NEW SETLIST</span>
              <button className="fm-close" onClick={() => setShowNewSetlist(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="modal-label">SETLIST NAME</label>
              <input
                autoFocus
                className="modal-input"
                maxLength={100}
                value={newSetlistDraft.name}
                onChange={e => setNewSetlistDraft(d => ({ ...d, name: e.target.value, error: "" }))}
                onKeyDown={e => e.key === "Enter" && confirmNewSetlist()}
                placeholder="e.g. Friday Night Show"
              />

              <label className="modal-label">REAPER PROJECT <span className="required">*required</span></label>
              <div className="modal-rpp-row">
                <input
                  className="modal-input rpp"
                  value={newSetlistDraft.rppPath}
                  onChange={e => setNewSetlistDraft(d => ({ ...d, rppPath: e.target.value, error: "" }))}
                  placeholder="C:\path\to\project.rpp"
                  spellCheck={false}
                />
              </div>
              <div className="modal-rpp-btns">
                <button className="modal-rpp-btn" onClick={useCurrentForNewSetlist}>⟳ USE CURRENT</button>
              </div>
              {newSetlistDraft.error && (
                <div className="modal-error">{newSetlistDraft.error}</div>
              )}
            </div>
            <div className="modal-footer">
              <button className="modal-cancel" onClick={() => setShowNewSetlist(false)}>CANCEL</button>
              <button className="modal-confirm" onClick={confirmNewSetlist}>CREATE SETLIST</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Device naming gate — blocks everything until this device has a name ── */}
      {!HAS_DEVICE_LABEL && <DeviceNameGate />}

      {/* ── Welcome / First-Run Modal ── */}
      {showWelcome && (
        <div className="overlay welcome-overlay">
          <div className="welcome-modal" onClick={e => e.stopPropagation()}>
            <div className="welcome-header">
              <span className="logo-gem">◈</span>
              <span className="welcome-title">WELCOME TO GENIUS SETLIST</span>
            </div>
            <div className="welcome-body">
              <p className="welcome-subtitle">Before you can use the app, complete these one-time setup steps:</p>
              <div className="welcome-steps">
                <div className="welcome-step">
                  <span className="welcome-num">1</span>
                  <div>Open the <strong>Console</strong> <span className="welcome-key">⌨</span> and click <span className="welcome-key">↺ REFRESH</span> to run diagnostics.</div>
                </div>
                <div className="welcome-step">
                  <span className="welcome-num">2</span>
                  <div>Click <span className="welcome-key">⬇ INSTALL BRIDGE SCRIPT</span> in the Console to copy <code>genius_bridge.lua</code> into your Reaper Scripts folder.</div>
                </div>
                <div className="welcome-step">
                  <span className="welcome-num">3</span>
                  <div>In Reaper: <code>Actions → Load ReaScript → genius_bridge.lua → Run</code></div>
                </div>
                <div className="welcome-step">
                  <span className="welcome-num">4</span>
                  <div><strong>Recommended:</strong> In Reaper: <code>Actions → Add to startup actions</code> so the bridge auto-starts with Reaper.</div>
                </div>
                <div className="welcome-step">
                  <span className="welcome-num">5</span>
                  <div>Click <span className="welcome-key">☰</span> → <span className="welcome-key">NEW SETLIST</span> to create your first setlist and link it to a <code>.rpp</code> project.</div>
                </div>
              </div>
              <p className="welcome-note">Regions must exist in your Reaper project — use <code>Insert → Region from time selection</code> to create them.</p>
            </div>
            <div className="welcome-footer">
              <button className="welcome-help-btn" onClick={() => { setShowWelcome(false); fetchInstructions(); }}>VIEW FULL INSTRUCTIONS</button>
              <button className="welcome-start-btn" onClick={() => setShowWelcome(false)}>GOT IT — LET'S GO</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Instructions Modal ── */}
      {showInstructions && (
        <div className="overlay" onClick={() => setShowInstructions(false)}>
          <div className="instructions-modal" onClick={e => e.stopPropagation()}>
            <div className="drawer-hdr">
              <span>SETUP GUIDE</span>
              <button className="fm-close" onClick={() => setShowInstructions(false)}>✕</button>
            </div>
            <pre className="instructions-body">{instructionsText}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
