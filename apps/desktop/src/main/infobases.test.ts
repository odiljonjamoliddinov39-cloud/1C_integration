import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanPath, listRegisteredInfobases, parseIbases, resolveInfobaseFolder } from "./infobases.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "infobases-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = (...parts: string[]) => {
  const folder = join(root, ...parts);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "1Cv8.1CD"), "x");
  return folder;
};

describe("resolveInfobaseFolder", () => {
  it("takes a folder that holds the base as it is", async () => {
    const folder = base("TEST");
    expect(await resolveInfobaseFolder(folder)).toEqual({ ok: true, folder, changed: false });
  });

  it("takes the folder of the .1CD file when the file was given", async () => {
    const folder = base("TEST");
    expect(await resolveInfobaseFolder(join(folder, "1Cv8.1CD"))).toEqual({
      ok: true,
      folder,
      changed: true,
    });
  });

  it("finds the one base below the folder that was chosen (the Downloads case)", async () => {
    const folder = base("Downloads", "Bases", "TEST_CRYSTAL");
    mkdirSync(join(root, "Downloads", "Other"), { recursive: true });
    writeFileSync(join(root, "Downloads", "setup.exe"), "x");
    expect(await resolveInfobaseFolder(join(root, "Downloads"))).toEqual({ ok: true, folder, changed: true });
  });

  it("refuses with the candidates when more than one base is below", async () => {
    base("Downloads", "A");
    base("Downloads", "B");
    const found = await resolveInfobaseFolder(join(root, "Downloads"));
    expect(found).toMatchObject({ ok: false, code: "INFOBASE_AMBIGUOUS" });
    expect(found.ok ? [] : found.candidates).toHaveLength(2);
  });

  it("says plainly that there is no base when there is none, and when the folder is missing", async () => {
    mkdirSync(join(root, "Downloads", "Docs"), { recursive: true });
    const none = await resolveInfobaseFolder(join(root, "Downloads"));
    expect(none).toMatchObject({ ok: false, code: "INFOBASE_NOT_FOUND" });
    expect(none.ok ? "" : none.message).toBe(join(root, "Downloads"));
    expect(await resolveInfobaseFolder(join(root, "nowhere"))).toMatchObject({
      ok: false,
      code: "INFOBASE_FOLDER_MISSING",
    });
  });

  it("does not look deeper than a few levels", async () => {
    base("Downloads", "a", "b", "c", "d");
    expect(await resolveInfobaseFolder(join(root, "Downloads"))).toMatchObject({ ok: false });
  });

  it("removes quotes and a trailing separator of a pasted path", async () => {
    expect(cleanPath('  "C:\\Bases\\TEST\\"  ')).toBe("C:\\Bases\\TEST");
    const folder = base("TEST");
    expect(await resolveInfobaseFolder(`"${folder}"`)).toMatchObject({ ok: true, folder });
  });
});

describe("the registered bases", () => {
  const sample = [
    "\uFEFF[Бухгалтерия ООО Test]",
    'Connect=File="D:\\Bases\\TEST_CRYSTAL";',
    "ID=1f6b",
    "",
    "[Server base]",
    'Connect=Srvr="srv01";Ref="buh";',
    "",
    "[Web base]",
    'Connect=ws="http://host/base";',
  ].join("\r\n");

  it("reads file and server bases from ibases.v8i", () => {
    expect(parseIbases(sample)).toEqual([
      { name: "Бухгалтерия ООО Test", kind: "file", file: "D:\\Bases\\TEST_CRYSTAL" },
      { name: "Server base", kind: "server", server: "srv01", ref: "buh" },
    ]);
  });

  it("finds the list in the 1C folder of the user's profile, and is empty without it", async () => {
    mkdirSync(join(root, "1C", "1CEStart"), { recursive: true });
    writeFileSync(join(root, "1C", "1CEStart", "ibases.v8i"), sample);
    expect(await listRegisteredInfobases(root)).toHaveLength(2);
    expect(await listRegisteredInfobases(join(root, "none"))).toEqual([]);
    expect(await listRegisteredInfobases(undefined)).toEqual([]);
  });
});
