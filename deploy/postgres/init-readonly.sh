#!/bin/sh
# Runs once, when the database volume is created. Migration 0002 grants this role SELECT on
# the mirror tables only (never users, agents, fixes or event_log).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE app_ro LOGIN PASSWORD '${POSTGRES_RO_PASSWORD}';
ALTER ROLE app_ro SET default_transaction_read_only = on;
ALTER ROLE app_ro SET statement_timeout = '10s';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO app_ro;
SQL
