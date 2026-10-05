import { Worker } from "node:worker_threads";

import type { ConnectionInput, ConnectionTestResult } from "../shared/ipc.js";
import {
  type OneCJob,
  type OneCOperation,
  type ToolResult,
  type TransportFactory,
  failure,
  infobaseKey,
  runJob,
  toolFailure,
} from "./onec-jobs.js";

export interface ConnectorRunner {
  check(connection: ConnectionInput): Promise<ConnectionTestResult>;
  /** One assistant operation against the company's infobase (a read, or a write the user confirmed). */
  tool(connection: ConnectionInput, name: OneCOperation, input: unknown): Promise<ToolResult>;
  /** Closes the app's connection to this infobase (before its extension is replaced); the next call reconnects. */
  release(connection: ConnectionInput): Promise<void>;
  dispose(): Promise<void>;
}

type Pending = { job: OneCJob; resolve: (result: unknown) => void };

/** Production: one worker thread per infobase. */
export class WorkerConnector implements ConnectorRunner {
  private readonly workers = new Map<string, { worker: Worker; pending: Map<number, Pending> }>();
  private nextId = 1;

  constructor(
    private readonly workerPath: string,
    private readonly demo: boolean,
  ) {}

  check(connection: ConnectionInput): Promise<ConnectionTestResult> {
    return this.run(connection, { kind: "check" }) as Promise<ConnectionTestResult>;
  }

  tool(connection: ConnectionInput, name: OneCOperation, input: unknown): Promise<ToolResult> {
    return this.run(connection, { kind: "tool", name, input }) as Promise<ToolResult>;
  }

  private run(connection: ConnectionInput, job: OneCJob): Promise<unknown> {
    const entry = this.worker(infobaseKey(connection.infobase));
    const id = this.nextId++;
    return new Promise((resolve) => {
      entry.pending.set(id, { job, resolve });
      entry.worker.postMessage({ id, connection, job });
    });
  }

  private worker(key: string) {
    let entry = this.workers.get(key);
    if (entry) return entry;
    const worker = new Worker(this.workerPath, { workerData: { demo: this.demo } });
    const created = { worker, pending: new Map<number, Pending>() };
    worker.on("message", (message: { id: number; result: unknown }) => {
      created.pending.get(message.id)?.resolve(message.result);
      created.pending.delete(message.id);
    });
    const fail = (error: unknown) => {
      for (const { job, resolve } of created.pending.values()) {
        resolve(job.kind === "check" ? failure(error) : toolFailure(error));
      }
      created.pending.clear();
      this.workers.delete(key);
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`1C worker stopped (exit code ${code})`)));
    this.workers.set(key, created);
    entry = created;
    return entry;
  }

  async release(connection: ConnectionInput): Promise<void> {
    const key = infobaseKey(connection.infobase);
    const entry = this.workers.get(key);
    if (!entry) return;
    this.workers.delete(key);
    await entry.worker.terminate();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.workers.values()].map((e) => e.worker.terminate()));
    this.workers.clear();
  }
}

/** Tests and tools: runs the same check in-process with any transport. */
export class InProcessConnector implements ConnectorRunner {
  constructor(private readonly transportFor: TransportFactory) {}

  check(connection: ConnectionInput): Promise<ConnectionTestResult> {
    return this.run(connection, { kind: "check" }) as Promise<ConnectionTestResult>;
  }

  tool(connection: ConnectionInput, name: OneCOperation, input: unknown): Promise<ToolResult> {
    return this.run(connection, { kind: "tool", name, input }) as Promise<ToolResult>;
  }

  private async run(connection: ConnectionInput, job: OneCJob): Promise<unknown> {
    try {
      const transport = this.transportFor(connection);
      try {
        return await runJob(transport, job);
      } finally {
        await transport.close();
      }
    } catch (e) {
      return job.kind === "check" ? failure(e) : toolFailure(e);
    }
  }

  async release(): Promise<void> {}

  async dispose(): Promise<void> {}
}
