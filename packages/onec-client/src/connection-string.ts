/**
 * 1C connection strings: File="D:\Bases\X";Usr="Admin";Pwd="..." for a file infobase,
 * Srvr="host";Ref="base";Usr=...;Pwd=... for a 1C server. A double quote inside a value is
 * written twice.
 */
export type InfobaseLocation = { file: string } | { server: string; ref: string };

export interface ConnectionOptions {
  infobase: InfobaseLocation;
  user?: string;
  password?: string;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildConnectionString({ infobase, user, password }: ConnectionOptions): string {
  const parts: string[] = [];
  if ("file" in infobase) {
    if (!infobase.file.trim()) throw new Error("Infobase folder is empty");
    parts.push(`File=${quote(infobase.file.trim())}`);
  } else {
    if (!infobase.server.trim() || !infobase.ref.trim())
      throw new Error("Server and infobase name are required");
    parts.push(`Srvr=${quote(infobase.server.trim())}`, `Ref=${quote(infobase.ref.trim())}`);
  }
  if (user) parts.push(`Usr=${quote(user)}`);
  if (password) parts.push(`Pwd=${quote(password)}`);
  return parts.join(";") + ";";
}

/** For logs and the UI: the connection string without the password. */
export function describeInfobase(infobase: InfobaseLocation): string {
  return "file" in infobase ? infobase.file : `${infobase.server}/${infobase.ref}`;
}

/**
 * For the "wrong user or password" message: what the app sent to 1C, without the password itself.
 * An accountant cannot see a look-alike letter or a trailing space, so the user name is quoted with
 * its length and the alphabets it is written in, and the password is described by length only.
 */
export function describeCredentials(user?: string, password?: string): string {
  if (!user && !password) return "no user and no password were sent";
  const scripts = new Map<string, number>();
  for (const ch of user ?? "") {
    const kind = /\p{Script=Cyrillic}/u.test(ch)
      ? "Cyrillic"
      : /\p{Script=Latin}/u.test(ch)
        ? "Latin"
        : /\d/.test(ch)
          ? "digits"
          : /\s/u.test(ch)
            ? "spaces"
            : "other";
    scripts.set(kind, (scripts.get(kind) ?? 0) + 1);
  }
  const alphabets = [...scripts].map(([kind, n]) => `${kind} ${n}`).join(", ");
  const userText = user ? `user «${user}» (${[...user].length} chars: ${alphabets})` : "no user";
  const passwordText = password
    ? `password ${[...password].length} chars` +
      (password !== password.trim() ? " (starts or ends with a space)" : "")
    : "no password";
  return `${userText}, ${passwordText}`;
}
