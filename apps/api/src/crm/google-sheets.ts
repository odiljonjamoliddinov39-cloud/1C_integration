/**
 * Reads a Google Sheet once (docs/crm.md): the customer shares the sheet with the service account's e-mail (read only), pastes its
 * link, and the first sheet's values are read through the Sheets API. No sync, nothing is written back.
 * The service account's JSON key is in GOOGLE_SERVICE_ACCOUNT_JSON.
 */
import { createSign } from "node:crypto";

import { HttpError } from "../lib/errors.js";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(json: string | undefined): ServiceAccount | null {
  if (!json) return null;
  try {
    const key = JSON.parse(json) as Partial<ServiceAccount>;
    if (typeof key.client_email === "string" && typeof key.private_key === "string")
      return { client_email: key.client_email, private_key: key.private_key.replaceAll("\\n", "\n") };
  } catch {
    // Fall through: a broken key is the same as no key.
  }
  return null;
}

/** The sheet's id from a link like https://docs.google.com/spreadsheets/d/<id>/edit#gid=0; null for anything else. */
export function sheetIdOf(url: string): { id: string; gid: string | null } | null {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(url.trim());
  if (!m?.[1]) return null;
  return { id: m[1], gid: /[#&?]gid=(\d+)/.exec(url)?.[1] ?? null };
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

async function accessToken(account: ServiceAccount, fetchImpl: typeof fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64(signature)}`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !body.access_token)
    throw new HttpError(502, "GOOGLE_AUTH", "Google did not accept the service account");
  return body.access_token;
}

/** The first sheet (or the one the link's gid names) as rows of text. */
export async function readGoogleSheet(
  url: string,
  serviceAccountJson: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ title: string; rows: string[][]; serviceEmail: string }> {
  const account = parseServiceAccount(serviceAccountJson);
  if (!account)
    throw new HttpError(503, "GOOGLE_OFF", "Google Sheets is not set up on this server (no service account)");
  const ref = sheetIdOf(url);
  if (!ref) throw new HttpError(400, "BAD_SHEET_URL", "This is not a Google Sheets link");
  const token = await accessToken(account, fetchImpl);
  const headers = { authorization: `Bearer ${token}` };
  const metaRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${ref.id}?fields=properties.title,sheets.properties(sheetId,title)`,
    { headers },
  );
  if (metaRes.status === 403 || metaRes.status === 404)
    throw new HttpError(
      403,
      "SHEET_NOT_SHARED",
      `The sheet is not shared with ${account.client_email}: share it (read only) and try again`,
    );
  if (!metaRes.ok) throw new HttpError(502, "GOOGLE_ERROR", "Google Sheets did not answer");
  const meta = (await metaRes.json()) as {
    properties?: { title?: string };
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const tab =
    meta.sheets?.find((s) => String(s.properties?.sheetId) === ref.gid)?.properties?.title ??
    meta.sheets?.[0]?.properties?.title;
  if (!tab) throw new HttpError(400, "EMPTY_SHEET", "The spreadsheet has no sheet");
  const valuesRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${ref.id}/values/${encodeURIComponent(`'${tab.replaceAll("'", "''")}'`)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    { headers },
  );
  if (!valuesRes.ok) throw new HttpError(502, "GOOGLE_ERROR", "Google Sheets did not answer");
  const values = (await valuesRes.json()) as { values?: unknown[][] };
  const rows = (values.values ?? []).map((row) => row.map((cell) => String(cell ?? "")));
  return { title: meta.properties?.title ?? tab, rows, serviceEmail: account.client_email };
}
