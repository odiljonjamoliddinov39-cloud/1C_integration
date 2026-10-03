/**
 * What the app asks of 1C in phase 0: connect, Ping, GetOrganizations. Runs inside a worker thread
 * (onec-worker.ts) in the app, and in-process in tests. Never throws: failures become a status.
 */
import {
  type InfobaseLocation,
  OneCError,
  PlatformApiClient,
  type PlatformTransport,
} from "@platform/onec-client";

import type { ConnectionInput, ConnectionTestResult, InfobaseInput } from "../shared/ipc.js";

export type TransportFactory = (connection: ConnectionInput) => PlatformTransport;

export function toLocation(infobase: InfobaseInput): InfobaseLocation {
  return infobase.kind === "file" ? { file: infobase.file } : { server: infobase.server, ref: infobase.ref };
}

/** One worker (and one 1C connection) per infobase. */
export function infobaseKey(infobase: InfobaseInput): string {
  return infobase.kind === "file"
    ? `file:${infobase.file.trim().toLowerCase()}`
    : `srv:${infobase.server}/${infobase.ref}`.toLowerCase();
}

export function failure(e: unknown): ConnectionTestResult {
  const checkedAt = new Date().toISOString();
  if (e instanceof OneCError)
    return { status: { ok: false, checkedAt, code: e.code, message: e.message }, organizations: [] };
  return {
    status: { ok: false, checkedAt, code: "INTERNAL", message: e instanceof Error ? e.message : String(e) },
    organizations: [],
  };
}

export async function checkConnection(transport: PlatformTransport): Promise<ConnectionTestResult> {
  const client = new PlatformApiClient(transport);
  const ping = await client.ping();
  const organizations = await client.getOrganizations();
  return { status: { ok: true, checkedAt: new Date().toISOString(), ping }, organizations };
}
