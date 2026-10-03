/**
 * Worker thread for one infobase (TD §4: one worker per infobase, so a slow 1C call never freezes
 * the UI). winax calls are synchronous and would otherwise block the main process.
 *
 * The connection stays open between calls and is closed after 5 idle minutes: each open
 * connection uses a 1C license.
 */
import { parentPort, workerData } from "node:worker_threads";

import { type PlatformTransport } from "@platform/onec-client";
import { ComTransport } from "@platform/onec-client/com";
import { FakePlatform } from "@platform/onec-client/testing";

import type { ConnectionInput } from "../shared/ipc.js";
import { checkConnection, failure, toLocation } from "./onec-jobs.js";

const IDLE_MS = 5 * 60 * 1000;
const demo = Boolean((workerData as { demo?: boolean } | undefined)?.demo);

let transport: PlatformTransport | null = null;
let credentials = "";
let idleTimer: NodeJS.Timeout | undefined;

async function closeConnection() {
  const current = transport;
  transport = null;
  if (current) await current.close().catch(() => undefined);
}

function open(connection: ConnectionInput): PlatformTransport {
  const key = JSON.stringify([connection.user, connection.password]);
  if (transport && key === credentials) return transport;
  void closeConnection();
  transport = demo
    ? new FakePlatform()
    : ComTransport.connect({
        infobase: toLocation(connection.infobase),
        user: connection.user,
        password: connection.password,
      });
  credentials = key;
  return transport;
}

parentPort?.on("message", async (message: { id: number; connection: ConnectionInput }) => {
  clearTimeout(idleTimer);
  let result;
  try {
    result = await checkConnection(open(message.connection));
  } catch (e) {
    await closeConnection(); // reconnect from scratch next time
    result = failure(e);
  }
  idleTimer = setTimeout(() => void closeConnection(), IDLE_MS);
  parentPort?.postMessage({ id: message.id, result });
});
