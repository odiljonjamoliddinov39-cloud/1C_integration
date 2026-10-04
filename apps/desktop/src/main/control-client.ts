/** HTTP client for the control system (apps/api). Runs in the main process, never in the UI. */
import {
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
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
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
