/**
 * Making an outgoing invoice in Didox: the parties and the units are read from Didox, the body is built
 * (outgoing.ts), and on the accountant's confirmation it is created as a DRAFT. Nothing is signed or sent
 * here: the accountant signs and sends the draft in Didox, or in a later step of the app.
 */
import type { DidoxClient} from "./client.js";
import { DidoxError } from "./client.js";
import {
  type DraftInput,
  type DraftPreview,
  type DraftProblem,
  INVOICE_DOCTYPE,
  buildInvoiceDraft,
  draftIdOf,
  partyFromProfile,
  type Party,
} from "./outgoing.js";

export type PreparedDraft =
  | { ok: true; body: Record<string, unknown>; preview: DraftPreview }
  | { ok: false; problems: DraftProblem[] };

/** A company's party from Didox; null when Didox does not know the INN. Other failures go up. */
async function partyOf(client: DidoxClient, tin: string, own: boolean): Promise<Party | null> {
  let profile: unknown;
  try {
    profile = own ? await client.profile() : await client.profileByTin(tin);
  } catch (e) {
    if (e instanceof DidoxError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
  // The VAT status is a help to Didox's checks; its lack does not stop the draft.
  const vat = await client.vatStatus(tin).catch(() => undefined);
  return partyFromProfile(tin, profile, vat);
}

/**
 * Reads what Didox says about the parties and the units and builds the draft body and its card.
 * `ownTin` is the INN of the company in the app (the seller).
 */
export async function prepareDraft(
  client: DidoxClient,
  input: DraftInput,
  ownTin: string,
): Promise<PreparedDraft> {
  const [seller, buyer, measures] = await Promise.all([
    partyOf(client, ownTin, true),
    /^(\d{9}|\d{14})$/.test(input.buyerTin) ? partyOf(client, input.buyerTin, false) : null,
    client.measures(),
  ]);
  const built = buildInvoiceDraft(input, seller, buyer, measures);
  return built.ok ? { ok: true, body: built.built.body, preview: built.built.preview } : built;
}

/** Creates the draft in Didox. Returns its id; throws DidoxError when Didox refuses (its words are in the message). */
export async function createDraft(client: DidoxClient, body: Record<string, unknown>): Promise<string> {
  const answer = await client.createDocument(INVOICE_DOCTYPE, body);
  const id = draftIdOf(answer);
  if (!id)
    throw new DidoxError("DIDOX_RESPONSE", `Didox made no draft: ${JSON.stringify(answer).slice(0, 300)}`);
  return id;
}
