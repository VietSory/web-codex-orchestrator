import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface SecretPromptReadline {
  question(prompt: string): Promise<string>;
  _writeToOutput?(value: string): void;
}

export async function questionWithoutEcho(
  readline: SecretPromptReadline,
  prompt: string,
  write: (value: string) => void,
): Promise<string> {
  const original = readline._writeToOutput;
  let terminalFd: number | undefined;
  let terminalEchoDisabled = false;
  if (process.platform !== "win32" && process.stdin.isTTY) {
    try {
      terminalFd = openSync("/dev/tty", "r+");
      terminalEchoDisabled = spawnSync("stty", ["-echo"], { stdio: [terminalFd, "ignore", "ignore"], shell: false }).status === 0;
    } catch { /* readline suppression remains the portable fallback */ }
  }
  write(prompt);
  if (typeof original === "function") readline._writeToOutput = () => undefined;
  try {
    return await readline.question("");
  } finally {
    if (typeof original === "function") readline._writeToOutput = original;
    if (terminalEchoDisabled && terminalFd !== undefined) spawnSync("stty", ["echo"], { stdio: [terminalFd, "ignore", "ignore"], shell: false });
    if (terminalFd !== undefined) closeSync(terminalFd);
    write("\n");
  }
}
