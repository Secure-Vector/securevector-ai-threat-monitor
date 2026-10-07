/**
 * SecureVector Guard — configuration resolver.
 *
 * Config-only module. No network I/O. Deliberately isolated from index.ts
 * so static analyzers can evaluate the two files independently.
 *
 * `url` is the ENGINE endpoint — where the plugin sends tool calls for
 * analysis (the local app by default, or a remote self-host engine, e.g. a
 * Terraform deployment). This is NOT the SecureVector cloud: the cloud
 * (scan.securevector.io, addressed elsewhere as SECUREVECTOR_URL) is only ever
 * reached by the engine itself for Cloud Connect, never by this plugin.
 *
 * Resolution order (first non-empty wins):
 *   1. pluginConfig.{url, apiKey, threshold}  — from openclaw.json
 *   2. svconfig.yml server.host + server.port — written by securevector-app
 *   3. SECUREVECTOR_ENGINE_ENDPOINT           — unified engine var (preferred)
 *   4. SECUREVECTOR_URL                        — legacy alias for the engine in
 *                                                this plugin; deprecated, kept
 *                                                for back-compat (note: the name
 *                                                means *cloud* elsewhere)
 *   5. SECUREVECTOR_{API_KEY, THRESHOLD}       — from the environment
 *   6. defaults (http://127.0.0.1:8741, no key, threshold 50)
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

/** Hosts that mean "this machine", in every spelling a URL can use. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

let warnedEndpoint = false;

/**
 * Say out loud, once, when the engine is not on this machine.
 *
 * The sibling plugins resolve their endpoint through one `resolveBaseUrl()`
 * that does this. OpenClaw resolves its own, because its config also honours
 * a plugin-config value and a discovered host/port, so it kept an inline
 * read and therefore kept the silence: `index.ts` posts raw prompt and tool
 * text to whatever this returns, and an environment variable is reachable by
 * anything that can write a dotfile in a repository the agent opens.
 *
 * Nothing is refused. Pointing at a self-host engine is supported; doing it
 * without anyone noticing is not.
 */
function noteEndpoint(url: string): string {
  if (warnedEndpoint) return url;
  warnedEndpoint = true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (LOOPBACK_HOSTS.has(host)) return url;
    const clear = parsed.protocol !== "https:"
      ? " The connection is plain HTTP, so they travel in the clear."
      : "";
    process.stderr.write(
      `[securevector] prompts and tool calls are being sent to ${parsed.host}, which is not this machine.${clear}`
      + " Unset SECUREVECTOR_ENGINE_ENDPOINT to keep everything local.\n",
    );
  } catch {
    process.stderr.write(
      `[securevector] the SecureVector endpoint "${url}" is not a URL. Falling back to the local app.\n`,
    );
    return "http://127.0.0.1:8741";
  }
  return url;
}

export function resolveConfig(pluginConfig: Record<string, any> = {}): PluginConfig {
  let defaultUrl = "http://127.0.0.1:8741";
  const sv = readSvConfig();
  if (sv) defaultUrl = `http://${sv.host}:${sv.port}`;

  return {
    url:       noteEndpoint(pluginConfig.url || process.env.SECUREVECTOR_ENGINE_ENDPOINT || process.env.SECUREVECTOR_URL || defaultUrl),
    apiKey:    pluginConfig.apiKey    || process.env.SECUREVECTOR_API_KEY   || "",
    threshold: pluginConfig.threshold ?? parseInt(process.env.SECUREVECTOR_THRESHOLD || "50", 10),
  };
}
