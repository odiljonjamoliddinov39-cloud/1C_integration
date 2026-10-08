import { describe, expect, it } from "vitest";

import type { UpdateState } from "../shared/ipc.js";
import { type Updater, type UpdaterEvent, UpdateService } from "./updater.js";

/** A stand-in for electron-updater: each check plays the given events. */
function fakeUpdater(checks: (UpdaterEvent[] | Error)[]) {
  let listener: (event: UpdaterEvent) => void = () => undefined;
  const calls = { check: 0, install: 0 };
  const updater: Updater = {
    async check() {
      const events = checks[calls.check++] ?? [{ type: "checking" }, { type: "none" }];
      if (events instanceof Error) {
        listener({ type: "error", message: events.message });
        throw events;
      }
      for (const event of events) listener(event);
    },
    install: () => void calls.install++,
    onEvent: (l) => void (listener = l),
  };
  return { updater, calls, send: (event: UpdaterEvent) => listener(event) };
}

function setup(checks: Parameters<typeof fakeUpdater>[0]) {
  const fake = fakeUpdater(checks);
  const states: UpdateState[] = [];
  const service = new UpdateService({
    updater: fake.updater,
    emit: (state) => states.push(state),
    now: () => new Date("2026-10-04T12:00:00Z"),
  });
  return { ...fake, service, states };
}

describe("updates", () => {
  it("does nothing where the app cannot update itself", async () => {
    const service = new UpdateService({ updater: null, emit: () => undefined });
    expect(await service.check()).toEqual({ status: "unsupported" });
  });

  it("says when the app is up to date", async () => {
    const { service } = setup([[{ type: "checking" }, { type: "none" }]]);
    expect(await service.check()).toEqual({ status: "latest", checkedAt: "2026-10-04T12:00:00.000Z" });
  });

  it("downloads a new version, reports whole percents, and installs only once it is downloaded", async () => {
    const { service, states, send, calls } = setup([
      [{ type: "checking" }, { type: "available", version: "0.1.42" }],
    ]);
    expect(await service.check()).toEqual({ status: "downloading", version: "0.1.42", percent: 0 });
    service.install();
    expect(calls.install).toBe(0);

    send({ type: "progress", percent: 10.2 });
    send({ type: "progress", percent: 10.7 });
    send({ type: "progress", percent: 55.1 });
    expect(
      states.filter((s) => s.status === "downloading").map((s) => s.status === "downloading" && s.percent),
    ).toEqual([0, 10, 55]);

    // While downloading, another check does not start a second download.
    await service.check();
    expect(calls.check).toBe(1);

    send({ type: "downloaded", version: "0.1.42" });
    expect(service.current()).toEqual({ status: "ready", version: "0.1.42" });
    service.install();
    expect(calls.install).toBe(1);
  });

  it("reports a failed check and tries again next time", async () => {
    const { service } = setup([new Error("net::ERR_INTERNET_DISCONNECTED")]);
    expect(await service.check()).toEqual({ status: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    expect((await service.check()).status).toBe("latest");
  });

  it("runs one check at a time", async () => {
    const { service, calls } = setup([]);
    await Promise.all([service.check(), service.check()]);
    expect(calls.check).toBe(1);
  });
});
