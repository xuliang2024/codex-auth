// Electron's global fetch() uses Node/undici and ignores macOS system proxy settings.
// Codex CLI uses reqwest with system-proxy resolution, so login/token calls must use
// Chromium's network stack via net.fetch to behave the same behind VPNs and proxies.
import { net } from "electron";

export function proxyFetch(url, init = {}) {
  return net.fetch(url, init);
}
