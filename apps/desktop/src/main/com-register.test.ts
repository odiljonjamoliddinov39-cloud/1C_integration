import { describe, expect, it } from "vitest";

import {
  ELEVATION_REFUSED,
  type ComConnectorFile,
  elevationScript,
  findComConnectors,
  registerComConnector,
} from "./com-register.js";

const x64 = (version: string): ComConnectorFile => ({
  version,
  dll: `C:\\Program Files\\1cv8\\${version}\\bin\\comcntr.dll`,
  bits: 64,
});
const x86 = (version: string): ComConnectorFile => ({
  version,
  dll: `C:\\Program Files (x86)\\1cv8\\${version}\\bin\\comcntr.dll`,
  bits: 32,
});

function deps(files: ComConnectorFile[], code: number | null = 0, registeredAfter = true) {
  const registered: string[] = [];
  return {
    registered,
    deps: {
      platform: "win32" as const,
      arch: "x64",
      find: () => files,
      register: async (dll: string) => {
        registered.push(dll);
        return { code };
      },
      isRegistered: async () => registered.length > 0 && registeredAfter,
    },
  };
}

describe("finding the COM connectors of the installed 1C platforms", () => {
  it("lists the 64-bit and the 32-bit ones, newest first, ignoring folders that are not versions", () => {
    const dirs: Record<string, string[]> = {
      "C:\\Program Files\\1cv8": ["8.3.18.1208", "common", "8.3.24.1548"],
      "C:\\Program Files (x86)\\1cv8": ["8.3.25.1000"],
    };
    const found = findComConnectors(
      (p) => !p.includes("8.3.18"),
      (dir) => dirs[dir] ?? [],
      { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    );
    expect(found.map((f) => [f.version, f.bits])).toEqual([
      ["8.3.25.1000", 32],
      ["8.3.24.1548", 64],
    ]);
  });

  it("finds nothing without Program Files", () => {
    expect(
      findComConnectors(
        () => true,
        () => [],
        {},
      ),
    ).toEqual([]);
  });
});

describe("registering the COM connector", () => {
  it("registers the newest connector of this app's bitness and confirms Windows has it", async () => {
    const { deps: d, registered } = deps([x86("8.3.25.1000"), x64("8.3.24.1548"), x64("8.3.18.1208")]);
    expect(await registerComConnector(d)).toEqual({
      ok: true,
      data: { version: "8.3.24.1548", dll: x64("8.3.24.1548").dll },
    });
    expect(registered).toEqual([x64("8.3.24.1548").dll]);
  });

  it("says so when only a 32-bit platform is installed, and registers nothing", async () => {
    const { deps: d, registered } = deps([x86("8.3.24.1548")]);
    expect(await registerComConnector(d)).toMatchObject({ ok: false, code: "COM_REGISTER_WRONG_BITNESS" });
    expect(registered).toEqual([]);
  });

  it("says so when no 1C platform is found", async () => {
    const { deps: d } = deps([]);
    expect(await registerComConnector(d)).toMatchObject({ ok: false, code: "COM_REGISTER_NO_PLATFORM" });
  });

  it("is not Windows: nothing to do", async () => {
    const { deps: d } = deps([x64("8.3.24.1548")]);
    expect(await registerComConnector({ ...d, platform: "linux" })).toMatchObject({
      ok: false,
      code: "COM_REGISTER_UNSUPPORTED",
    });
  });

  it("a refused Windows prompt is a refusal, not a failure of 1C", async () => {
    expect(await registerComConnector(deps([x64("8.3.24.1548")], ELEVATION_REFUSED).deps)).toMatchObject({
      ok: false,
      code: "COM_REGISTER_DENIED",
    });
    expect(await registerComConnector(deps([x64("8.3.24.1548")], null).deps)).toMatchObject({
      ok: false,
      code: "COM_REGISTER_DENIED",
    });
  });

  it("a regsvr32 error, or a success after which Windows still has no connector, is reported", async () => {
    const failed = await registerComConnector(deps([x64("8.3.24.1548")], 5).deps);
    expect(failed).toMatchObject({ ok: false, code: "COM_REGISTER_FAILED" });
    expect(failed.ok ? "" : failed.message).toContain("exit code 5");
    expect(await registerComConnector(deps([x64("8.3.24.1548")], 0, false).deps)).toMatchObject({
      ok: false,
      code: "COM_REGISTER_FAILED",
    });
  });
});

describe("the elevation command", () => {
  it("runs regsvr32 quietly as administrator, passes its exit code back and quotes the path", () => {
    const script = elevationScript("C:\\Program Files\\1cv8\\8.3.24.1548\\bin\\comcntr.dll");
    expect(script).toContain("-Verb RunAs");
    expect(script).toContain("regsvr32.exe");
    expect(script).toContain("'/s'");
    expect(script).toContain(`'"C:\\Program Files\\1cv8\\8.3.24.1548\\bin\\comcntr.dll"'`);
    expect(script).toContain(`exit ${ELEVATION_REFUSED}`);
    // A quote in a path cannot end the PowerShell string.
    expect(elevationScript("C:\\a'b\\comcntr.dll")).toContain("a''b");
  });
});
