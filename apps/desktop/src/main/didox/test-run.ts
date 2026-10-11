/**
 * The "Didox test" of the app: signs in with the accountant's E-IMZO key and reads what Didox answers,
 * step by step, so a first run on a PC shows at once what works (E-IMZO, the key, sign-in, the profile,
 * the incoming documents, one document's archive). It changes nothing in Didox or in 1C.
 */
import type { DidoxKeyView, DidoxTestInput, DidoxTestResult, DidoxTestStep } from "../../shared/ipc.js";
import { readAttachments } from "../attachments.js";
import { DIDOX_DEV_URL, DidoxClient, DidoxError } from "./client.js";
import { type EImzoClient, EImzoError, EImzoSigner } from "./eimzo.js";

const SHOWN_CHARS = 1_500;

function shown(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}\n… [cut]` : text;
}

/** The id of the first document in whatever shape the list comes (the shape is not in Didox's docs). */
export function firstDocumentId(list: unknown): string | null {
  const items = Array.isArray(list)
    ? list
    : typeof list === "object" && list !== null
      ? Object.values(list).find((v): v is unknown[] => Array.isArray(v))
      : undefined;
  const first = items?.[0];
  if (typeof first !== "object" || first === null) return null;
  for (const key of ["id", "documentId", "document_id", "doc_id", "docId"]) {
    const value = (first as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

function failure(e: unknown): string {
  if (e instanceof EImzoError || e instanceof DidoxError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export async function listKeys(eimzo: EImzoClient): Promise<DidoxKeyView[]> {
  return (await eimzo.listCertificates()).map((c) => ({
    serialNumber: c.serialNumber,
    tin: c.tin,
    commonName: c.commonName,
    organization: c.organization,
    validTo: c.validTo ? c.validTo.toISOString().slice(0, 10) : null,
  }));
}

export async function runDidoxTest(
  input: DidoxTestInput,
  deps: { eimzo: EImzoClient; fetch?: typeof fetch },
): Promise<DidoxTestResult> {
  const baseUrl = input.baseUrl || DIDOX_DEV_URL;
  const steps: DidoxTestStep[] = [];
  const step = (name: DidoxTestStep["name"], ok: boolean, detail: string) => steps.push({ name, ok, detail });

  // 1-2. E-IMZO runs, and shows a key. Nothing else can be tried without them.
  try {
    step("eimzo", true, shown(await deps.eimzo.version()));
  } catch (e) {
    step("eimzo", false, failure(e));
    return { baseUrl, steps };
  }
  try {
    const keys = await listKeys(deps.eimzo);
    step(
      "keys",
      keys.length > 0,
      keys.length > 0
        ? keys
            .map(
              (k) =>
                `${k.serialNumber} · INN ${k.tin} · ${k.commonName} · ${k.organization} · to ${k.validTo ?? "?"}`,
            )
            .join("\n")
        : "E-IMZO shows no key files on this PC",
    );
    if (keys.length === 0) return { baseUrl, steps };
  } catch (e) {
    step("keys", false, failure(e));
    return { baseUrl, steps };
  }

  // 3. Sign in: E-IMZO opens its own window for the key's password.
  const signer = new EImzoSigner(deps.eimzo, input.serialNumber ? { serialNumber: input.serialNumber } : {});
  const client = new DidoxClient(
    {
      baseUrl,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
    signer,
  );
  try {
    await client.login();
    step("login", true, "Signed in; Didox gave a token.");
  } catch (e) {
    step("login", false, failure(e));
    return { baseUrl, steps };
  }

  // 4-6. What the signed-in user can read; each is tried on its own.
  try {
    step("profile", true, shown(await client.profile()));
  } catch (e) {
    step("profile", false, failure(e));
  }
  let list: unknown = null;
  try {
    list = await client.listDocuments({ owner: 0, limit: 5 });
    step("documents", true, shown(list));
  } catch (e) {
    step("documents", false, failure(e));
  }
  const id = firstDocumentId(list);
  if (id === null) {
    if (list !== null)
      step("archive", false, "No document id found in the list above, so no archive was tried.");
    return { baseUrl, steps };
  }
  try {
    const bytes = await client.downloadArchive(id);
    const read = await readAttachments([{ name: `didox-${id}.zip`, data: new Uint8Array(bytes) }]);
    const note = read.blocks[0] as { text?: string } | undefined;
    step("archive", true, `Document ${id}: ${bytes.byteLength} bytes.\n${note?.text ?? ""}`);
  } catch (e) {
    step("archive", false, `Document ${id}: ${failure(e)}`);
  }
  return { baseUrl, steps };
}
