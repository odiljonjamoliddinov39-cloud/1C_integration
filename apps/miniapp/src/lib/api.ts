/** The Mini App's calls to the server. Every call carries Telegram's signed initData; the server checks it. */
import type { BlobRef, CommandView, ProposalCard, RemoteCeiling, RemoteCommandType } from "@platform/shared";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface DeviceInfo {
  link_id: string;
  device_id: string;
  device: string;
  online: boolean;
  last_seen_at: string | null;
  ceiling: RemoteCeiling;
  active_company: string | null;
  companies: { inn: string; name: string }[];
}

export interface Me {
  user: { id: string; username: string | null; language: string };
  devices: DeviceInfo[];
}

export type { BlobRef, CommandView, ProposalCard };

/** What Telegram gives the page: the signed string the server verifies. */
export function initData(): string {
  return (window as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData ?? "";
}

type Fetch = typeof fetch;

export class Api {
  constructor(
    private readonly init: () => string = initData,
    private readonly http: Fetch = (...args) => fetch(...args),
    private readonly base = "",
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.http(`${this.base}${path}`, {
        ...init,
        headers: {
          authorization: `tma ${this.init()}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      throw new ApiError("NETWORK", "No connection");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new ApiError(body.code ?? "UNKNOWN", body.message ?? `HTTP ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  private json<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  me(): Promise<Me> {
    return this.request<Me>("/remote/me");
  }

  setActiveCompany(inn: string, deviceId: string): Promise<{ active_company: string }> {
    return this.json("/remote/active-company", { company_inn: inn, device_id: deviceId });
  }

  /** A new request. The same `requestId` sent twice (a double tap) makes one command. */
  create(input: {
    type: RemoteCommandType;
    inn: string;
    deviceId: string;
    payload: unknown;
    proposalHash?: string;
    requestId?: string;
  }): Promise<CommandView> {
    return this.json("/remote/commands", {
      type: input.type,
      company_inn: input.inn,
      device_id: input.deviceId,
      payload: input.payload,
      ...(input.proposalHash ? { proposal_hash: input.proposalHash } : {}),
      request_id: input.requestId ?? crypto.randomUUID(),
    });
  }

  command(id: string): Promise<CommandView> {
    return this.request(`/remote/commands/${id}`);
  }

  recent(): Promise<CommandView[]> {
    return this.request("/remote/commands?state=recent");
  }

  cancel(id: string): Promise<CommandView> {
    return this.request(`/remote/commands/${id}/cancel`, { method: "POST" });
  }

  /** Uploads a file for a command. A file over the limit is refused here, before any bytes are sent. */
  async upload(file: File, deviceId: string): Promise<BlobRef> {
    if (file.size > MAX_FILE_BYTES) throw new ApiError("FILE_TOO_LARGE", "The file is larger than 20 MB");
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return this.request<BlobRef>("/remote/blobs", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
        "x-sha256": sha256,
        "x-device-id": deviceId,
      },
      body: bytes,
    });
  }

  /** An output file of one of the phone's own requests. */
  async download(blobId: string): Promise<Blob> {
    let response: Response;
    try {
      response = await this.http(`${this.base}/remote/blobs/${blobId}`, {
        headers: { authorization: `tma ${this.init()}` },
      });
    } catch {
      throw new ApiError("NETWORK", "No connection");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new ApiError(body.code ?? "UNKNOWN", body.message ?? `HTTP ${response.status}`, response.status);
    }
    return response.blob();
  }
}
