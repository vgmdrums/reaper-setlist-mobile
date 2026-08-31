# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Genius SetList Mobile INSTALLER — a small wrapper
# that carries the real app (dist/GeniusSetListMobile.exe) as bundled data,
# copies it to %LOCALAPPDATA%\GeniusSetListMobile\, adds a Start Menu
# shortcut, and launches it. Build the app first (companion.spec), then this.
# Run: pyinstaller install.spec

a = Analysis(
    ['install.py'],
    pathex=[],
    binaries=[],
    datas=[('dist/GeniusSetListMobile.exe', '.')],
    hiddenimports=['win32com.client'],
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
    name='GeniusSetListMobile-Setup',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    uac_admin=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='icon.ico',
)
