# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Genius SetList Mobile companion (tray app).
# Run: pyinstaller companion.spec
#
# Diverges from the old desktop app's spec (reaper-setlist-exe/backend/
# genius_setlist.spec) in a few ways: no pywebview/winforms/.NET (this is a
# tray app, not a windowed one), no cryptography (Tailscale/HTTPS dropped in
# favor of plain LAN + a pairing token), no email — but it DOES need tkinter
# (excluded there, required here for the status window) plus pystray/PIL/
# qrcode/pywin32 for the tray icon, QR rendering, and the autostart shortcut.

import os
from PyInstaller.utils.hooks import collect_data_files

datas = []
binaries = []
hiddenimports = []

datas += collect_data_files('uvicorn')
datas += collect_data_files('fastapi')

# Built React frontend (run `npm run build` in ../frontend first, then copy
# frontend/build here as static/ — see the project's build-order notes).
datas += [('static', 'static')]

# Bundle the bridge script inside the exe so it can be auto-installed to any
# machine's REAPER Scripts folder regardless of dev/frozen state.
datas += [('genius_bridge.lua', '.')]

hiddenimports += [
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.http.httptools_impl',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.websockets_impl',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'uvicorn.lifespan.off',
    'fastapi',
    'fastapi.staticfiles',
    'fastapi.responses',
    'starlette',
    'starlette.staticfiles',
    'starlette.responses',
    'starlette.middleware',
    'starlette.middleware.cors',
    'anyio',
    'anyio._backends._asyncio',
    'h11',
    'websockets',
    'pystray',
    'pystray._win32',
    'PIL',
    'PIL.Image',
    'PIL.ImageDraw',
    'PIL.ImageTk',
    'qrcode',
    'win32com.client',
]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'numpy', 'pandas'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='GeniusSetListMobile',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # No console — tray-only app
    uac_admin=False,  # No elevation needed (Startup-folder shortcut, not a scheduled task)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='icon.ico',
)
