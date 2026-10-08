import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The OS's own id of this PC: Windows MachineGuid, /etc/machine-id, or the macOS platform UUID. */
async function osMachineId(): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("reg", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1] ?? null;
    }
    if (process.platform === "darwin") {
      const { stdout } = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      return /"IOPlatformUUID" = "([^"]+)"/.exec(stdout)?.[1] ?? null;
    }
    return (await readFile("/etc/machine-id", "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** sha256 of the machine id: the raw id never leaves the PC (TD: devices.machine_id is a hash). */
export async function machineIdHash(fallback: () => string): Promise<string> {
  const id = (await osMachineId()) ?? fallback();
  return createHash("sha256").update(`platform-desktop:${id}`).digest("hex");
}

export const newFallbackId = () => randomUUID();
