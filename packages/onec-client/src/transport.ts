import type { PlatformFunction } from "@platform/shared";

/**
 * How the client reaches the PlatformAPI module: COM external connection in phase 1
 * (com-transport.ts), the extension's HTTP service later. Each call takes one JSON string
 * argument (or none) and returns the JSON envelope as a string.
 */
export interface PlatformTransport {
  call(fn: PlatformFunction, arg?: string): Promise<string>;
  close(): Promise<void>;
}
