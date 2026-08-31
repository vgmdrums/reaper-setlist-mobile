"""
System tray shell for the Genius SetList Mobile companion.

Runs the pystray icon on a background thread; a persistent hidden Tk root
runs on the main thread so the on-demand status window (REAPER connection
status, connected phones, pairing QR code) can be created safely via
root.after() regardless of which thread the tray menu click came from.
"""
import io
import json
import os
import sys
import threading
import tkinter as tk
import webbrowser
from tkinter import messagebox

import pystray
from PIL import Image, ImageDraw, ImageTk


def _bundled(filename):
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, filename)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)


# Tk's classic widgets don't follow the OS dark-mode setting on their own —
# left alone, labels sit on the platform's default (usually light) widget
# background, so light-colored text (or anything close to it) can become
# unreadable. Everything in the status window gets these colors explicitly.
BG = "#0e0e10"
BG2 = "#18181c"
FG = "#e8e8ec"
FG_DIM = "#9a9aa2"
ACCENT = "#f0c040"


def _load_icon() -> Image.Image:
    path = _bundled("icon.ico")
    if os.path.exists(path):
        try:
            return Image.open(path)
        except OSError:
            pass
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, 60, 60), fill=(74, 158, 255, 255))
    return img


class TrayApp:
    def __init__(self, get_status_fn, get_clients_fn, get_pairing_fn, get_local_url_fn, get_update_fn, get_phrase_fn, set_phrase_fn,
                 set_admin_fn, set_transport_control_fn, remove_device_fn, on_quit):
        """
        get_status_fn()  -> {"reaper_connected": bool, "current_project": str|None}
        get_clients_fn() -> [{"label", "device_id", "is_admin", "can_control", "online", "last_seen"}, ...]
        get_pairing_fn() -> {"ok": bool, "payload": {host,port,token}|None, "error": str|None}
        get_local_url_fn() -> str (Plan B — opens the app on this PC via localhost)
        get_update_fn()  -> {"current_version": str, "update": {"version","url"}|None}
        get_phrase_fn()  -> str (current pairing phrase)
        set_phrase_fn(phrase: str) -> str (normalized phrase actually saved)
        set_admin_fn(device_id: str, is_admin: bool) -- grants/revokes Edit-mode access for this device
        set_transport_control_fn(device_id: str, can_control: bool) -- grants/revokes play/stop/etc.
        remove_device_fn(device_id: str) -- forgets a device (drops it from the list, revokes admin)
        on_quit()        -- called once, after the tray icon and Tk loop have stopped
        """
        self.get_status = get_status_fn
        self.get_clients = get_clients_fn
        self.get_pairing = get_pairing_fn
        self.get_local_url = get_local_url_fn
        self.get_update = get_update_fn
        self.get_phrase = get_phrase_fn
        self.set_phrase = set_phrase_fn
        self.set_admin = set_admin_fn
        self.set_transport_control = set_transport_control_fn
        self.remove_device = remove_device_fn
        self.on_quit = on_quit
        self._phrase_entry = None
        self._phrase_status_label = None

        self.root = tk.Tk()
        self.root.withdraw()
        # Without this, Windows represents this process (Task Manager, Alt-Tab,
        # any taskbar entry) with the generic Python icon — Tk's own icon is
        # separate from the notification-area icon pystray sets below.
        # default=True applies it to every future Toplevel too (the status
        # window), not just the hidden root.
        icon_path = _bundled("icon.ico")
        if os.path.exists(icon_path):
            try:
                self.root.iconbitmap(default=icon_path)
            except tk.TclError:
                pass
        self._status_win = None
        self._qr_photo = None  # keep a reference so Tk doesn't garbage-collect it
        self._last_clients_key = None
        self._auto_refresh_running = False

        show_status_item = pystray.MenuItem("Show status && pairing QR", self._show_status, default=True)
        self.icon = pystray.Icon(
            "genius_setlist_mobile",
            _load_icon(),
            "Genius SetList Mobile",
            menu=pystray.Menu(
                show_status_item,
                pystray.MenuItem("Quit", self._quit),
            ),
        )

    def _show_status(self, icon=None, item=None):
        self.root.after(0, self._build_status_window)

    def _build_status_window(self):
        if self._status_win is not None and self._status_win.winfo_exists():
            self._status_win.deiconify()
            self._status_win.lift()
            self._refresh_status_window()
            self._start_auto_refresh()
            return

        win = tk.Toplevel(self.root)
        win.title("Genius SetList Mobile")
        win.configure(bg=BG)
        # Resizable rather than a fixed size or an internal scrollbar — the
        # scrollbar approach turned out buggy (reported: scroll region way
        # taller than the actual content). A window that sizes itself to its
        # content and lets the OS handle resizing is simpler and avoids that
        # whole class of bug; _refresh_status_window sizes it after building.
        win.resizable(True, True)
        win.protocol("WM_DELETE_WINDOW", win.withdraw)
        self._status_win = win
        self._status_content = win

        self._refresh_status_window()
        self._start_auto_refresh()

    def _refresh_status_window(self):
        win = self._status_content
        for child in win.winfo_children():
            child.destroy()

        status = self.get_status()
        clients = self.get_clients()
        pairing = self.get_pairing()
        update = self.get_update()
        self._last_clients_key = self._clients_key(clients)

        # Update banner sits above everything else — it's the one thing here
        # that means "go do something outside this window," so it shouldn't
        # get buried below the device list.
        pending = update.get("update")
        if pending:
            banner = tk.Frame(win, bg="#2a2410", highlightbackground=ACCENT, highlightthickness=1)
            banner.pack(fill="x", padx=14, pady=(14, 0))
            tk.Label(banner, text=f"Update available — {pending['version']}", bg="#2a2410", fg=ACCENT,
                     font=("Segoe UI", 10, "bold")).pack(pady=(8, 0), padx=10, anchor="w")
            tk.Label(banner, text=f"You're on {update.get('current_version', '?')}", bg="#2a2410", fg=FG_DIM,
                     font=("Segoe UI", 8)).pack(padx=10, anchor="w")
            tk.Button(banner, text="View Release", command=lambda u=pending["url"]: webbrowser.open(u),
                      bg=BG2, fg=ACCENT, activebackground=BG2, activeforeground=ACCENT,
                      relief="flat", font=("Segoe UI", 9, "bold")).pack(pady=8, padx=10, fill="x")

        tk.Label(win, text="REAPER bridge", font=("Segoe UI", 11, "bold"), bg=BG, fg=FG).pack(pady=(14, 2))
        connected = status.get("reaper_connected")
        tk.Label(win, text="Connected" if connected else "Not connected", bg=BG,
                 fg="#3ecf6e" if connected else "#ff6b6b").pack()
        if connected and status.get("current_project"):
            tk.Label(win, text=status["current_project"], font=("Segoe UI", 8), bg=BG, fg=FG_DIM).pack()

        # Fallback for when the phone can't reach the companion (Wi-Fi
        # trouble, phone died, whatever): opens the exact same control
        # surface right here on the PC via localhost — no network involved.
        tk.Button(win, text="⚠ Launch Local App", command=self._open_local,
                  bg=BG2, fg=ACCENT, activebackground=BG2, activeforeground=ACCENT,
                  relief="flat", font=("Segoe UI", 9, "bold")).pack(pady=(10, 2), padx=20, fill="x")
        tk.Label(win, text="Use this if your phone loses connection mid-show",
                 font=("Segoe UI", 8), bg=BG, fg=FG_DIM).pack()

        tk.Label(win, text="Devices", font=("Segoe UI", 11, "bold"), bg=BG, fg=FG).pack(pady=(14, 2))
        tk.Label(win, text="Admin edits setlists. Performer controls playback in Stage view but\n"
                            "can't edit. View Only can just watch. Every device that's ever\n"
                            "connected is listed here, online or not, so you can set a role even\n"
                            "for one that's offline right now.",
                 font=("Segoe UI", 8), bg=BG, fg=FG_DIM, justify="left").pack()

        if clients:
            for c in clients:
                block = tk.Frame(win, bg=BG)
                block.pack(fill="x", padx=20, pady=(8, 0))

                name_row = tk.Frame(block, bg=BG)
                name_row.pack(fill="x")
                label = c.get("label") or "Unnamed device"
                is_admin = c.get("is_admin", False)
                can_control = c.get("can_control", True)
                online = c.get("online", False)
                device_id = c.get("device_id", "")
                role = "admin" if is_admin else ("performer" if can_control else "view_only")

                remove_btn = tk.Label(name_row, text="✕", font=("Segoe UI", 10), bg=BG, fg=FG_DIM, cursor="hand2")
                remove_btn.bind("<Button-1>", lambda e, d=device_id, lb=label: self._remove_device(d, lb))
                remove_btn.pack(side="right", padx=(6, 0))
                tk.Label(name_row, text=("● " if online else "○ "), bg=BG,
                         fg="#3ecf6e" if online else FG_DIM).pack(side="left")
                tk.Label(name_row, text=label, bg=BG, fg=ACCENT if is_admin else (FG if online else FG_DIM),
                         font=("Segoe UI", 10, "bold" if is_admin else "normal")).pack(side="left")

                role_row = tk.Frame(block, bg=BG)
                role_row.pack(fill="x", pady=(2, 4), padx=(16, 0))
                for role_key, role_text, role_color in (
                    ("admin", "Admin", ACCENT),
                    ("performer", "Performer", "#4a9eff"),
                    ("view_only", "View Only", FG_DIM),
                ):
                    self._make_role_pill(role_row, role_text, role_color, selected=(role == role_key),
                                          on_click=lambda d=device_id, r=role_key: self._set_role(d, r)
                                          ).pack(side="left", padx=(0, 6))
        else:
            tk.Label(win, text="(none yet)", bg=BG, fg=FG_DIM).pack()

        # Phrase goes first and has no dependency on the QR/network code path
        # below — it's just a locally-stored string, always available, so it
        # renders even if QR generation (network lookup + the qrcode lib)
        # fails for some reason. That ordering is deliberate: an exception in
        # _render_qr used to silently abort everything after it, including
        # this section and the buttons at the bottom.
        tk.Label(win, text="Or type this phrase in the app", font=("Segoe UI", 11, "bold"), bg=BG, fg=FG).pack(pady=(14, 2))
        tk.Label(win, text="Both devices must be on the same Wi-Fi", font=("Segoe UI", 8), bg=BG, fg=FG_DIM).pack()
        phrase_row = tk.Frame(win, bg=BG)
        phrase_row.pack(pady=(6, 0))
        self._phrase_entry = tk.Entry(phrase_row, font=("Consolas", 12), justify="center", width=18,
                                       bg=BG2, fg=FG, insertbackground=FG, relief="flat")
        self._phrase_entry.insert(0, self.get_phrase())
        self._phrase_entry.pack(side="left", padx=(0, 6), ipady=3)
        tk.Button(phrase_row, text="Save", command=self._save_phrase,
                  bg=BG2, fg=FG, activebackground=BG2, activeforeground=FG, relief="flat").pack(side="left")
        self._phrase_status_label = tk.Label(win, text="", font=("Segoe UI", 8), bg=BG, fg=FG)
        self._phrase_status_label.pack()

        tk.Label(win, text="Or scan this QR code", font=("Segoe UI", 11, "bold"), bg=BG, fg=FG).pack(pady=(14, 2))
        if pairing["ok"]:
            try:
                self._render_qr(win, pairing["payload"])
            except Exception as e:
                tk.Label(win, text=f"QR code unavailable: {e}", wraplength=300, bg=BG, fg="#ff6b6b",
                         justify="left").pack(padx=16)
        else:
            tk.Label(win, text=pairing["error"], wraplength=300, bg=BG, fg="#ff6b6b", justify="left").pack(padx=16)

        btns = tk.Frame(win, bg=BG)
        btns.pack(pady=14)
        tk.Button(btns, text="Refresh", command=self._refresh_status_window,
                  bg=BG2, fg=FG, activebackground=BG2, activeforeground=FG, relief="flat").pack(side="left", padx=6)
        tk.Button(btns, text="Close", command=self._status_win.withdraw,
                  bg=BG2, fg=FG, activebackground=BG2, activeforeground=FG, relief="flat").pack(side="left", padx=6)

        # Size the window to fit what was actually built, capped to the
        # screen so a long device list still fits on-screen without needing
        # the scrollbar approach that caused the oversized-scroll bug.
        win.update_idletasks()
        target_h = min(win.winfo_reqheight(), win.winfo_screenheight() - 80)
        target_w = max(420, win.winfo_reqwidth())
        win.geometry(f"{target_w}x{target_h}")

    @staticmethod
    def _clients_key(clients):
        """Cheap fingerprint of the device list so the auto-refresh timer can
        tell whether anything actually changed (new device, role change,
        online/offline flip) without diffing widgets."""
        return tuple(sorted(
            (c.get("device_id", ""), c.get("label", ""), c.get("is_admin", False),
             c.get("can_control", True), c.get("online", False))
            for c in clients
        ))

    def _start_auto_refresh(self):
        if self._auto_refresh_running:
            return
        self._auto_refresh_running = True
        self._auto_refresh_tick()

    def _auto_refresh_tick(self):
        win = self._status_win
        if win is not None and win.winfo_exists() and win.state() != "withdrawn":
            if self._clients_key(self.get_clients()) != self._last_clients_key:
                self._refresh_status_window()
            self.root.after(2000, self._auto_refresh_tick)
        else:
            # Window closed/hidden: stop polling. _start_auto_refresh restarts
            # this loop the next time the status window is shown.
            self._auto_refresh_running = False

    def _make_role_pill(self, parent, text, color, selected, on_click):
        """One of three mutually-exclusive role buttons drawn by hand (Tk has
        no built-in segmented-control widget). The selected pill is filled
        with its role color; the others sit dim and outlined."""
        if selected:
            lbl = tk.Label(parent, text=f" {text} ", font=("Segoe UI", 9, "bold"),
                            bg=color, fg=BG, cursor="hand2")
        else:
            lbl = tk.Label(parent, text=f" {text} ", font=("Segoe UI", 9), bg=BG2, fg=FG_DIM,
                            cursor="hand2", highlightthickness=1, highlightbackground=BG2,
                            highlightcolor=BG2)
        lbl.bind("<Button-1>", lambda e: on_click())
        return lbl

    def _set_role(self, device_id, role):
        """admin: full access. performer: playback control, no editing.
        view_only: neither. Two backend flags under the hood (is_admin,
        can_control) but presented here as one exclusive choice."""
        self.set_admin(device_id, role == "admin")
        self.set_transport_control(device_id, role in ("admin", "performer"))
        self._refresh_status_window()

    def _open_local(self):
        webbrowser.open(self.get_local_url())

    def _remove_device(self, device_id, label):
        # A native confirm dialog — this is the one destructive action in
        # this window, so it's worth a beat of friction. If the device
        # reconnects later it just gets recorded fresh again.
        if messagebox.askyesno("Remove device", f'Remove "{label}" from the device list?',
                                parent=self._status_win):
            self.remove_device(device_id)
            self._refresh_status_window()

    def _save_phrase(self):
        entered = self._phrase_entry.get()
        saved = self.set_phrase(entered)
        self._phrase_entry.delete(0, tk.END)
        self._phrase_entry.insert(0, saved)
        if self._phrase_status_label is not None:
            self._phrase_status_label.config(text="Saved", fg="#3ecf6e")
            self._phrase_status_label.after(1500, lambda: self._phrase_status_label.config(text=""))

    def _render_qr(self, win, payload):
        import qrcode
        buf = io.BytesIO()
        qrcode.make(json.dumps(payload)).save(buf, format="PNG")
        buf.seek(0)
        img = Image.open(buf).resize((200, 200))
        self._qr_photo = ImageTk.PhotoImage(img)
        tk.Label(win, image=self._qr_photo, bg=BG).pack(pady=4)
        tk.Label(win, text=f"{payload['host']}:{payload['port']}", font=("Consolas", 9), bg=BG, fg=FG_DIM).pack()

    def _quit(self, icon=None, item=None):
        self.icon.stop()
        self.root.after(0, self.root.quit)

    def run(self):
        """Blocking — call from the main thread."""
        threading.Thread(target=self.icon.run, daemon=True).start()
        self.root.mainloop()
        self.on_quit()
