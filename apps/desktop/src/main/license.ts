/**
 * Offline license check (TD §4): the signed token is verified with the control system's Ed25519
 * public key. A token not refreshed for 7 days, a suspended subscription or another PC's token
 * means read-only mode. Data in 1C is never touched either way.
 */
import { LicenseClaims } from "@platform/shared";
import { decodeJwt, errors, importSPKI, jwtVerify } from "jose";

import type { LicenseView } from "../shared/ipc.js";

export async function readLicense(
  token: string,
  publicKeyPem: string,
  machineId: string,
  checkedAt: string,
  now = new Date(),
): Promise<LicenseView> {
  let claims: LicenseClaims;
  let reason: LicenseView["reason"] = null;
  try {
    const key = await importSPKI(publicKeyPem, "EdDSA");
    const { payload } = await jwtVerify(token, key, { algorithms: ["EdDSA"], currentDate: now });
    claims = LicenseClaims.parse(payload);
  } catch (e) {
    if (!(e instanceof errors.JWTExpired)) {
      return {
        plan: "",
        status: "",
        paidUntil: "",
        expiresAt: "",
        checkedAt,
        mode: "read_only",
        reason: "invalid",
      };
    }
    claims = LicenseClaims.parse(decodeJwt(token)); // signature was valid; only the time ran out
    reason = "expired_offline";
  }
  if (!reason && claims.mid !== machineId) reason = "wrong_machine";
  if (!reason && (claims.status === "suspended" || claims.status === "cancelled")) reason = claims.status;
  return {
    plan: claims.plan,
    status: claims.status,
    paidUntil: claims.paidUntil,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    checkedAt,
    mode: reason ? "read_only" : "active",
    reason,
  };
}
