/**
 * The plan of this account as the app knows it: what it allows and what is used (the server counts
 * and decides; the app shows it and stops what the server would refuse). Offline, the last answer
 * stays and nothing is blocked: the license's 7-day grace covers working without the server.
 */
import { LimitCode } from "@platform/shared";

import type { BillingView, Result } from "../shared/ipc.js";
import { ControlError } from "./control-client.js";
import type { SessionService } from "./session.js";

export interface BillingDeps {
  session: Pick<SessionService, "authorized">;
  /** The companies connected on this PC, oldest first. */
  companies: () => { inn: string; name: string }[];
  /** Told when the view changed, so the window can show it. */
  onChange?: (view: BillingView) => void;
}

const LIMIT_CODES = new Set<string>(LimitCode.options);

/** A refusal that is about the plan, as opposed to a server that cannot be reached. */
export function isLimit(error: unknown): error is ControlError {
  return error instanceof ControlError && LIMIT_CODES.has(error.code);
}

export class BillingState {
  private view: BillingView | null = null;
  /** Companies the server would not connect for lack of room: read-only here too. */
  private readonly overLimit = new Set<string>();
  private readonly registered = new Set<string>();

  constructor(private readonly deps: BillingDeps) {}

  current(): BillingView | null {
    if (!this.view) return null;
    const readOnly = new Set([...this.view.readOnlyCompanies, ...this.overLimit]);
    return { ...this.view, readOnlyCompanies: [...readOnly] };
  }

  isReadOnly(inn: string): boolean {
    return this.current()?.readOnlyCompanies.includes(inn) ?? false;
  }

  /** Connects every company of this PC on the server, then reads the limits and use. */
  async refresh(): Promise<BillingView | null> {
    try {
      const { client, accessToken } = await this.deps.session.authorized();
      for (const company of this.deps.companies()) {
        if (!company.inn || this.registered.has(company.inn)) continue;
        try {
          await client.registerCompany(accessToken, { inn: company.inn, name: company.name });
          this.registered.add(company.inn);
          this.overLimit.delete(company.inn);
        } catch (e) {
          if (isLimit(e)) this.overLimit.add(company.inn);
          else throw e;
        }
      }
      this.view = await client.entitlements(accessToken);
      const view = this.current();
      if (view) this.deps.onChange?.(view);
    } catch {
      // Offline or the server is busy: the last answer stays.
    }
    return this.current();
  }

  /** Connects one base. Refused over the plan's company limit; offline it goes through (synced later). */
  async registerCompany(company: { inn: string; name: string }): Promise<Result<null>> {
    try {
      const { client, accessToken } = await this.deps.session.authorized();
      await client.registerCompany(accessToken, company);
      this.registered.add(company.inn);
      this.overLimit.delete(company.inn);
    } catch (e) {
      if (isLimit(e)) return { ok: false, code: e.code, message: e.message };
    }
    return { ok: true, data: null };
  }

  /** Documents about to be written to 1C: reserved on the server, which refuses past the month's limit. */
  async countImport(count: number, inn: string): Promise<Result<null>> {
    return this.count((client, token) => client.countImport(token, { count, inn }));
  }

  async countAudit(inn: string): Promise<Result<null>> {
    return this.count((client, token) => client.countAudit(token, { inn }));
  }

  private async count(
    run: (
      client: Awaited<ReturnType<SessionService["authorized"]>>["client"],
      token: string,
    ) => Promise<BillingView>,
  ): Promise<Result<null>> {
    try {
      const { client, accessToken } = await this.deps.session.authorized();
      this.view = await run(client, accessToken);
      const view = this.current();
      if (view) this.deps.onChange?.(view);
    } catch (e) {
      if (isLimit(e)) return { ok: false, code: e.code, message: e.message };
      // Offline: the work goes on; the server's counters catch up on the next check.
    }
    return { ok: true, data: null };
  }
}
