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
