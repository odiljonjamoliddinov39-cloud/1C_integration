/**
 * Sign-in and license of this PC (TD §4): sign in with the platform account, activate the PC,
 * keep a signed license token, re-check it every 6 hours, and fall back to read-only mode after
 * 7 days without a successful check.
 */
import type { ActivateDeviceInput } from "@platform/shared";

import type { RegisterAccountInput, Result, Session, SignInInput } from "../shared/ipc.js";
import { ControlClient, ControlError, type SignedIn } from "./control-client.js";
import { readLicense } from "./license.js";
import type { LocalStore, StoredSession } from "./store.js";

export interface SessionDeps {
  store: LocalStore;
  /** sha256 of this PC's machine id. */
  machineId: () => Promise<string>;
  deviceName: string;
  /** Public key baked into the build; empty means "fetch it from the server at first sign-in". */
  bakedPublicKey: string;
  clientFor?: (serverUrl: string) => ControlClient;
}

function fail(e: unknown): Result<never> {
  if (e instanceof ControlError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}

export class SessionService {
  private readonly clientFor: (serverUrl: string) => ControlClient;

  constructor(private readonly deps: SessionDeps) {
    this.clientFor = deps.clientFor ?? ((url) => new ControlClient(url));
  }

  async view(): Promise<Session | null> {
    const s = this.deps.store.session;
    if (!s) return null;
    const license = s.licenseToken
      ? await readLicense(s.licenseToken, s.publicKey, await this.deps.machineId(), s.checkedAt)
      : null;
    return {
      email: s.email,
      name: s.name,
      accountName: s.accountName,
      serverUrl: s.serverUrl,
      signedInAt: s.signedInAt,
      license,
    };
  }

  signIn(input: SignInInput): Promise<Result<Session>> {
    return this.start(input.serverUrl, (client) => client.login(input.email, input.password));
  }

  /** Prototype only: the website takes over sign-up later. */
  register(input: RegisterAccountInput): Promise<Result<Session>> {
    const { serverUrl, ...account } = input;
    return this.start(serverUrl, (client) => client.register(account));
  }

  private async start(
    serverUrl: string,
    authenticate: (client: ControlClient) => Promise<SignedIn>,
  ): Promise<Result<Session>> {
    try {
      const client = this.clientFor(serverUrl);
      const signedIn = await authenticate(client);
      const publicKey = this.deps.bakedPublicKey || (await client.publicKey());
      const device: ActivateDeviceInput = {
        machineId: await this.deps.machineId(),
        name: this.deps.deviceName,
      };
      const license = await client.activate(signedIn.accessToken, device);
      const now = new Date().toISOString();
      const stored: StoredSession = {
        email: signedIn.me.user.email,
        name: signedIn.me.user.name,
        accountName: signedIn.me.account.name,
        serverUrl: serverUrl.replace(/\/+$/, ""),
        signedInAt: now,
        refreshTokenEnc: this.deps.store.encrypt(signedIn.refreshToken),
        licenseToken: license.licenseToken,
        publicKey,
        checkedAt: now,
      };
      this.deps.store.setSession(stored);
      const view = await this.view();
      if (!view || view.license?.reason === "invalid") {
        this.deps.store.setSession(null);
        return {
          ok: false,
          code: "LICENSE_INVALID",
          message: "The server's license signature does not match this app",
        };
      }
      return { ok: true, data: view };
    } catch (e) {
      return fail(e);
    }
  }

  /** The periodic check. Offline keeps the last token (grace); a rejected session signs out. */
  async refreshLicense(): Promise<Session | null> {
    const s = this.deps.store.session;
    if (!s) return null;
    const client = this.clientFor(s.serverUrl);
    try {
      const tokens = await client.refresh(this.deps.store.decrypt(s.refreshTokenEnc));
      const license = await client.check(tokens.accessToken, await this.deps.machineId());
      this.deps.store.setSession({
        ...s,
        refreshTokenEnc: this.deps.store.encrypt(tokens.refreshToken),
        licenseToken: license.licenseToken,
        checkedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (
        e instanceof ControlError &&
        ["INVALID_REFRESH", "UNAUTHORIZED", "DEVICE_REVOKED"].includes(e.code)
      ) {
        this.deps.store.setSession(null); // must sign in again; the license is gone with it
      }
      // OFFLINE and server errors: keep working on the last token until it expires.
    }
    return this.view();
  }

  async signOut(): Promise<void> {
    const s = this.deps.store.session;
    if (s) await this.clientFor(s.serverUrl).logout(this.deps.store.decrypt(s.refreshTokenEnc));
    this.deps.store.setSession(null);
  }
}
