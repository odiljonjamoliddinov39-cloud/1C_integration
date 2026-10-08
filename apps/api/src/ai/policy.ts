/**
 * AI cost policies (see AiPolicy): every limit lives in the ai_policies table, so an admin changes
 * it without a release. The default policy applies to every plan; a plan can have its own on top.
 */
import { eq, isNull } from "drizzle-orm";

import {
  type AiPolicy,
  AiPolicyOverride,
  type AiPoliciesView,
  DEFAULT_AI_POLICY,
  resolvePolicy,
} from "@platform/shared";

import type { Db } from "../db/client.js";
import { aiPolicies, plans } from "../db/schema.js";

function stored(value: Record<string, unknown> | undefined): AiPolicyOverride | null {
  const parsed = AiPolicyOverride.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The policy an account on this plan runs under now. */
export async function policyFor(db: Db, planId: string | null): Promise<AiPolicy> {
  const rows = await db.select().from(aiPolicies);
  const fallback = rows.find((row) => row.planId === null);
  const own = planId ? rows.find((row) => row.planId === planId) : undefined;
  return resolvePolicy(stored(fallback?.policy), stored(own?.policy));
}

export async function policiesView(db: Db): Promise<AiPoliciesView> {
  const rows = await db.select().from(aiPolicies);
  const allPlans = await db.select({ id: plans.id, code: plans.code }).from(plans).orderBy(plans.priceUzs);
  const fallback = rows.find((row) => row.planId === null);
  return {
    default: resolvePolicy(stored(fallback?.policy)),
    plans: allPlans.map((plan) => {
      const own = rows.find((row) => row.planId === plan.id);
      return {
        planId: plan.id,
        code: plan.code,
        policy: own ? resolvePolicy(stored(fallback?.policy), stored(own.policy)) : null,
      };
    }),
  };
}

/** Saves a plan's policy (planId), or the default one (null); `policy` null removes it. */
export async function savePolicy(
  db: Db,
  planId: string | null,
  policy: AiPolicy | null,
  adminId: string,
): Promise<void> {
  const where = planId ? eq(aiPolicies.planId, planId) : isNull(aiPolicies.planId);
  if (policy === null) {
    await db.delete(aiPolicies).where(where);
    return;
  }
  const [existing] = await db.select({ id: aiPolicies.id }).from(aiPolicies).where(where);
  const values = {
    policy: policy as unknown as Record<string, unknown>,
    updatedAt: new Date(),
    updatedBy: adminId,
  };
  if (existing) await db.update(aiPolicies).set(values).where(eq(aiPolicies.id, existing.id));
  else await db.insert(aiPolicies).values({ planId, ...values });
}

export { DEFAULT_AI_POLICY };
