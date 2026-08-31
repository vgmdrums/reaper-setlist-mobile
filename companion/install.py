"""
Genius SetList Mobile — one-click installer.

Copies the bundled app to %LOCALAPPDATA%\\GeniusSetListMobile\\, adds a Start
Menu shortcut, and launches it. The app creates its own Startup-folder
shortcut on first run (see ensure_autostart() in main.py) so it comes back
automatically at every login after that — the installer doesn't duplicate
that logic, just gets the app running from a permanent location once.
"""
import os
import sys
import shutil
import subprocess
import tkinter as tk
from tkinter import messagebox

APP_EXE = "GeniusSetListMobile.exe"


def _bundled(filename):
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, filename)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)


def _create_start_menu_shortcut(target: str, workdir: str):
    try:
        import win32com.client
        start_menu = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs")
        shortcut_path = os.path.join(start_menu, "Genius SetList Mobile.lnk")
        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(shortcut_path)
        shortcut.TargetPath = target
        shortcut.WorkingDirectory = workdir
        shortcut.IconLocation = target
        shortcut.Save()
    except Exception as e:
        print(f"Warning: could not create Start Menu shortcut: {e}")


def install():
    install_dir = os.path.join(os.environ["LOCALAPPDATA"], "GeniusSetListMobile")
    os.makedirs(install_dir, exist_ok=True)

    src = _bundled(APP_EXE)
    dest = os.path.join(install_dir, APP_EXE)

    # If the app is currently running from a previous install, stop it first
    # so the copy isn't blocked by a locked file.
    try:
        subprocess.run(["taskkill", "/IM", APP_EXE, "/F"], capture_output=True, timeout=5)
    except Exception:
        pass

    shutil.copy2(src, dest)
    _create_start_menu_shortcut(dest, install_dir)
    subprocess.Popen([dest], cwd=install_dir)

    root = tk.Tk()
    root.withdraw()
    messagebox.showinfo(
        "Genius SetList Mobile",
        "Installed and running.\n\n"
        "It lives in the system tray (bottom-right of the taskbar — check "
        "the ^ overflow arrow if you don't see it right away). Right-click "
        "the icon to pair a phone or check status.\n\n"
        "It will also start automatically the next time you log in.",
    )


if __name__ == "__main__":
    try:
        install()
    except Exception as e:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("Genius SetList Mobile — Install failed", str(e))
        sys.exit(1)
