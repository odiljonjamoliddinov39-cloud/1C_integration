/**
 * The website's calls to the control system (sign-up, sign-in, cabinet). Tokens live in this
 * browser's localStorage: the access token for 15 minutes, the refresh token until sign-out.
 */
import { ApiErrorBody, DeviceView, Me, TokenPair } from "@platform/shared";
import { z } from "zod";

import { API_BASE } from "./config";

const STORAGE_KEY = "platform.session";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

interface Stored {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function load(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function save(tokens: TokenPair | null): void {
  try {
    if (!tokens) localStorage.removeItem(STORAGE_KEY);
    else
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...tokens, expiresAt: Date.now() + tokens.expiresIn * 1000 }),
      );
  } catch {
    /* storage blocked: the session lasts until the page closes */
  }
}

export function signedIn(): boolean {
  return load() !== null;
}

async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  token?: string,
) {
  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("OFFLINE", "Cannot reach the server");
  }
  if (!response.ok) {
    const error = ApiErrorBody.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      error.success ? error.data.code : "SERVER_ERROR",
      error.success ? error.data.message : `HTTP ${response.status}`,
      response.status,
    );
  }
  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

const SignedIn = TokenPair.extend({ me: Me });

export async function register(input: {
  email: string;
  password: string;
  name: string;
  accountName: string;
}) {
  const result = await request("POST", "/v1/auth/register", SignedIn, input);
  save(result);
  return result.me;
}

export async function login(email: string, password: string) {
  const result = await request("POST", "/v1/auth/login", SignedIn, { email, password });
  save(result);
  return result.me;
}

export async function logout(): Promise<void> {
  const stored = load();
  save(null);
  if (stored) {
    await request("POST", "/v1/auth/logout", z.undefined(), { refreshToken: stored.refreshToken }).catch(
      () => undefined,
    );
  }
}

/** A valid access token, refreshing it when it is about to expire; null when signed out. */
async function accessToken(): Promise<string | null> {
  const stored = load();
  if (!stored) return null;
  if (stored.expiresAt - Date.now() > 30_000) return stored.accessToken;
  try {
    const tokens = await request("POST", "/v1/auth/refresh", TokenPair, {
      refreshToken: stored.refreshToken,
    });
    save(tokens);
    return tokens.accessToken;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) save(null);
    throw e;
  }
}

async function authorized<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError("UNAUTHORIZED", "Sign in", 401);
  try {
    return await request(method, path, schema, body, token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) save(null);
    throw e;
  }
}

export const me = () => authorized("GET", "/v1/me", Me);
export const devices = () => authorized("GET", "/v1/devices", z.array(DeviceView));
export const revokeDevice = (id: string) => authorized("POST", `/v1/devices/${id}/revoke`, z.undefined(), {});
