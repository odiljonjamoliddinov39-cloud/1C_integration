/** pnpm --filter @platform/api keygen  -> a new Ed25519 key pair for LICENSE_PRIVATE_KEY. */
import { generateKeyPairSync } from "node:crypto";

if (process.argv[2] === "keygen") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  console.log(privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim());
  console.error("\nPublic key (for reference; the API serves it at /v1/license/public-key):");
  console.error(publicKey.export({ type: "spki", format: "pem" }).toString().trim());
} else {
  console.error("usage: cli keygen");
  process.exit(2);
}
