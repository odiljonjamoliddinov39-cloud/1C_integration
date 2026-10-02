"""Tiny scheduler process: incremental sync every N minutes, full audit nightly at 02:00.

Runs as its own container (`python -m app.scheduler`); jobs go to the RQ queue.
"""

import logging
import time
from datetime import datetime

from app.config import get_settings
from app.jobs import all_company_ids, enqueue, nightly, sync_company

log = logging.getLogger("scheduler")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    settings = get_settings()
    interval = settings.incremental_sync_minutes * 60
    last_sync = 0.0
    last_nightly_day = None
    while True:
        now = time.time()
        if now - last_sync >= interval:
            for cid in all_company_ids():
                enqueue(sync_company, cid)
            last_sync = now
        local = datetime.now()
        if local.hour == settings.nightly_audit_hour and last_nightly_day != local.date():
            log.info("nightly audit")
            nightly()
            last_nightly_day = local.date()
        time.sleep(20)


if __name__ == "__main__":
    main()
