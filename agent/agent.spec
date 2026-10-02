# PyInstaller spec: builds dist/OneCAgent.exe (Windows service + CLI in one file).
#   py -3.12 -m pip install -r requirements-dev.txt
#   py -3.12 -m PyInstaller agent.spec
# -*- mode: python ; coding: utf-8 -*-

a = Analysis(
    ["onec_agent/service.py"],
    pathex=["."],
    hiddenimports=["win32timezone", "onec_agent.main", "onec_agent.connection", "onec_agent.extension", "onec_agent.config"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="OneCAgent",
    console=True,
    upx=False,
)
