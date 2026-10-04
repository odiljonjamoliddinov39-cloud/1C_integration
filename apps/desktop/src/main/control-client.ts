/** HTTP client for the control system (apps/api). Runs in the main process, never in the UI. */
import {
  AiEvent,
  type AiChatInput,
  ApiErrorBody,
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
/** An assistant turn may take a few minutes when it thinks or the answer is long. */
const AI_TURN_TIMEOUT_MS = 5 * 60_000;
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
   * One assistant turn through the AI proxy. Text arrives through `onText` as it is written; the
   * finished turn is returned. An error event from the proxy becomes a ControlError.
   */
  async aiTurn(
    accessToken: string,
    input: AiChatInput,
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<AiTurn> {
    const response = await this.request(
      "POST",
      "/v1/ai/chat",
      input,
      accessToken,
      AbortSignal.any([signal, AbortSignal.timeout(AI_TURN_TIMEOUT_MS)]),
    );
    if (!response.body) throw new ControlError("BAD_RESPONSE", "The server sent no answer");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = AiEvent.safeParse(JSON.parse(line));
          if (!event.success) continue; // a newer server may send event types this app does not know
          if (event.data.type === "text") onText(event.data.text);
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
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
