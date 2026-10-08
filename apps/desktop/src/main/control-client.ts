/** HTTP client for the control system (apps/api). Runs in the main process, never in the UI. */
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import {
  AiEvent,
  AiPolicy,
  AnswerLookup,
  type AiChatInput,
  type AnswerKey,
  type AnswerStoreInput,
  ApiErrorBody,
  type DigestInput,
  type DigestKey,
  type FreeAnswerInput,
  type LearnInput,
  QueryTemplateView,
  LicenseResponse,
  Me,
  TokenPair,
  type ActivateDeviceInput,
  type RegisterInput,
} from "@platform/shared";
import { z } from "zod";

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const SignedIn = TokenPair.extend({ me: Me });
export type AiTurn = Extract<AiEvent, { type: "message" }>;
/**
 * An assistant turn may run for many minutes (a card for a whole bank statement), so it has no time
 * limit: it is cut off only when nothing at all arrives for a while, and the server sends a ping
 * every 15 s while it works.
 */
const AI_IDLE_MS = 2 * 60_000;
/** Chats larger than this go gzipped: 1C rows and text shrink several times. */
const GZIP_FROM_BYTES = 16 * 1024;
const gzipAsync = promisify(gzip);

export interface TurnHandlers {
  /** The answer text, as it is written. */
  onText: (text: string) => void;
  /** The model's short progress notes between tool calls. */
  onProgress?: (text: string) => void;
  /** The account is close to a spend limit; the answer goes on. */
  onWarning?: (code: string, message: string) => void;
}
export type SignedIn = z.infer<typeof SignedIn>;

export class ControlClient {
  private readonly base: string;

  constructor(
    serverUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = serverUrl.replace(/\/+$/, "");
  }

  register(input: RegisterInput): Promise<SignedIn> {
    return this.call("/v1/auth/register", SignedIn, input);
  }

  login(email: string, password: string): Promise<SignedIn> {
    return this.call("/v1/auth/login", SignedIn, { email, password });
  }

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.call("/v1/auth/refresh", TokenPair, { refreshToken });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.request("POST", "/v1/auth/logout", { refreshToken }).catch(() => undefined);
  }

  activate(accessToken: string, input: ActivateDeviceInput): Promise<LicenseResponse> {
    return this.call("/v1/devices/activate", LicenseResponse, input, accessToken);
  }

  check(accessToken: string, machineId: string): Promise<LicenseResponse> {
    return this.call("/v1/license/check", LicenseResponse, { machineId }, accessToken);
  }

  /**
   * One assistant turn through the AI proxy. Text and progress notes arrive through the handlers
   * as they are written; the finished turn is returned. An error event becomes a ControlError.
   */
  async aiTurn(
    accessToken: string,
    input: AiChatInput,
    handlers: TurnHandlers,
    signal: AbortSignal,
  ): Promise<AiTurn> {
    // Cut off only a connection that has gone quiet; every line (pings included) resets the clock.
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(new DOMException("No answer", "TimeoutError")), AI_IDLE_MS);
    const alive = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new DOMException("No answer", "TimeoutError")), AI_IDLE_MS);
    };
    try {
      const json = JSON.stringify(input);
      const body =
        json.length > GZIP_FROM_BYTES
          ? { data: await gzipAsync(Buffer.from(json)), encoding: "gzip" as const }
          : { data: json };
      const response = await this.request(
        "POST",
        "/v1/ai/chat",
        undefined,
        accessToken,
        AbortSignal.any([signal, idle.signal]),
        body,
      );
      if (!response.body) throw new ControlError("BAD_RESPONSE", "The server sent no answer");
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of response.body) {
          alive();
          buffer += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = AiEvent.safeParse(JSON.parse(line));
            if (!event.success) continue; // a newer server may send event types this app does not know
            if (event.data.type === "text") handlers.onText(event.data.text);
            else if (event.data.type === "progress") handlers.onProgress?.(event.data.text);
            else if (event.data.type === "warning") handlers.onWarning?.(event.data.code, event.data.message);
            else if (event.data.type === "ping") continue;
            else if (event.data.type === "error") throw new ControlError(event.data.code, event.data.message);
            else return event.data;
          }
        }
      } catch (e) {
        if (e instanceof ControlError) throw e;
        if (signal.aborted) throw new ControlError("AI_ABORTED", "Stopped");
        throw new ControlError(
          "OFFLINE",
          `The answer was cut off: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      throw new ControlError("BAD_RESPONSE", "The answer ended before it was complete");
    } finally {
      clearTimeout(idleTimer);
    }
  }

  // --- the cost engine's helpers: the limits, the answers the app can give without the model ---

  async aiPolicy(accessToken: string): Promise<AiPolicy> {
    return AiPolicy.parse(await (await this.request("GET", "/v1/ai/policy", undefined, accessToken)).json());
  }

  async aiTemplates(accessToken: string): Promise<QueryTemplateView[]> {
    const response = await this.request("GET", "/v1/ai/templates", undefined, accessToken);
    return z.array(QueryTemplateView).parse(await response.json());
  }

  /** The model answered this question with one query: counted, and made a template after a few times. */
  async learnTemplate(accessToken: string, input: LearnInput): Promise<boolean> {
    const response = await this.request("POST", "/v1/ai/templates/learn", input, accessToken);
    return z.object({ created: z.boolean() }).parse(await response.json()).created;
  }

  /** "Ask AI anyway" on a learned template's answer: the server turns that template off. */
  async rejectTemplate(accessToken: string, code: string): Promise<void> {
    await this.request("POST", "/v1/ai/templates/reject", { code }, accessToken);
  }

  async lookupAnswer(accessToken: string, key: AnswerKey): Promise<AnswerLookup> {
    return AnswerLookup.parse(
      await (await this.request("POST", "/v1/ai/answers/lookup", key, accessToken)).json(),
    );
  }

  async storeAnswer(accessToken: string, input: AnswerStoreInput): Promise<void> {
    await this.request("POST", "/v1/ai/answers", input, accessToken);
  }

  /** Tells the server an answer was given without the model, so the cost dashboard counts it. */
  async reportFreeAnswer(accessToken: string, input: FreeAnswerInput): Promise<void> {
    await this.request("POST", "/v1/ai/free", input, accessToken);
  }

  async hasDigest(accessToken: string, key: DigestKey): Promise<boolean> {
    const query = new URLSearchParams(key).toString();
    const response = await this.request("GET", `/v1/ai/digest?${query}`, undefined, accessToken);
    return z.object({ found: z.boolean() }).parse(await response.json()).found;
  }

  async putDigest(accessToken: string, input: DigestInput): Promise<void> {
    await this.request("PUT", "/v1/ai/digest", input, accessToken);
  }

  async publicKey(): Promise<string> {
    const response = await this.request("GET", "/v1/license/public-key");
    return z.object({ publicKey: z.string() }).parse(await response.json()).publicKey;
  }

  private async call<T>(path: string, schema: z.ZodType<T>, body: unknown, accessToken?: string): Promise<T> {
    const response = await this.request("POST", path, body, accessToken);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new ControlError("BAD_RESPONSE", "The server answered in an unexpected format", response.status);
    return parsed.data;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accessToken?: string,
    signal: AbortSignal = AbortSignal.timeout(15_000),
    /** A body already serialized (and maybe gzipped), sent instead of `body`. */
    raw?: { data: string | Buffer; encoding?: "gzip" },
  ): Promise<Response> {
    let response: Response;
    try {
      const encoded = raw ?? (body === undefined ? undefined : { data: JSON.stringify(body) });
      response = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          ...(encoded === undefined ? {} : { "content-type": "application/json" }),
          ...(encoded?.encoding ? { "content-encoding": encoded.encoding } : {}),
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: encoded?.data,
        signal,
      });
    } catch (e) {
      if (
        signal.aborted &&
        !(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError")
      ) {
        throw new ControlError("AI_ABORTED", "Stopped");
      }
      throw new ControlError(
        "OFFLINE",
        `Cannot reach ${this.base}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!response.ok) {
      const error = ApiErrorBody.safeParse(await response.json().catch(() => null));
      throw new ControlError(
        error.success ? error.data.code : "SERVER_ERROR",
        error.success ? error.data.message : `The server answered ${response.status}`,
        response.status,
      );
    }
    return response;
  }
}
