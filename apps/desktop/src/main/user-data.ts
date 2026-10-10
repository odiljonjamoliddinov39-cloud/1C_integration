import { join } from "node:path";

/** Folders under %APPDATA% that earlier builds kept their data in, before the app was renamed. */
const LEGACY_FOLDERS = ["1C Platform", "1C-Platform", join("@platform", "desktop")];

/**
 * Where the app keeps its data. A rename changes Electron's default folder, which would leave an
 * installed app without its sign-in, companies and chats, so the folder that already holds the
 * data (platform.json) is kept.
 */
export function userDataFolder(current: string, appData: string, exists: (path: string) => boolean): string {
  if (exists(join(current, "platform.json"))) return current;
  for (const folder of LEGACY_FOLDERS) {
    const old = join(appData, folder);
    if (exists(join(old, "platform.json"))) return old;
  }
  return current;
}
