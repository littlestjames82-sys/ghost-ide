# PyInstaller spec for the GhostIDE desktop app (G18).
# Build from the repo root:
#   pyinstaller packaging/ghostide.spec
# Produces dist/GhostIDE/ (one-folder build): the GhostIDE
# executable plus _internal/ with server.py's data files.
# The build scripts then place a llama/ folder beside the
# executable (server.py looks for ROOT/llama and
# ROOT.parent/llama) and add the installer.
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

a = Analysis(
    [os.path.join(ROOT, "server.py")],
    pathex=[ROOT],
    binaries=[],
    datas=[
        (os.path.join(ROOT, "web"), "web"),
        (os.path.join(ROOT, "debug_bridge.py"), "."),
        (os.path.join(ROOT, "playground"), "playground"),
        (os.path.join(ROOT, "VERSION.json"), "."),
    ],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="GhostIDE",
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="GhostIDE",
)
