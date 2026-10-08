import type { ErrorCode } from "@platform/shared";

/** A structured error from 1C or from the connection to it. */
export class OneCError extends Error {
  constructor(
    readonly code: ErrorCode | (string & {}),
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OneCError";
  }
}
