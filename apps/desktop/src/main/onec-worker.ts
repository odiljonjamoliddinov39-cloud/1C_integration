/**
 * Worker thread for one infobase (TD §4: one worker per infobase, so a slow 1C call never freezes
 * the UI). winax calls are synchronous and would otherwise block the main process.
 *
 * The connection stays open between calls and is closed after 5 idle minutes: each open
 * connection uses a 1C license. Jobs run one at a time, so one job never closes the connection
 * another is still using.
 */
import { parentPort, workerData } from "node:worker_threads";

import { type PlatformTransport } from "@platform/onec-client";
import { ComTransport } from "@platform/onec-client/com";
import { FakePlatform } from "@platform/onec-client/testing";

import type { ConnectionInput } from "../shared/ipc.js";
import { type OneCJob, failure, runJob, toLocation, toolFailure } from "./onec-jobs.js";

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

async function open(connection: ConnectionInput): Promise<PlatformTransport> {
  const key = JSON.stringify([connection.user, connection.password]);
  if (transport && key === credentials) return transport;
  await closeConnection();
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

interface JobMessage {
  id: number;
  connection: ConnectionInput;
  job: OneCJob;
}

async function run(message: JobMessage) {
  clearTimeout(idleTimer);
  // A connection check always starts fresh: the user may have just changed the base in the
  // Configurator, and an open connection keeps seeing the old configuration.
  if (message.job.kind === "check") await closeConnection();
  let result;
  try {
    result = await runJob(await open(message.connection), message.job);
  } catch (e) {
    await closeConnection(); // reconnect from scratch next time
    result = message.job.kind === "check" ? failure(e) : toolFailure(e);
  }
  idleTimer = setTimeout(() => void closeConnection(), IDLE_MS);
  parentPort?.postMessage({ id: message.id, result });
}

let queue = Promise.resolve();
parentPort?.on("message", (message: JobMessage) => {
  queue = queue.then(() => run(message));
});
