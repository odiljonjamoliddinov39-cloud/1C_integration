"""Windows service wrapper (pywin32).

    OneCAgent.exe install      # registers the service (auto start)
    OneCAgent.exe start | stop | remove
    OneCAgent.exe debug        # run in the console with service plumbing
    OneCAgent.exe check        # ping every configured base's extension
    OneCAgent.exe run          # run in the foreground without the service

Built with PyInstaller from agent.spec; installer/install.ps1 does all of it in one step.
"""

from __future__ import annotations

import asyncio
import sys
import threading

import servicemanager  # type: ignore[import-not-found]
import win32event  # type: ignore[import-not-found]
import win32service  # type: ignore[import-not-found]
import win32serviceutil  # type: ignore[import-not-found]

from onec_agent.main import build


class OneCAgentService(win32serviceutil.ServiceFramework):
    _svc_name_ = "OneCAgent"
    _svc_display_name_ = "1C Integration Agent"
    _svc_description_ = "Connects the local 1C bases to the 1C Integration web app (outbound WebSocket only)."

    def __init__(self, args):
        super().__init__(args)
        self.stop_handle = win32event.CreateEvent(None, 0, 0, None)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.agent = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        if self.loop and self.agent:
            self.loop.call_soon_threadsafe(self.agent.stop)
        win32event.SetEvent(self.stop_handle)

    def SvcDoRun(self):
        servicemanager.LogMsg(servicemanager.EVENTLOG_INFORMATION_TYPE, servicemanager.PYS_SERVICE_STARTED, (self._svc_name_, ""))
        self.agent = build()
        self.loop = asyncio.new_event_loop()
        worker = threading.Thread(target=self._run, daemon=True)
        worker.start()
        win32event.WaitForSingleObject(self.stop_handle, win32event.INFINITE)
        worker.join(timeout=15)

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.agent.run_forever())


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in ("check", "run"):
        from onec_agent.main import main as cli

        sys.exit(cli(sys.argv[1:]))
    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(OneCAgentService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(OneCAgentService)


if __name__ == "__main__":
    main()
