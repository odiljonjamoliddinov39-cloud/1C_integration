/**
 * COM external connection to 1C (TD §5, transport phase 1):
 * V83.COMConnector → Connect("File=...;Usr=...;Pwd=...") → connection.PlatformAPI.<Function>(json).
 *
 * Needs Windows, the 1C platform with comcntr.dll registered, and a process of the same bitness
 * as the platform (64-bit). Works without 1C being open and without publishing the base.
 * Each open connection uses a 1C license; close it when idle.
 *
 * winax calls are synchronous: in the desktop app they run in a worker thread per infobase.
 */
import { createRequire } from "node:module";

import type { PlatformFunction } from "@platform/shared";

import { type ConnectionOptions, buildConnectionString, describeInfobase } from "./connection-string.js";
import { OneCError } from "./errors.js";
import type { PlatformTransport } from "./transport.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- COM objects are untyped dispatch objects */
export interface Winax {
  Object: new (progId: string) => any;
  release(...objects: unknown[]): void;
}

const require = createRequire(import.meta.url);

export function loadWinax(): Winax {
  if (process.platform !== "win32") {
    throw new OneCError("COM_UNAVAILABLE", "The 1C COM connection works only on Windows");
  }
  try {
    return require("winax") as Winax;
  } catch (e) {
    throw new OneCError(
      "COM_UNAVAILABLE",
      "The winax module is missing or was built for another Node/Electron version (run the native rebuild)",
      { cause: String(e) },
    );
  }
}

function comMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ComConnectOptions extends ConnectionOptions {
  /** V83.COMConnector for 8.3 (default). */
  progId?: string;
}

export class ComTransport implements PlatformTransport {
  private constructor(
    private readonly winax: Winax,
    private readonly connector: any,
    private readonly connection: any,
  ) {}

  /** `winax` is only passed by tests. */
  static connect(options: ComConnectOptions, winax: Winax = loadWinax()): ComTransport {
    const progId = options.progId ?? "V83.COMConnector";
    let connector: any;
    try {
      connector = new winax.Object(progId);
    } catch (e) {
      throw new OneCError(
        "COM_UNAVAILABLE",
        `${progId} is not registered. As administrator run: regsvr32 "C:\\Program Files\\1cv8\\<version>\\bin\\comcntr.dll" ` +
          `(this process is ${process.arch}; the 1C platform must be the same bitness)`,
        { cause: comMessage(e) },
      );
    }
    let connection: any;
    try {
      connection = connector.Connect(buildConnectionString(options));
    } catch (e) {
      winax.release(connector);
      // 1C explains the reason itself: wrong user or password, base not found, exclusive mode, no license.
      throw new OneCError(
        "CONNECT_FAILED",
        `Cannot connect to ${describeInfobase(options.infobase)}: ${comMessage(e)}`,
      );
    }
    return new ComTransport(winax, connector, connection);
  }

  async call(fn: PlatformFunction, arg?: string): Promise<string> {
    const missing =
      "The PlatformAPI extension is not installed in this base, or its common module lacks the «Внешнее соединение» flag";
    let api: any;
    try {
      api = this.connection.PlatformAPI;
    } catch (e) {
      throw new OneCError("NOT_FOUND", missing, { cause: comMessage(e) });
    }
    // 1C answers a missing module with nothing rather than an error.
    if (api == null) throw new OneCError("NOT_FOUND", missing);

    // Read the member once. 1C's COM objects carry no type information, so winax cannot tell a
    // method from a property: a function that takes no arguments (Ping, GetOrganizations) runs as
    // soon as it is read, and the read returns its result. One that takes arguments is returned
    // as something to call.
    let member: any;
    try {
      member = api[fn];
    } catch (e) {
      // PlatformAPI catches its own errors; reaching here means the call itself failed.
      throw new OneCError("INTERNAL", `${fn} failed in 1C: ${comMessage(e)}`);
    }
    if (member == null) {
      throw new OneCError(
        "NOT_FOUND",
        `The PlatformAPI module in this base has no ${fn}: paste the module's code in the Configurator and update the base (F7)`,
      );
    }
    if (typeof member !== "function") {
      if (arg !== undefined) {
        throw new OneCError("INTERNAL", `${fn} in this base takes no argument: update the extension`);
      }
      return String(
        typeof member === "object" && typeof member.valueOf === "function" ? member.valueOf() : member,
      );
    }
    try {
      return String(arg === undefined ? api[fn]() : api[fn](arg));
    } catch (e) {
      throw new OneCError("INTERNAL", `${fn} failed in 1C: ${comMessage(e)}`);
    }
  }

  async close(): Promise<void> {
    this.winax.release(this.connection, this.connector);
  }
}
