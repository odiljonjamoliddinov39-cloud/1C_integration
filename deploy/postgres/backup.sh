#!/bin/sh
# Daily pg_dump at 01:30 server time, keep KEEP_DAYS days. 1C bases keep their own backups.
set -e
mkdir -p /backups
while true; do
  now=$(date +%H%M)
  if [ "$now" = "0130" ]; then
    file="/backups/app-$(date +%Y%m%d).dump"
    pg_dump --format=custom --file="$file.tmp" && mv "$file.tmp" "$file"
    echo "backup written: $file"
    find /backups -name 'app-*.dump' -mtime +"${KEEP_DAYS:-14}" -delete
    sleep 61
  fi
  sleep 30
done
