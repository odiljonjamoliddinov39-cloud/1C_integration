import type { PlatformBridge } from "../shared/ipc";

declare global {
  interface Window {
    platform: PlatformBridge;
  }
}
