import { Worker } from "node:worker_threads";

import type { ConnectionInput, ConnectionTestResult } from "../shared/ipc.js";
import { checkConnection, failure, infobaseKey, type TransportFactory } from "./onec-jobs.js";

export interface ConnectorRunner {
  check(connection: ConnectionInput): Promise<ConnectionTestResult>;
  dispose(): Promise<void>;
}

/** Production: one worker thread per infobase. */
export class WorkerConnector implements ConnectorRunner {
  private readonly workers = new Map<
    string,
    { worker: Worker; pending: Map<number, (r: ConnectionTestResult) => void> }
  >();
  private nextId = 1;

  constructor(
    private readonly workerPath: string,
    private readonly demo: boolean,
  ) {}

  check(connection: ConnectionInput): Promise<ConnectionTestResult> {
    const entry = this.worker(infobaseKey(connection.infobase));
    const id = this.nextId++;
    return new Promise((resolve) => {
      entry.pending.set(id, resolve);
      entry.worker.postMessage({ id, connection });
    });
  }

  private worker(key: string) {
    let entry = this.workers.get(key);
    if (entry) return entry;
    const worker = new Worker(this.workerPath, { workerData: { demo: this.demo } });
    const created = { worker, pending: new Map<number, (r: ConnectionTestResult) => void>() };
    worker.on("message", (message: { id: number; result: ConnectionTestResult }) => {
      created.pending.get(message.id)?.(message.result);
      created.pending.delete(message.id);
    });
    const fail = (error: unknown) => {
      for (const resolve of created.pending.values()) resolve(failure(error));
      created.pending.clear();
      this.workers.delete(key);
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`1C worker stopped (exit code ${code})`)));
    this.workers.set(key, created);
    entry = created;
    return entry;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.workers.values()].map((e) => e.worker.terminate()));
    this.workers.clear();
  }
}

/** Tests and tools: runs the same check in-process with any transport. */
export class InProcessConnector implements ConnectorRunner {
  constructor(private readonly transportFor: TransportFactory) {}

  async check(connection: ConnectionInput): Promise<ConnectionTestResult> {
    try {
      const transport = this.transportFor(connection);
      try {
        return await checkConnection(transport);
      } finally {
        await transport.close();
      }
    } catch (e) {
      return failure(e);
    }
  }

  async dispose(): Promise<void> {}
}
