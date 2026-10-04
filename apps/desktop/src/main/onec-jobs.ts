/**
 * What the app asks of 1C: the connection check (Ping, GetOrganizations) and the assistant's
 * read-only tools. Runs inside a worker thread (onec-worker.ts) in the app, and in-process in
 * tests. Never throws: failures become a status or a failed ToolResult.
 */
import {
  type InfobaseLocation,
  OneCError,
  PlatformApiClient,
  type PlatformTransport,
} from "@platform/onec-client";

import { AI_TOOLS, type AiToolName } from "@platform/shared";

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

export type ToolResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };

/** A job for the worker of one infobase. */
export type OneCJob = { kind: "check" } | { kind: "tool"; name: AiToolName; input: unknown };

/** Runs one assistant tool. The input was validated by the caller; it is parsed again here. */
export async function runTool(
  transport: PlatformTransport,
  name: AiToolName,
  input: unknown,
): Promise<ToolResult> {
  const client = new PlatformApiClient(transport);
  try {
    switch (name) {
      case "list_organizations":
        return { ok: true, data: await client.getOrganizations() };
      case "describe_objects":
        return { ok: true, data: await client.getMetadata(AI_TOOLS.describe_objects.parse(input).objects) };
      case "run_query":
        return { ok: true, data: await client.runQuery(AI_TOOLS.run_query.parse(input)) };
    }
  } catch (e) {
    return toolFailure(e);
  }
}

export function toolFailure(e: unknown): ToolResult {
  if (e instanceof OneCError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}

export function runJob(
  transport: PlatformTransport,
  job: OneCJob,
): Promise<ConnectionTestResult | ToolResult> {
  return job.kind === "check" ? checkConnection(transport) : runTool(transport, job.name, job.input);
}
