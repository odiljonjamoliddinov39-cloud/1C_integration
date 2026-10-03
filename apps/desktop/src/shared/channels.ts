/** IPC channel names. Kept apart from ipc.ts so the preload script does not bundle zod. */
export const CHANNELS = {
  appInfo: "app:info",
  session: "auth:session",
  signIn: "auth:sign-in",
  signOut: "auth:sign-out",
  listCompanies: "companies:list",
  pickFolder: "companies:pick-folder",
  testConnection: "companies:test",
  addCompany: "companies:add",
  checkStatus: "companies:check",
  removeCompany: "companies:remove",
} as const;
