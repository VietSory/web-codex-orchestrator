export const PINNED_MIUUYY_CHATGPT_WEB_RELEASE = "3.0.3";
/** Provenance commit for the qualified 3.0.3 release; runtime selection is fail-closed on releaseVersion. */
export const PINNED_MIUUYY_CHATGPT_WEB_SHA = "2569603f950de3a123e31bd26e7c8757566066f3";
export const MIUUYY_LAUNCHER_DESCRIPTOR_VERSION = 2;
export const MIUUYY_LAUNCHER_DESCRIPTOR_KIND = "codex-web-gpt-launcher";

export type ChatGptWebCompanionMode =
  | "instant"
  | "medium"
  | "high"
  | "extra-high"
  | "pro"
  | "luna";

export interface MiuuyyInstalledConfig {
  version: 3;
  releaseVersion: typeof PINNED_MIUUYY_CHATGPT_WEB_RELEASE;
  browserHost: "launcher";
  browserHostDescriptorPath: string;
  appName: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

export interface MiuuyyLauncherDescriptor {
  version: typeof MIUUYY_LAUNCHER_DESCRIPTOR_VERSION;
  kind: typeof MIUUYY_LAUNCHER_DESCRIPTOR_KIND;
  profile: "production";
  pid: number;
  endpoint: string;
  control: {
    endpoint: string;
    token: string;
  };
  helper: {
    executable: string;
    script: string;
  };
  partition: "persist:codex-web-gpt-chatgpt";
  idleUrl: "about:blank#codex-web-gpt-browser-host";
  surfaceId: string;
  createdAt: string;
}
