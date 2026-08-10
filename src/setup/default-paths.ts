import os from "node:os";
import path from "node:path";

export interface WcoPaths {
  home: string;
  config: string;
  credentials: string;
  state: string;
  cache: string;
  logs: string;
  bridge: string;
  install_manifest: string;
}

function absolute(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute NUL-free path.`);
  return path.resolve(value);
}

export function platformWcoHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform, homeDirectory = os.homedir()): string {
  const explicit = absolute(env.WCO_HOME, "WCO_HOME");
  if (explicit) return explicit;
  if (platform === "win32") return path.resolve(env.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local"), "WCO");
  if (platform === "darwin") return path.resolve(homeDirectory, "Library", "Application Support", "wco");
  return path.resolve(env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share"), "wco");
}

export function resolveWcoPaths(options: {
  configPath?: string;
  stateDirectory?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): WcoPaths {
  const env = options.env ?? process.env;
  const home = platformWcoHome(env, options.platform ?? process.platform, options.homeDirectory ?? os.homedir());
  const config = absolute(options.configPath, "config path") ?? absolute(env.WCO_CONFIG, "WCO_CONFIG") ?? path.join(home, "config.json");
  const state = absolute(options.stateDirectory, "state directory") ?? absolute(env.WCO_STATE_DIR, "WCO_STATE_DIR") ?? path.join(home, "state");
  return {
    home,
    config,
    state,
    credentials: path.join(home, "credentials"),
    cache: path.join(home, "cache"),
    logs: path.join(home, "logs"),
    bridge: path.join(home, "bridge"),
    install_manifest: path.join(home, "install-manifest.json"),
  };
}
