import { generateKeyPairSync } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { readXlsx, writeXlsx } from "./crm/xlsx.js";
import { createDb, runMigrations } from "./db/client.js";

// Needs PostgreSQL (CI starts one). Each run gets a fresh database.
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const TEST_DB = "platform_crm_test";
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
const available = await admin`select 1`.then(() => true).catch(() => false);

const { privateKey } = generateKeyPairSync("ed25519");
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: "crm-reader@project.iam.gserviceaccount.com",
  private_key: google.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

describe.skipIf(!available)("CRM", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createDb>;
  let owner: string;

  // The Google side, faked: the token endpoint, the sheet's metadata and its values.
  const sharedSheets = new Set(["1SharedSheetIdAbCdEfGh"]);
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "g-token" }), { status: 200 });
    const id = /spreadsheets\/([^/?]+)/.exec(url)?.[1] ?? "";
    if (!sharedSheets.has(id)) return new Response("{}", { status: 403 });
    if (url.includes("/values/"))
      return new Response(
        JSON.stringify({
          values: [
            ["Ism", "Telefon", "Manba"],
            ["Sheet Lead", "91 111 22 33", "google"],
          ],
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        properties: { title: "Leads sheet" },
        sheets: [{ properties: { sheetId: 0, title: "List1" } }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
    db = createDb(url);
    await runMigrations(db.db);
    const config = loadConfig({
      DATABASE_URL: url,
      JWT_SECRET: "test-secret-that-is-long-enough-1234567890",
      LICENSE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      LOG_LEVEL: process.env.TEST_LOG ?? "silent",
      AUTH_RATE_PER_MINUTE: "1000",
      ENTITLEMENTS_CACHE_SECONDS: "0",
      BILLING_JOBS: "off",
      REMOTE_JOBS: "off",
      ADMIN_EMAIL: "boss@platform.uz",
      ADMIN_PASSWORD: "admin-password-123",
      GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT,
    });
    app = await buildApp(db.db, config, { fetch: fakeFetch });
    owner = (
      await app.inject({
        method: "POST",
        url: "/v1/admin/login",
        payload: { email: "boss@platform.uz", password: "admin-password-123" },
      })
    ).json().accessToken;
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE crm_pipelines, crm_leads, crm_import_jobs CASCADE`;
    await db.sql`DELETE FROM admins WHERE role = 'manager'`;
    await db.sql`DELETE FROM admin_audit`;
    await db.sql`DELETE FROM app_settings WHERE key = 'crm'`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.sql.end();
    await admin.end();
  });

  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    token?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const ok = async (res: ReturnType<typeof call>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json();
  };

  /** A manager, with the one-time password changed, signed in. */
  async function manager(email: string) {
    const created = await ok(
      call("POST", "/v1/admin/admins", owner, {
        email,
        name: email.split("@")[0],
        role: "manager",
      }),
    );
    const first = await ok(
      call("POST", "/v1/admin/login", undefined, { email, password: created.tempPassword }),
    );
    await ok(
      call("POST", "/v1/admin/password", first.accessToken, {
        currentPassword: created.tempPassword,
        newPassword: "my-own-password-1",
      }),
    );
    const session = await ok(
      call("POST", "/v1/admin/login", undefined, { email, password: "my-own-password-1" }),
    );
    return { id: created.id as string, token: session.accessToken as string };
  }

  const stages = async (token = owner) =>
    (await ok(call("GET", "/v1/crm/funnel", token))).stages as {
      id: string;
      name: string;
      isWon: boolean;
      isLost: boolean;
      leads: number;
    }[];
  const stageId = async (name: string) => (await stages()).find((s) => s.name === name)!.id;
  const addLead = (token: string, phone: string, extra: object = {}) =>
    call("POST", "/v1/crm/leads", token, { name: `Lead ${phone}`, phone, ...extra });

  /** New leads go to the managers in turn by default; most tests want leads with no owner. */
  const autoAssign = (on: boolean) => ok(call("PUT", "/v1/crm/settings", owner, { autoAssign: on }));

  it("starts with a funnel the admin can shape: add, rename, reorder, delete", async () => {
    const first = await stages();
    expect(first.map((s) => s.name)).toEqual([
      "Yangi lead",
      "Bog'lanildi",
      "Qiziqish bildirdi",
      "Kelishuv",
      "Mijoz bo'ldi",
      "Rad etildi",
    ]);
    expect(first.find((s) => s.name === "Mijoz bo'ldi")?.isWon).toBe(true);
    expect(first.find((s) => s.name === "Rad etildi")?.isLost).toBe(true);

    await ok(call("POST", "/v1/crm/stages", owner, { name: "Taklif yuborildi", color: "#112233" }));
    const added = await stages();
    expect(added.at(-1)?.name).toBe("Taklif yuborildi");
    const offer = added.at(-1)!.id;
    await ok(call("PATCH", `/v1/crm/stages/${offer}`, owner, { name: "Taklif" }));
    // A stage cannot be both won and lost.
    expect(
      (await call("PATCH", `/v1/crm/stages/${added[0]!.id}`, owner, { isWon: true, isLost: true }))
        .statusCode,
    ).toBe(400);

    const order = added.map((s) => s.id).reverse();
    expect(
      (await ok(call("PUT", "/v1/crm/stages/order", owner, { ids: order }))).stages.map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual(order);
    expect((await call("PUT", "/v1/crm/stages/order", owner, { ids: order.slice(1) })).statusCode).toBe(400);

    await ok(call("DELETE", `/v1/crm/stages/${offer}`, owner));
    expect((await stages()).map((s) => s.name)).not.toContain("Taklif");
    expect(await stages()).toHaveLength(6);
  });

  it("deleting a stage with leads asks where they go, and keeps the history of the stage", async () => {
    const lead = (await ok(addLead(owner, "901234567"))).lead;
    const fresh = await stageId("Yangi lead");
    const next = await stageId("Bog'lanildi");
    const res = await call("DELETE", `/v1/crm/stages/${fresh}`, owner);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("STAGE_HAS_LEADS");
    await ok(call("DELETE", `/v1/crm/stages/${fresh}?moveTo=${next}`, owner));
    const detail = await ok(call("GET", `/v1/crm/leads/${lead.id}`, owner));
    expect(detail.lead.stageName).toBe("Bog'lanildi");
    expect(detail.history.map((h: { toStage: string }) => h.toStage)).toEqual(["Bog'lanildi", "Yangi lead"]);
  });

  it("a lead with the same phone is updated, not added twice", async () => {
    const created = await addLead(owner, "+998 90 123-45-67", { source: "instagram" });
    expect(created.statusCode).toBe(201);
    const again = await addLead(owner, "90 123 45 67", { name: "Ali Valiyev", company: "Ali MChJ" });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().lead.id).toBe(created.json().lead.id);
    expect(again.json().lead.name).toBe("Ali Valiyev");
    expect(again.json().lead.source).toBe("instagram");
    expect(again.json().lead.phone).toBe("+998901234567");
    expect((await ok(call("GET", "/v1/crm/leads", owner))).total).toBe(1);
    expect((await addLead(owner, "12345")).statusCode).toBe(400);
  });

  it("someone who signs up on the website with a phone is a new lead; the same phone is not added twice", async () => {
    const signup = (email: string, phone?: string) =>
      call("POST", "/v1/auth/register", undefined, {
        email,
        password: "correct-horse-battery",
        name: "Yangi Mijoz",
        accountName: "Yangi MChJ",
        ...(phone === undefined ? {} : { phone }),
      });
    const leadsOf = async () =>
      (await ok(call("GET", "/v1/crm/leads?limit=20", owner))).leads as {
        id: string;
        name: string;
        phone: string;
        company: string | null;
        source: string | null;
        stageId: string;
        ownerId: string | null;
      }[];

    // A bad phone is refused and makes no account.
    const bad = await signup("bad-phone@example.com", "12ab");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("BAD_PHONE");
    expect(await leadsOf()).toHaveLength(0);

    // A phone of only spaces is a bad phone (not a generic validation error).
    expect((await signup("blank-phone@example.com", "   ")).json().code).toBe("BAD_PHONE");

    // Without a phone there is no lead.
    expect((await signup("no-phone@example.com")).statusCode).toBe(200);
    expect(await leadsOf()).toHaveLength(0);

    // With a phone: the person is a user with that phone, and a lead in the first stage with no manager.
    const reg = await signup("lead-signup@example.com", "+998 90 123-45-67");
    expect(reg.statusCode).toBe(200);
    const [user] = await db.sql`select phone from users where email = 'lead-signup@example.com'`;
    expect(user?.phone).toBe("+998901234567");
    const [lead, ...rest] = await leadsOf();
    expect(rest).toHaveLength(0);
    expect(lead).toMatchObject({
      name: "Yangi Mijoz",
      phone: "+998901234567",
      company: "Yangi MChJ",
      source: "Sayt (ro'yxatdan o'tish)",
      ownerId: null,
    });
    expect(lead?.stageId).toBe((await stages())[0]?.id);
    const detail = await ok(call("GET", `/v1/crm/leads/${lead!.id}`, owner));
    expect(detail.notes[0].text).toContain("lead-signup@example.com");

    // The same number written another way (even with the 00 prefix) is the same lead: it gets a note, not a second row, and
    // nothing of the lead changes (nobody has shown the number is theirs).
    const second = await call("POST", "/v1/auth/register", undefined, {
      email: "second@example.com",
      password: "correct-horse-battery",
      name: "Someone Else",
      accountName: "Other MChJ",
      phone: "00 998 90 123 45 67",
    });
    expect(second.statusCode).toBe(200);
    const after = await leadsOf();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: "Yangi Mijoz", company: "Yangi MChJ" });
    const again = await ok(call("GET", `/v1/crm/leads/${lead!.id}`, owner));
    expect(again.notes).toHaveLength(2);
    expect(JSON.stringify(again.notes)).toContain("tasdiqlanmagan");
  });

  it("a sign-up is not put into a won or lost stage when the funnel has no open one", async () => {
    await stages(); // makes the default funnel
    await db.sql`UPDATE crm_stages SET is_lost = true WHERE is_won = false`;
    const res = await call("POST", "/v1/auth/register", undefined, {
      email: "closed-funnel@example.com",
      password: "correct-horse-battery",
      name: "Yangi",
      accountName: "Yangi MChJ",
      phone: "+998 91 000 11 22",
    });
    // The person is registered all the same; there is just no lead.
    expect(res.statusCode).toBe(200);
    expect(await ok(call("GET", "/v1/crm/leads?limit=20", owner))).toMatchObject({ leads: [] });
  });

  it("staff give many leads to a manager at once: by id or by the list's filters; a manager cannot", async () => {
    await autoAssign(false);
    const a = await manager("bulk-a@x.uz");
    const b = await manager("bulk-b@x.uz");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await ok(addLead(owner, `90100000${i}`, { source: i < 3 ? "google" : "telegram" }))).lead.id);
    const ownersOf = async () =>
      new Map(
        (
          (await ok(call("GET", "/v1/crm/leads?limit=20", owner))).leads as {
            id: string;
            ownerId: string | null;
          }[]
        ).map((l) => [l.id, l.ownerId]),
      );
    const assign = (token: string, body: object) => call("POST", "/v1/crm/leads/assign", token, body);

    // Three picked leads go to A; the others stay with nobody.
    expect(await ok(assign(owner, { ownerId: a.id, ids: ids.slice(0, 3) }))).toEqual({
      matched: 3,
      assigned: 3,
    });
    let owners = await ownersOf();
    expect(ids.map((id) => owners.get(id))).toEqual([a.id, a.id, a.id, null, null]);

    // Again with a lead A already has: it is matched, not counted as changed.
    expect(await ok(assign(owner, { ownerId: a.id, ids: ids.slice(0, 4) }))).toEqual({
      matched: 4,
      assigned: 1,
    });

    // Every lead without a manager (the list's filter) goes to B.
    expect(await ok(assign(owner, { ownerId: b.id, filter: { ownerId: "none" } }))).toEqual({
      matched: 1,
      assigned: 1,
    });
    // By source: the telegram ones go to A.
    expect(await ok(assign(owner, { ownerId: a.id, filter: { source: "telegram" } }))).toMatchObject({
      matched: 2,
    });
    owners = await ownersOf();
    expect(ids.map((id) => owners.get(id))).toEqual([a.id, a.id, a.id, a.id, a.id]);

    // Taking leads back (no manager).
    expect(await ok(assign(owner, { ownerId: null, ids: [ids[0]!, ids[1]!] }))).toMatchObject({
      assigned: 2,
    });
    owners = await ownersOf();
    expect(owners.get(ids[0]!)).toBeNull();

    // The audit says how many changed hands.
    const [audit] =
      await db.sql`select payload from admin_audit where action = 'crm.lead.assign_bulk' limit 1`;
    expect(audit?.payload).toMatchObject({ ownerId: a.id, by: "ids" });

    // Refused: a manager, an unknown or disabled manager, both ids and a filter, neither, too many.
    expect((await assign(a.token, { ownerId: b.id, ids })).statusCode).toBe(403);
    const unknown = await assign(owner, { ownerId: "00000000-0000-4000-8000-000000000000", ids });
    expect([unknown.statusCode, unknown.json().code]).toEqual([400, "BAD_OWNER"]);
    expect((await assign(owner, { ownerId: a.id, ids, filter: {} })).statusCode).toBe(400);
    expect((await assign(owner, { ownerId: a.id })).statusCode).toBe(400);
    expect((await assign(owner, { ownerId: a.id, ids: [] })).statusCode).toBe(400);
    await ok(call("POST", `/v1/admin/admins/${b.id}/disable`, owner));
    const disabled = await assign(owner, { ownerId: b.id, ids });
    expect([disabled.statusCode, disabled.json().code]).toEqual([400, "BAD_OWNER"]);
  });

  it("new leads go to the sales managers in turn: by hand, from a sign-up, from an import; it can be turned off", async () => {
    const ownerOf = async (phone: string) =>
      (
        (await ok(call("GET", "/v1/crm/leads?limit=50", owner))).leads as {
          phone: string;
          ownerId: string | null;
        }[]
      ).find((l) => l.phone === phone)?.ownerId;

    // No manager yet: no owner, as before.
    await ok(addLead(owner, "905000001"));
    expect(await ownerOf("+998905000001")).toBeNull();

    const a = await manager("turn-a@x.uz");
    const b = await manager("turn-b@x.uz");
    const c = await manager("turn-c@x.uz");
    expect(await ok(call("GET", "/v1/crm/settings", owner))).toEqual({ autoAssign: true, managers: 3 });

    // By hand (staff): a, b, c, a ...
    for (let i = 2; i <= 5; i++) await ok(addLead(owner, `90500000${i}`));
    const handOwners = await Promise.all([2, 3, 4, 5].map((i) => ownerOf(`+99890500000${i}`)));
    expect(handOwners).toEqual([a.id, b.id, c.id, a.id]);

    // A manager's own lead stays with the manager and does not use a turn.
    await ok(addLead(b.token, "905000010"));
    expect(await ownerOf("+998905000010")).toBe(b.id);

    // A disabled manager is out of the turn: the turns go on between a and b (b is next after the four above).
    await ok(call("POST", `/v1/admin/admins/${c.id}/disable`, owner));
    await ok(addLead(owner, "905000011"));
    await ok(addLead(owner, "905000012"));
    expect([await ownerOf("+998905000011"), await ownerOf("+998905000012")]).toEqual([b.id, a.id]);

    // An import by staff shares its new rows out in turn.
    await ok(
      call(
        "POST",
        "/v1/crm/import/file",
        owner,
        xlsxBody([
          ["Ism", "Telefon"],
          ["I1", "906000001"],
          ["I2", "906000002"],
          ["I3", "906000003"],
          ["I4", "906000004"],
        ]),
      ),
    );
    // The import's rows go in the exact order of the turn (b is next, then a, ...), and so does the sign-up that follows.
    const imported = await Promise.all([1, 2, 3, 4].map((i) => ownerOf(`+99890600000${i}`)));
    expect(imported).toEqual([b.id, a.id, b.id, a.id]);

    // A sign-up on the website is a lead for the next manager in the turn too.
    await ok(
      call("POST", "/v1/auth/register", undefined, {
        email: "turn-signup@example.com",
        password: "correct-horse-battery",
        name: "Yangi",
        accountName: "Yangi MChJ",
        phone: "+998 91 777 88 99",
      }),
    );
    expect(await ownerOf("+998917778899")).toBe(b.id);

    // Off: new leads have no owner again. A manager cannot read or change the setting.
    expect(await autoAssign(false)).toEqual({ autoAssign: false, managers: 2 });
    await ok(addLead(owner, "905000020"));
    expect(await ownerOf("+998905000020")).toBeNull();
    expect((await call("GET", "/v1/crm/settings", a.token)).statusCode).toBe(403);
    expect((await call("PUT", "/v1/crm/settings", a.token, { autoAssign: true })).statusCode).toBe(403);
    const [audit] =
      await db.sql`select payload from admin_audit where action = 'crm.settings.auto_assign' limit 1`;
    expect(audit?.payload).toMatchObject({ autoAssign: expect.any(Boolean) });
  });

  it("a manager is made with a one-time password, which must be changed before anything else", async () => {
    const created = await ok(
      call("POST", "/v1/admin/admins", owner, { email: "ali@platform.uz", name: "Ali", role: "manager" }),
    );
    expect(created.tempPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(created.mustChangePassword).toBe(true);
    const login = await ok(
      call("POST", "/v1/admin/login", undefined, {
        email: "ali@platform.uz",
        password: created.tempPassword,
      }),
    );
    expect(login.admin.mustChangePassword).toBe(true);
    const stuck = await call("GET", "/v1/crm/leads", login.accessToken);
    expect(stuck.statusCode).toBe(403);
    expect(stuck.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await call("GET", "/v1/admin/me", login.accessToken)).statusCode).toBe(200);
    expect(
      (
        await call("POST", "/v1/admin/password", login.accessToken, {
          currentPassword: "wrong-password",
          newPassword: "another-password-1",
        })
      ).statusCode,
    ).toBe(401);
    await ok(
      call("POST", "/v1/admin/password", login.accessToken, {
        currentPassword: created.tempPassword,
        newPassword: "another-password-1",
      }),
    );
    expect((await call("GET", "/v1/crm/leads", login.accessToken)).statusCode).toBe(200);
    // The one-time password is gone: only its hash was kept.
    expect(
      (
        await call("POST", "/v1/admin/login", undefined, {
          email: "ali@platform.uz",
          password: created.tempPassword,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("a manager has the CRM only: every other part of the dashboard is closed", async () => {
    const m = await manager("only-crm@platform.uz");
    for (const url of [
      "/v1/admin/overview",
      "/v1/admin/accounts",
      "/v1/admin/admins",
      "/v1/admin/audit",
      "/v1/admin/billing/plans",
    ])
      expect((await call("GET", url, m.token)).statusCode, url).toBe(403);
    expect((await call("GET", "/v1/crm/leads", m.token)).statusCode).toBe(200);
    // …and cannot shape the funnel.
    expect((await call("POST", "/v1/crm/stages", m.token, { name: "Mine" })).statusCode).toBe(403);
    expect((await call("DELETE", `/v1/crm/stages/${await stageId("Yangi lead")}`, m.token)).statusCode).toBe(
      403,
    );
  });

  it("a manager sees and touches only their own leads", async () => {
    const a = await manager("a@platform.uz");
    const b = await manager("b@platform.uz");
    const leadA = (await ok(addLead(a.token, "901111111"))).lead;
    const leadB = (await ok(addLead(b.token, "902222222"))).lead;
    expect(leadA.ownerId).toBe(a.id);

    expect((await ok(call("GET", "/v1/crm/leads", a.token))).leads.map((l: { id: string }) => l.id)).toEqual([
      leadA.id,
    ]);
    expect((await ok(call("GET", "/v1/crm/leads", owner))).total).toBe(2);
    // Another manager's lead looks as if it did not exist, whatever is done to it.
    expect((await call("GET", `/v1/crm/leads/${leadB.id}`, a.token)).statusCode).toBe(404);
    expect((await call("PATCH", `/v1/crm/leads/${leadB.id}`, a.token, { name: "x" })).statusCode).toBe(404);
    expect(
      (await call("POST", `/v1/crm/leads/${leadB.id}/stage`, a.token, { stageId: await stageId("Kelishuv") }))
        .statusCode,
    ).toBe(404);
    expect((await call("POST", `/v1/crm/leads/${leadB.id}/notes`, a.token, { text: "x" })).statusCode).toBe(
      404,
    );
    expect(
      (await call("POST", `/v1/crm/leads/${leadB.id}/calls`, a.token, { result: "answered" })).statusCode,
    ).toBe(404);
    // The same phone as someone else's lead is a conflict, not an overwrite.
    const clash = await addLead(a.token, "902222222", { name: "Stolen" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().code).toBe("DUPLICATE_LEAD");
    expect((await ok(call("GET", `/v1/crm/leads/${leadB.id}`, owner))).lead.name).toBe("Lead 902222222");
    // A manager cannot hand a lead to anyone.
    expect((await call("PATCH", `/v1/crm/leads/${leadA.id}`, a.token, { ownerId: b.id })).statusCode).toBe(
      403,
    );
    // The owner can; then it is the other manager's.
    await ok(call("PATCH", `/v1/crm/leads/${leadA.id}`, owner, { ownerId: b.id }));
    expect((await call("GET", `/v1/crm/leads/${leadA.id}`, a.token)).statusCode).toBe(404);
    expect((await call("GET", `/v1/crm/leads/${leadA.id}`, b.token)).statusCode).toBe(200);
    // The funnel's counts are the manager's own, too.
    expect((await stages(b.token)).reduce((n, s) => n + s.leads, 0)).toBe(2);
    expect((await stages(a.token)).reduce((n, s) => n + s.leads, 0)).toBe(0);
  });

  it("the Mini App signs in with the person's own email and password, and the token is for the CRM only", async () => {
    const created = await ok(
      call("POST", "/v1/admin/admins", owner, { email: "mini@platform.uz", name: "Mini", role: "manager" }),
    );
    // A wrong password and an unknown person are the same answer.
    expect(
      (
        await call("POST", "/v1/crm/login", undefined, {
          email: "mini@platform.uz",
          password: "wrong-password",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call("POST", "/v1/crm/login", undefined, {
          email: "nobody@platform.uz",
          password: "wrong-password",
        })
      ).statusCode,
    ).toBe(401);

    // The first sign-in is with the one-time password: only changing it is allowed.
    const first = await ok(
      call("POST", "/v1/crm/login", undefined, { email: "mini@platform.uz", password: created.tempPassword }),
    );
    expect(first.mustChangePassword).toBe(true);
    const stuck = await call("GET", "/v1/crm/leads", first.accessToken);
    expect(stuck.statusCode).toBe(403);
    expect(stuck.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect(
      (
        await call("POST", "/v1/crm/password", first.accessToken, {
          currentPassword: "wrong-password",
          newPassword: "my-own-password-1",
        })
      ).statusCode,
    ).toBe(401);
    await ok(
      call("POST", "/v1/crm/password", first.accessToken, {
        currentPassword: created.tempPassword,
        newPassword: "my-own-password-1",
      }),
    );

    const session = await ok(
      call("POST", "/v1/crm/login", undefined, { email: "mini@platform.uz", password: "my-own-password-1" }),
    );
    expect(session.mustChangePassword).toBe(false);
    const me = await ok(call("GET", "/v1/crm/me", session.accessToken));
    expect(me).toMatchObject({ name: "Mini", role: "manager", seesAll: false });
    expect((await call("GET", "/v1/crm/leads", session.accessToken)).statusCode).toBe(200);
    // The session is for the CRM only: it opens nothing of the dashboard, even for an owner who signs in on a phone.
    expect((await call("GET", "/v1/admin/me", session.accessToken)).statusCode).toBe(401);
    expect((await call("GET", "/v1/admin/overview", session.accessToken)).statusCode).toBe(401);
    const bossSession = await ok(
      call("POST", "/v1/crm/login", undefined, { email: "boss@platform.uz", password: "admin-password-123" }),
    );
    expect((await call("GET", "/v1/admin/overview", bossSession.accessToken)).statusCode).toBe(401);
    expect((await ok(call("GET", "/v1/crm/me", bossSession.accessToken))).seesAll).toBe(true);
    // Nobody signed in gets nothing; a customer's token is not an admin's.
    expect((await call("GET", "/v1/crm/leads")).statusCode).toBe(401);
    expect((await call("GET", "/v1/crm/leads", "not-a-token")).statusCode).toBe(401);

    // A disabled person is out at once, with the token they already hold.
    const row = (await ok(call("GET", "/v1/admin/admins", owner))).find(
      (a: { email: string }) => a.email === "mini@platform.uz",
    );
    await ok(call("POST", `/v1/admin/admins/${row.id}/disable`, owner));
    expect((await call("GET", "/v1/crm/leads", session.accessToken)).statusCode).toBe(401);
    expect(
      (
        await call("POST", "/v1/crm/login", undefined, {
          email: "mini@platform.uz",
          password: "my-own-password-1",
        })
      ).statusCode,
    ).toBe(403);
  });

  it("an operator's day: stage moves, notes, calls — all remembered", async () => {
    const m = await manager("op@platform.uz");
    const lead = (await ok(addLead(m.token, "903333333", { note: "Called us first" }))).lead;
    expect(lead.stageName).toBe("Yangi lead");
    expect(lead.lastContactAt).toBeNull();

    const moved = await ok(
      call("POST", `/v1/crm/leads/${lead.id}/stage`, m.token, { stageId: await stageId("Bog'lanildi") }),
    );
    expect(moved.stageName).toBe("Bog'lanildi");
    await ok(call("POST", `/v1/crm/leads/${lead.id}/notes`, m.token, { text: "Wants a demo" }));
    await ok(call("POST", `/v1/crm/leads/${lead.id}/calls`, m.token, { result: "no_answer" }));
    await ok(
      call("POST", `/v1/crm/leads/${lead.id}/calls`, m.token, {
        result: "answered",
        durationSec: 95,
        note: "Friday",
      }),
    );

    const detail = await ok(call("GET", `/v1/crm/leads/${lead.id}`, m.token));
    expect(detail.notes.map((n: { text: string }) => n.text).sort()).toEqual([
      "Called us first",
      "Wants a demo",
    ]);
    expect(detail.calls.map((c: { result: string }) => c.result)).toEqual(["answered", "no_answer"]);
    expect(detail.calls[0].durationSec).toBe(95);
    expect(detail.lead.lastContactAt).not.toBeNull();
    expect(
      detail.history.map((h: { fromStage: string | null; toStage: string }) => [h.fromStage, h.toStage]),
    ).toEqual([
      ["Yangi lead", "Bog'lanildi"],
      [null, "Yangi lead"],
    ]);
    expect(detail.history[0].byName).toBe("op");
    // Moving to the stage it is already in changes nothing.
    await ok(
      call("POST", `/v1/crm/leads/${lead.id}/stage`, m.token, { stageId: await stageId("Bog'lanildi") }),
    );
    expect((await ok(call("GET", `/v1/crm/leads/${lead.id}`, m.token))).history).toHaveLength(2);
  });

  it("the admin shapes the client card, the managers fill it in", async () => {
    const a = await manager("card-a@platform.uz");
    const b = await manager("card-b@platform.uz");
    type Card = {
      id: string;
      name: string;
      fields: { id: string; label: string; type: string; options: string[] }[];
    }[];
    const layout = async (token = owner) => (await ok(call("GET", "/v1/crm/card", token))) as Card;
    expect(await layout()).toEqual([]);

    // Only owner and support shape the card.
    expect((await call("POST", "/v1/crm/card/sections", a.token, { name: "Mine" })).statusCode).toBe(403);
    await ok(call("POST", "/v1/crm/card/sections", owner, { name: "Contact" }));
    await ok(call("POST", "/v1/crm/card/sections", owner, { name: "Business" }));
    let card = await layout();
    expect(card.map((s) => s.name)).toEqual(["Contact", "Business"]);
    const [contact, business] = [card[0]!.id, card[1]!.id];
    const field = (sectionId: string, label: string, type: string, options?: string[]) =>
      ok(call("POST", "/v1/crm/card/fields", owner, { sectionId, label, type, options }));
    await field(contact, "E-mail", "email");
    await field(contact, "Birthday", "date");
    await field(business, "Employees", "number");
    await field(business, "Region", "select", ["Toshkent", "Samarqand", "Toshkent"]);
    await field(business, "Uses 1C", "checkbox");
    await field(business, "About", "textarea");
    card = await layout();
    expect(card[0]!.fields.map((f) => f.label)).toEqual(["E-mail", "Birthday"]);
    expect(card[1]!.fields.find((f) => f.label === "Region")?.options).toEqual(["Toshkent", "Samarqand"]);
    // A select needs choices; a field needs a section that exists.
    expect(
      (await call("POST", "/v1/crm/card/fields", owner, { sectionId: business, label: "X", type: "select" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/crm/card/fields", owner, {
          sectionId: "11111111-1111-4111-8111-111111111111",
          label: "X",
          type: "text",
        })
      ).statusCode,
    ).toBe(404);
    const id = (label: string) => card.flatMap((s) => s.fields).find((f) => f.label === label)!.id;

    // A manager fills in their own lead; the values are checked against the type.
    const lead = (await ok(addLead(a.token, "909000001"))).lead;
    const save = (token: string, values: Record<string, string>) =>
      call("PUT", `/v1/crm/leads/${lead.id}/values`, token, { values });
    const saved = await ok(
      save(a.token, {
        [id("E-mail")]: "ali@example.uz",
        [id("Birthday")]: "1990-05-17",
        [id("Employees")]: " 1 250,5 ",
        [id("Region")]: "Samarqand",
        [id("Uses 1C")]: "true",
        [id("About")]: "Wants a quote\nfor 5 users",
      }),
    );
    expect(saved[id("Employees")]).toBe("1250.5");
    expect(saved[id("About")]).toBe("Wants a quote\nfor 5 users");
    for (const [values, why] of [
      [{ [id("E-mail")]: "not-an-email" }, "E-mail"],
      [{ [id("Birthday")]: "17.05.1990" }, "Birthday"],
      [{ [id("Employees")]: "many" }, "Employees"],
      [{ [id("Region")]: "Paris" }, "Region"],
      [{ [id("Uses 1C")]: "maybe" }, "Uses 1C"],
    ] as const) {
      const bad = await save(a.token, { ...values, [id("About")]: "should not be saved" });
      expect(bad.statusCode, why).toBe(400);
      expect(bad.json().code).toBe("BAD_VALUE");
      expect(bad.json().message).toContain(why);
    }
    expect((await call("GET", `/v1/crm/leads/${lead.id}`, a.token)).json().values[id("About")]).toBe(
      "Wants a quote\nfor 5 users",
    );

    // Empty clears a field, the others stay; the card comes back with the lead.
    await ok(save(a.token, { [id("Region")]: "", [id("Uses 1C")]: "false" }));
    const detail = (await call("GET", `/v1/crm/leads/${lead.id}`, owner)).json();
    expect(detail.values[id("Region")]).toBeUndefined();
    expect(detail.values[id("Uses 1C")]).toBe("false");
    expect(detail.values[id("E-mail")]).toBe("ali@example.uz");
    // Another manager cannot read or write this lead's card.
    expect((await save(b.token, { [id("About")]: "x" })).statusCode).toBe(404);
    expect((await call("GET", `/v1/crm/leads/${lead.id}`, b.token)).statusCode).toBe(404);
    expect((await save(a.token, { "11111111-1111-4111-8111-111111111111": "x" })).statusCode).toBe(400);

    // The admin reorders, renames, moves a field to another section and deletes; a deleted field takes its values with it.
    await ok(call("PUT", "/v1/crm/card/sections/order", owner, { ids: [business, contact] }));
    expect((await layout()).map((s) => s.name)).toEqual(["Business", "Contact"]);
    await ok(call("PATCH", `/v1/crm/card/sections/${contact}`, owner, { name: "Contact details" }));
    await ok(
      call("PATCH", `/v1/crm/card/fields/${id("About")}`, owner, { label: "Notes", sectionId: contact }),
    );
    card = await layout();
    expect(card.find((s) => s.id === contact)?.fields.map((f) => f.label)).toEqual([
      "E-mail",
      "Birthday",
      "Notes",
    ]);
    expect(
      (await call("PATCH", `/v1/crm/card/fields/${id("Region")}`, owner, { options: [] })).statusCode,
    ).toBe(400);
    await ok(
      call("PUT", `/v1/crm/card/sections/${contact}/fields/order`, owner, {
        ids: [id("Notes"), id("E-mail"), id("Birthday")],
      }),
    );
    expect((await layout()).find((s) => s.id === contact)?.fields[0]?.label).toBe("Notes");
    expect(
      (await call("PUT", `/v1/crm/card/sections/${contact}/fields/order`, owner, { ids: [id("E-mail")] }))
        .statusCode,
    ).toBe(400);
    await ok(call("DELETE", `/v1/crm/card/fields/${id("E-mail")}`, owner));
    expect(
      (await call("GET", `/v1/crm/leads/${lead.id}`, owner)).json().values[id("E-mail")],
    ).toBeUndefined();
    await ok(call("DELETE", `/v1/crm/card/sections/${business}`, owner));
    expect((await layout()).map((s) => s.name)).toEqual(["Contact details"]);
    expect(Object.keys((await call("GET", `/v1/crm/leads/${lead.id}`, owner)).json().values).sort()).toEqual(
      [id("Birthday"), id("Notes")].sort(),
    );
    expect((await call("DELETE", `/v1/crm/card/sections/${business}`, owner)).statusCode).toBe(404);
  });

  it("filters the lead list and finds a lead by any part of its phone", async () => {
    await ok(addLead(owner, "904444444", { name: "Sardor", source: "instagram" }));
    await ok(addLead(owner, "905555555", { name: "Dilnoza", source: "reklama", company: "Dil MChJ" }));
    const list = (q: string) =>
      call("GET", `/v1/crm/leads?${q}`, owner).then((r) =>
        r.json().leads.map((l: { name: string }) => l.name),
      );
    expect(await list("q=sardor")).toEqual(["Sardor"]);
    expect(await list("q=555-55")).toEqual(["Dilnoza"]);
    expect(await list("q=dil%20mchj")).toEqual(["Dilnoza"]);
    expect(await list("source=instagram")).toEqual(["Sardor"]);
    expect(await list("ownerId=none")).toHaveLength(2);
    expect(await list(`stageId=${await stageId("Kelishuv")}`)).toEqual([]);
    expect(await list("q=%25")).toEqual([]);
  });

  it("counts the funnel, the conversion, the sources and the managers", async () => {
    const a = await manager("rep-a@platform.uz");
    const b = await manager("rep-b@platform.uz");
    const s = {
      new: await stageId("Yangi lead"),
      talk: await stageId("Bog'lanildi"),
      interest: await stageId("Qiziqish bildirdi"),
      deal: await stageId("Kelishuv"),
      won: await stageId("Mijoz bo'ldi"),
      lost: await stageId("Rad etildi"),
    };
    // Ten leads of manager A (instagram) and two of B (reklama).
    const leads: string[] = [];
    for (let i = 0; i < 10; i++)
      leads.push(
        (await ok(addLead(a.token, `9100000${String(i).padStart(2, "0")}`, { source: "instagram" }))).lead.id,
      );
    const other: string[] = [];
    for (let i = 0; i < 2; i++)
      other.push(
        (await ok(addLead(b.token, `9200000${String(i).padStart(2, "0")}`, { source: "reklama" }))).lead.id,
      );
    const move = (token: string, id: string, stage: string) =>
      ok(call("POST", `/v1/crm/leads/${id}/stage`, token, { stageId: stage }));
    // A: 8 talked to, 5 interested, 3 reached a deal, 2 won (one straight from "deal"), 1 lost after talking, 2 never moved.
    for (const id of leads.slice(0, 8)) await move(a.token, id, s.talk);
    for (const id of leads.slice(0, 5)) await move(a.token, id, s.interest);
    for (const id of leads.slice(0, 3)) await move(a.token, id, s.deal);
    for (const id of leads.slice(0, 2)) await move(a.token, id, s.won);
    await move(a.token, leads[7]!, s.lost);
    // B: both won, jumping over the middle stages.
    for (const id of other) await move(b.token, id, s.won);

    const report = await ok(call("GET", "/v1/crm/reports", owner));
    expect(report.totalLeads).toBe(12);
    expect(report.won).toBe(4);
    expect(report.lost).toBe(1);
    expect(report.conversionPct).toBeCloseTo(33.3, 1);
    // A funnel counts a lead in every stage it got to or went beyond (a lead that jumped to "won" passed the ones before).
    expect(report.funnel.map((f: { name: string; reached: number }) => [f.name, f.reached])).toEqual([
      ["Yangi lead", 12],
      ["Bog'lanildi", 10],
      ["Qiziqish bildirdi", 7],
      ["Kelishuv", 5],
      ["Mijoz bo'ldi", 4],
    ]);
    expect(report.funnel[1].fromPrevPct).toBeCloseTo(83.3, 1);
    expect(report.funnel[4].fromFirstPct).toBeCloseTo(33.3, 1);
    expect(report.lostStages).toEqual([{ stageId: s.lost, name: "Rad etildi", leads: 1 }]);

    const instagram = report.bySource.find((x: { source: string }) => x.source === "instagram");
    expect(instagram).toMatchObject({ leads: 10, won: 2, conversionPct: 20 });
    expect(report.bySource.find((x: { source: string }) => x.source === "reklama")).toMatchObject({
      leads: 2,
      won: 2,
      conversionPct: 100,
    });
    const rep = (name: string) => report.byManager.find((m: { name: string }) => m.name === name);
    expect(rep("rep-a")).toMatchObject({ leads: 10, won: 2, lost: 1, winRatePct: 66.7 });
    expect(rep("rep-b")).toMatchObject({ leads: 2, won: 2, lost: 0, winRatePct: 100 });
    // The time in a stage is counted from the moves.
    const inStage = report.timeInStage.find((t: { name: string }) => t.name === "Bog'lanildi");
    expect(inStage.leads).toBeGreaterThan(0);
    expect(inStage.avgHours).toBeGreaterThanOrEqual(0);

    // A manager's reports hold only their own leads.
    const mine = await ok(call("GET", "/v1/crm/reports", b.token));
    expect(mine.totalLeads).toBe(2);
    expect(mine.byManager.map((m: { name: string }) => m.name)).toEqual(["rep-b"]);
    // The period: leads made today are in, leads of an earlier day are out.
    const today = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
    expect((await ok(call("GET", `/v1/crm/reports?from=${today}&to=${today}`, owner))).totalLeads).toBe(12);
    expect((await ok(call("GET", "/v1/crm/reports?to=2020-01-01", owner))).totalLeads).toBe(0);
    expect((await call("GET", "/v1/crm/reports?from=yesterday", owner)).statusCode).toBe(400);
  });

  const xlsxBody = (rows: (string | number | null)[][]) => ({
    fileName: "leads.xlsx",
    dataBase64: Buffer.from(writeXlsx([{ name: "Sheet1", rows }])).toString("base64"),
  });

  it("imports an Excel file: matched columns, broken rows written down, duplicates updated", async () => {
    await ok(addLead(owner, "901000001", { name: "Old name" }));
    const job = await ok(
      call(
        "POST",
        "/v1/crm/import/file",
        owner,
        xlsxBody([
          ["Ism", "Telefon", "Manba", "Izoh", "Yosh"],
          ["Ali", "90 100 00 02", "instagram", "Wants a quote", 30],
          ["Vali", "90-abc-00-03", "reklama", null, 41],
          ["New name", "+998901000001", "tavsiya", null, null],
          [null, null, null, null, null],
          ["Sardor", 901000004, null, null, null],
          ["Nomer yo'q", "", null, null, null],
          ["Ali again", "90 100 00 02", "instagram", null, null],
        ]),
      ),
    );
    expect(job).toMatchObject({
      status: "done",
      rowsTotal: 6,
      rowsCreated: 2,
      rowsUpdated: 2,
      rowsFailed: 2,
      failure: null,
    });
    expect(job.errors.map((e: { row: number }) => e.row)).toEqual([3, 7]);
    expect(job.errors[0].reason).toMatch(/not valid/);
    expect(job.ignored).toEqual(["Yosh"]);
    expect(job.mapped.map((m: { field: string }) => m.field)).toEqual(["name", "phone", "source", "note"]);

    const all = (await ok(call("GET", "/v1/crm/leads", owner))).leads as {
      name: string;
      phone: string;
      source: string | null;
    }[];
    expect(all).toHaveLength(3);
    expect(all.find((l) => l.phone === "+998901000001")).toMatchObject({
      name: "New name",
      source: "tavsiya",
    });
    expect(all.find((l) => l.phone === "+998901000004")?.name).toBe("Sardor");
    // Imported leads are in the funnel's first stage, with their history started, and the note is kept.
    const ali = all.find((l) => l.phone === "+998901000002") as unknown as { id: string };
    const detail = await ok(call("GET", `/v1/crm/leads/${ali.id}`, owner));
    expect(detail.lead.stageName).toBe("Yangi lead");
    expect(detail.history).toHaveLength(1);
    expect(detail.notes.map((n: { text: string }) => n.text)).toEqual(["Wants a quote"]);
    // The job is in the history of imports.
    expect((await ok(call("GET", "/v1/crm/import/jobs", owner)))[0]).toMatchObject({
      id: job.id,
      createdByName: "Owner",
    });
    // Importing the same file again changes nothing but counts.
    const again = await ok(
      call("POST", "/v1/crm/import/file", owner, xlsxBody([["Telefon"], ["90 100 00 02"]])),
    );
    expect(again).toMatchObject({ rowsCreated: 0, rowsUpdated: 1 });
  });

  it("imports a list as people really keep it: an empty first row, titles in Cyrillic, numbered rows with nothing in them, a note beside", async () => {
    const job = await ok(
      call(
        "POST",
        "/v1/crm/import/file",
        owner,
        xlsxBody([
          [],
          ["№", "ким ", "Telefon", "жарайонда", "тулов килди ", "Status", ""],
          [1, "шахло", 903702628, null, null, "Active", null],
          [2, "насибахон", 990013888, null, null, null, "тел олмади"],
          [3, null, 994244554, null, null, null, null],
          [4, "темур", "+998 91 519 62 89, 71 200 10 10", null, null, null, null],
          [5, null, null, null, null, null, null],
          [6, null, null, null, null, null, null],
        ]),
      ),
    );
    expect(job).toMatchObject({ status: "done", rowsTotal: 4, rowsCreated: 4, rowsFailed: 0, failure: null });
    expect(job.mapped.map((m: { field: string }) => m.field).sort()).toEqual([
      "name",
      "note",
      "phone",
      "stage",
    ]);
    const leads = (await ok(call("GET", "/v1/crm/leads?limit=10", owner))).leads as {
      name: string;
      phone: string;
      id: string;
    }[];
    expect(leads.map((l) => l.phone).sort()).toEqual([
      "+998903702628",
      "+998915196289",
      "+998990013888",
      "+998994244554",
    ]);
    // A lead with no name is called by its number; a stage text that is not one of the funnel's is left alone.
    expect(leads.find((l) => l.phone === "+998994244554")?.name).toBe("+998994244554");
    expect(
      (await ok(call("GET", `/v1/crm/leads/${leads.find((l) => l.phone === "+998903702628")!.id}`, owner)))
        .lead.stageName,
    ).toBe("Yangi lead");
    const noted = leads.find((l) => l.phone === "+998990013888")!;
    expect(
      (await ok(call("GET", `/v1/crm/leads/${noted.id}`, owner))).notes.map((n: { text: string }) => n.text),
    ).toEqual(["тел олмади"]);
  });

  it("imports a CSV (semicolons, Windows-1251) and tells what to do with an old .xls", async () => {
    const csv = Buffer.from("Ism;Telefon\r\nAli;901112233\r\nVali;90 222 33 44\r\n");
    const job = await ok(
      call("POST", "/v1/crm/import/file", owner, {
        fileName: "leads.csv",
        dataBase64: csv.toString("base64"),
      }),
    );
    expect(job).toMatchObject({ status: "done", rowsCreated: 2 });
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const old = await call("POST", "/v1/crm/import/file", owner, {
      fileName: "old.xls",
      dataBase64: xls.toString("base64"),
    });
    expect(old.statusCode).toBe(400);
    expect(old.json().code).toBe("OLD_XLS");
    expect(old.json().message).toContain(".xlsx");
  });

  it("when no column has phones, the failure lists the columns it saw", async () => {
    const job = await ok(
      call("POST", "/v1/crm/import/file", owner, xlsxBody([[], ["Ism", "Yosh"], ["Ali", 30]])),
    );
    expect(job.status).toBe("failed");
    expect(job.failure).toContain("Ism, Yosh");
  });

  it("an import with no phone column fails as a whole, and says why; a file that is not xlsx is refused", async () => {
    const job = await ok(
      call(
        "POST",
        "/v1/crm/import/file",
        owner,
        xlsxBody([
          ["Ism", "Yosh"],
          ["Ali", 30],
        ]),
      ),
    );
    expect(job.status).toBe("failed");
    expect(job.failure).toMatch(/phone/i);
    expect(job.rowsCreated).toBe(0);
    // A broken zip (it starts like an .xlsx and is not one) is refused; a plain text file is a CSV and is read.
    const broken = await call("POST", "/v1/crm/import/file", owner, {
      fileName: "leads.xlsx",
      dataBase64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().code).toBe("BAD_XLSX");
  });

  it("an import by a manager makes the manager's own leads, and cannot take another's", async () => {
    const a = await manager("imp-a@platform.uz");
    const b = await manager("imp-b@platform.uz");
    await ok(addLead(b.token, "906000001"));
    const job = await ok(
      call("POST", "/v1/crm/import/file", a.token, xlsxBody([["Phone"], ["906000001"], ["906000002"]])),
    );
    expect(job).toMatchObject({ rowsCreated: 1, rowsFailed: 1 });
    expect(job.errors[0].reason).toMatch(/another manager/);
    const mine = (await ok(call("GET", "/v1/crm/leads", a.token))).leads;
    expect(mine).toHaveLength(1);
    expect(mine[0].ownerId).toBe(a.id);
    // Each sees only their own imports.
    expect(await ok(call("GET", "/v1/crm/import/jobs", b.token))).toHaveLength(0);
  });

  it("imports a Google Sheet shared with the service account, and says so when it is not shared", async () => {
    const info = await ok(call("GET", "/v1/crm/import/google", owner));
    expect(info).toEqual({ enabled: true, serviceEmail: "crm-reader@project.iam.gserviceaccount.com" });
    const job = await ok(
      call("POST", "/v1/crm/import/sheet", owner, {
        url: "https://docs.google.com/spreadsheets/d/1SharedSheetIdAbCdEfGh/edit#gid=0",
      }),
    );
    expect(job).toMatchObject({
      source: "google_sheet",
      fileName: "Leads sheet",
      rowsCreated: 1,
      status: "done",
    });
    expect((await ok(call("GET", "/v1/crm/leads?q=Sheet", owner))).leads[0]).toMatchObject({
      phone: "+998911112233",
      source: "google",
    });
    const refused = await call("POST", "/v1/crm/import/sheet", owner, {
      url: "https://docs.google.com/spreadsheets/d/1PrivateSheetIdAbCdEfGh/edit",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("SHEET_NOT_SHARED");
    expect(refused.json().message).toContain("crm-reader@project.iam.gserviceaccount.com");
    expect(
      (await call("POST", "/v1/crm/import/sheet", owner, { url: "https://example.com/x" })).statusCode,
    ).toBe(400);
  });

  it("exports the leads as they are filtered, and the reports, as .xlsx", async () => {
    await autoAssign(false);
    const a = await manager("exp@platform.uz");
    await ok(addLead(owner, "907000001", { name: "Owner's", source: "x" }));
    await ok(addLead(a.token, "907000002", { name: "Manager's", source: "y" }));
    const file = await call("GET", "/v1/crm/leads/export.xlsx?source=y&lang=ru", owner);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("spreadsheetml");
    const rows = readXlsx(file.rawPayload);
    expect(rows[0]).toEqual([
      "Имя",
      "Телефон",
      "Источник",
      "Компания",
      "Этап",
      "Менеджер",
      "Последний контакт",
      "Создан",
    ]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(["Manager's"]);
    // A manager exports only their own.
    expect(readXlsx((await call("GET", "/v1/crm/leads/export.xlsx", a.token)).rawPayload)).toHaveLength(2);
    const report = await call("GET", "/v1/crm/reports/export.xlsx?lang=uz", owner);
    expect(report.statusCode).toBe(200);
    expect(readXlsx(report.rawPayload)[0]?.[0]).toBe("Bosqich");
  });

  it("writes the owner's changes to the audit log", async () => {
    await ok(call("POST", "/v1/crm/stages", owner, { name: "Audit me" }));
    await ok(call("POST", "/v1/crm/import/file", owner, xlsxBody([["Phone"], ["908000001"]])));
    const audit = (await ok(call("GET", "/v1/admin/audit", owner))) as { action: string }[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["crm.stage.add", "crm.import"]));
  });
});
