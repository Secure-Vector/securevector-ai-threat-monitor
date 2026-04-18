/**
 * SecureVector Guard — configuration resolver.
 *
 * Config-only module. No network I/O. Deliberately isolated from index.ts
 * so static analyzers can evaluate the two files independently.
 *
 * Resolution order (first non-empty wins):
 *   1. pluginConfig.{url, apiKey, threshold}  — from openclaw.json
 *   2. svconfig.yml server.host + server.port — written by securevector-app
 *   3. SECUREVECTOR_{URL, API_KEY, THRESHOLD} variables from the environment
 *   4. defaults (http://127.0.0.1:8741, no key, threshold 50)
 */

export interface PluginConfig {
  url: string;
  apiKey: string;
  threshold: number;
}

/** Read server.host and server.port from svconfig.yml (platform-specific path). */
function readSvConfig(): { host: string; port: number } | null {
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");

    const home = os.homedir();
    let configPath: string;

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      configPath = path.join(localAppData, "SecureVector", "ThreatMonitor", "svconfig.yml");
    } else if (process.platform === "darwin") {
      configPath = path.join(home, "Library", "Application Support", "SecureVector", "ThreatMonitor", "svconfig.yml");
    } else {
      configPath = path.join(home, ".local", "share", "securevector", "threat-monitor", "svconfig.yml");
    }

    const content = fs.readFileSync(configPath, "utf-8");
    let inServer = false;
    let host = "127.0.0.1";
    let port = 8741;
    for (const line of content.split("\n")) {
      const trimmed = line.trimStart();
      if (/^\w/.test(line) && line.includes(":")) {
        inServer = /^server\s*:/.test(line);
        continue;
      }
      if (!inServer) continue;
      const hostMatch = trimmed.match(/^host\s*:\s*(.+)/);
      if (hostMatch) host = hostMatch[1].trim().replace(/["']/g, "");
      const portMatch = trimmed.match(/^port\s*:\s*(\d+)/);
      if (portMatch) port = parseInt(portMatch[1], 10);
    }
    return { host, port };
  } catch {
    return null;
  }
}

export function resolveConfig(pluginConfig: Record<string, any> = {}): PluginConfig {
  let defaultUrl = "http://127.0.0.1:8741";
  const sv = readSvConfig();
  if (sv) defaultUrl = `http://${sv.host}:${sv.port}`;

  return {
    url:       pluginConfig.url       || process.env.SECUREVECTOR_URL       || defaultUrl,
    apiKey:    pluginConfig.apiKey    || process.env.SECUREVECTOR_API_KEY   || "",
    threshold: pluginConfig.threshold ?? parseInt(process.env.SECUREVECTOR_THRESHOLD || "50", 10),
  };
}
