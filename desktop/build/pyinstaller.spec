# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for bundling the CC-GUI Python backend as a standalone executable.

Usage: pyinstaller build/pyinstaller.spec --distpath src-tauri/binaries/server --clean --noconfirm
"""
import sys
from pathlib import Path

# SPECPATH is the directory containing this .spec file
ROOT = Path(SPECPATH).resolve().parent.parent  # cc-gui repo root

server_py = ROOT / "server.py"

# Collect all Python modules
binaries = []
datas = [
    (str(ROOT / "static"), "static"),
]
hiddenimports = [
    'asyncio',
    'json',
    're',
    'os',
    'sys',
    'io',
    'pathlib',
    'shutil',
    'subprocess',
    'urllib',
    'email',
    'html',
    'http',
    'logging',
    'mimetypes',
    'uuid',
]

a = Analysis(
    [str(server_py)],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'unittest',
        'test',
        'pydoc',
        'distutils',
        'setuptools',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # Hidden in desktop mode; --sidecar port reported via stdout pipe still works
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
