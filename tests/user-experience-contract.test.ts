import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFirstRunConfig } from "../src/setup/first-run.js";
import { writeProviderPreferences } from "../src/setup/provider-preferences.js";
import { ensureChatGptLogin } from "../src/runtime/chatgpt-login.js";

async function text(pathname: string): Promise<string> {
  return await readFile(new URL(`../${pathname}`, import.meta.url), "utf8");
}

test("fresh user configuration leaves the normal Web transport implicit", () => {
  const config = buildFirstRunConfig({
    root: "/tmp/wco-user-contract",
    repository_id: "wco-user-contract",
    remote: "origin",
    remote_url: "https://github.com/example/wco-user-contract.git",
    expected_remote_urls: ["https://github.com/example/wco-user-contract.git"],
    base_branch: "main",
    base_commit: "a".repeat(40),
    github_repository: "example/wco-user-contract",
  } as any, {
    suggested_commands: [{ id: "test", executable: "npm", args: ["test"] }],
  } as any);
  assert.equal(config.web_bridge, undefined);
});

test("authoritative docs freeze first-party ChatGPT Web browser PAIR", async () => {
  const [readme, contract, bridge, operations, architecture] = await Promise.all([
    text("README.md"),
    text("docs/user-experience-contract.md"),
    text("docs/web-bridge.md"),
    text("docs/operations.md"),
    text("docs/architecture.md"),
  ]);

  assert.match(readme, /npm install -g \.\/web-codex-orchestrator-[^\s`]+\.tgz/);
  for (const source of [readme, contract, bridge, operations, architecture]) {
    assert.match(source, /WCO[- ]owned Windows (?:browser )?companion|WCO Windows companion/i);
    assert.match(source, /Temporary Chat/i);
  }
  for (const source of [contract, bridge]) {
    assert.match(source, /no `web_bridge` field|no `web_bridge`/i);
    assert.match(source, /chatgpt-web/i);
    assert.match(source, /Codex provider(?:\/model)? turns[^\n]*0|Codex provider\/model turns\s*=\s*0/i);
    assert.match(source, /manual browser interactions[^\n]*0/i);
    assert.match(source, /never\s+silently\s+fall\s+back|never a silent fallback|must not silently fall back/i);
  }
  assert.doesNotMatch(readme, /delegates authorization to its \*\*bundled official Codex runtime\*\*/i);
  assert.doesNotMatch(bridge, /Browser DOM automation.*not supported normal transports/i);
});

test("normal TUI presents first-party browser PAIR without Codex-auth wording", async () => {
  const interactive = await text("src/tui/interactive-app.ts");
  assert.match(interactive, /ChatGPT Web browser PAIR/);
  assert.match(interactive, /Normal PAIR uses the WCO Windows browser companion/);
  assert.match(interactive, /Codex provider authentication is not required/);
  assert.match(interactive, /ChatGPT Web browser PAIR transport is unavailable/);
  assert.match(interactive, /The selected ChatGPT transport is not ready/);
  assert.doesNotMatch(interactive, /local ChatGPT\/Codex|official Codex sign-in may open once|ChatGPT\/Codex is not ready/);
});

test("browser-selected auth preflight returns before any Codex runtime command", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-browser-auth-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const explicitState = path.join(root, "explicit", "state");
  await writeProviderPreferences(explicitState, "chatgpt-web");
  let codexCommands = 0;
  const runCommand = async () => {
    codexCommands += 1;
    return 99;
  };

  const explicit = await ensureChatGptLogin({
    config: { runtime: { source: "bundled" } } as any,
    stateDirectory: explicitState,
    runCommand,
  });
  assert.equal(explicit, true);
  assert.equal(codexCommands, 0, "explicit chatgpt-web PAIR must not execute Codex auth commands");

  const missingPreferenceState = path.join(root, "upgrade-recovery", "state");
  const recovery = await ensureChatGptLogin({
    config: { runtime: { source: "bundled" } } as any,
    stateDirectory: missingPreferenceState,
    runCommand,
  });
  assert.equal(recovery, true);
  assert.equal(codexCommands, 0, "missing preferences must not become permission to spend Codex quota");
});

test("local background execution performs provider preflight and readiness before task ownership", async () => {
  const [interactive, login] = await Promise.all([
    text("src/tui/interactive-app.ts"),
    text("src/runtime/chatgpt-login.ts"),
  ]);
  const launchStart = interactive.indexOf("const launchNewTask");
  const authStart = interactive.indexOf("ensureLocalBackgroundAuthorization", launchStart);
  const readinessStart = interactive.indexOf("ensureTaskReadiness", authStart);
  const taskStart = interactive.indexOf("taskSlot.start", readinessStart);
  assert.ok(launchStart >= 0 && authStart > launchStart && readinessStart > authStart && taskStart > readinessStart);
  assert.match(interactive.slice(launchStart, taskStart), /ensureTaskReadiness\(mode, "start"\)/);
  assert.match(login, /browserProviderSelected\(options\.stateDirectory\).*return true/s);
  assert.match(login, /input\.isRaw !== true/);
  assert.match(login, /two terminal readers|raw-mode parent TUI/i);
});

test("PAIR clarification preserves single-owner execution by pausing before durable clarification", async () => {
  const interactive = await text("src/tui/interactive-app.ts");
  const clarifyStart = interactive.indexOf("clarify: async (value)");
  const clarifyEnd = interactive.indexOf("command: async", clarifyStart);
  const clarifyBlock = interactive.slice(clarifyStart, clarifyEnd);
  const pauseIndex = clarifyBlock.indexOf("taskSlot.pauseAndWait()");
  const rereadIndex = clarifyBlock.indexOf("readLocalWorkerSession", pauseIndex);
  const appendIndex = clarifyBlock.indexOf("appendLocalClarification", rereadIndex);
  const resumeIndex = clarifyBlock.indexOf("continueAfterClarificationPause", appendIndex);
  assert.ok(clarifyStart >= 0 && clarifyEnd > clarifyStart);
  assert.ok(pauseIndex >= 0 && rereadIndex > pauseIndex && appendIndex > rereadIndex && resumeIndex > appendIndex);
  assert.match(clarifyBlock, /if \(latest\.sealed\)/);
  assert.match(clarifyBlock, /The plan locked before that detail could be added/);
});

test("explicit task replacement confirmation is bound to the exact current session", async () => {
  const [interactive, localWorker] = await Promise.all([
    text("src/tui/interactive-app.ts"),
    text("src/web-bridge/local-worker.ts"),
  ]);
  assert.match(interactive, /const confirmTaskReplacement = async/);
  assert.match(interactive, /move it out of current focus but keep its durable history/);
  assert.match(interactive, /expectedCurrentSessionId/);
  const newStart = interactive.indexOf('if (command === "/new")');
  const autoStart = interactive.indexOf('if (command === "/auto")', newStart);
  assert.match(interactive.slice(newStart, autoStart), /confirmTaskReplacement\("PAIR"\)/);
  assert.match(interactive.slice(newStart, autoStart), /confirmation\.expectedCurrentSessionId/);
  assert.match(interactive.slice(autoStart), /confirmTaskReplacement\("AUTOPILOT"\)/);
  assert.match(localWorker, /assertExpectedCurrentSession/);
  assert.match(localWorker, /focus changed after confirmation/i);
});

test("PAIR status and review stay read-only while presenting durable lifecycle evidence", async () => {
  const interactive = await text("src/tui/interactive-app.ts");
  const statusStart = interactive.indexOf('if (command === "/status")');
  const reviewStart = interactive.indexOf('if (command === "/review")', statusStart);
  const durablePauseStart = interactive.indexOf('if (command === "/pause")', reviewStart);
  assert.ok(statusStart >= 0 && reviewStart > statusStart && durablePauseStart > reviewStart);
  const statusBlock = interactive.slice(statusStart, reviewStart);
  assert.match(statusBlock, /readLifecycleSnapshot/);
  assert.match(statusBlock, /formatPairStatus/);
  assert.doesNotMatch(statusBlock, /runControlCommand|startAndDriveTask|drivePairHarnessToCodeReview|driveAutopilotJob/);
  const reviewBlock = interactive.slice(reviewStart, durablePauseStart);
  assert.match(reviewBlock, /reviewSummary/);
  assert.doesNotMatch(reviewBlock, /runControlCommand|startAndDriveTask|drivePairHarnessToCodeReview|driveAutopilotJob/);
});

test("normal status presenters always expose the user's required action and teach canonical continuation", async () => {
  const [pair, autopilot] = await Promise.all([
    text("src/tui/pair-presenter.ts"),
    text("src/tui/autopilot-presenter.ts"),
  ]);
  assert.match(pair, /Your action/);
  assert.match(pair, /None — WCO is applying the requested review fixes/);
  assert.match(autopilot, /Your action/);
  assert.match(autopilot, /review the Draft PR and merge when ready/);
  assert.match(autopilot, /use \/continue to continue/i);
  assert.doesNotMatch(autopilot, /use \/run to continue/i);
});

test("history inspection stays read-only while resume is a separate re-attested authority transition", async () => {
  const [interactive, history] = await Promise.all([
    text("src/tui/interactive-app.ts"),
    text("src/web-bridge/session-history.ts"),
  ]);
  const historyStart = interactive.indexOf('if (command === "/history")');
  const historyBlock = interactive.slice(historyStart);
  assert.match(historyBlock, /Use \/history <number> for details/);
  assert.match(historyBlock, /History #/);
  assert.doesNotMatch(historyBlock, /restoreLocalTaskHistoryFocus|startLocalAuthoring|drivePairHarnessToCodeReview|driveAutopilotJob/);
  assert.match(interactive, /const resumeHistoryItem = async/);
  assert.match(interactive, /restoreLocalTaskHistoryFocus/);
  assert.match(interactive, /expectedCurrentSessionId/);
  assert.match(history, /archiveLocalTaskHistory/);
  assert.match(history, /readRunLedger/);
  assert.match(history, /readRunReceipt/);
  assert.match(history, /assertBoundedStateArtifact/);
  assert.match(history, /CURRENT_SESSION_ID/);
  assert.match(history, /current task focus changed after confirmation/i);
  assert.match(history, /canonical run receipt/i);
  assert.match(history, /repository base/i);
  assert.match(history, /history JSON itself as workflow authority/i);
});

test("continue is current-only while resume is always explicit saved-task selection", async () => {
  const [interactive, slash] = await Promise.all([
    text("src/tui/interactive-app.ts"),
    text("src/tui/slash-commands.ts"),
  ]);
  assert.match(slash, /Continue only the current unfinished saved task/);
  assert.doesNotMatch(slash, /most recent safely resumable/i);
  assert.match(slash, /\/resume/);
  assert.doesNotMatch(slash.match(/SLASH_COMMANDS = \[[\s\S]*?\] as const/)?.[0] ?? "", /\["\/run"/);
  assert.match(interactive, /command === "\/continue" \|\| command === "\/run"/);
  assert.match(interactive, /const continueBestTask = async/);
  const resumeStart = interactive.indexOf("const resumeFromHistory = async");
  const displayStart = interactive.indexOf("const displayUserStatus", resumeStart);
  const resumeBlock = interactive.slice(resumeStart, displayStart);
  assert.match(resumeBlock, /recentTaskHistory\(\)/);
  assert.doesNotMatch(resumeBlock, /currentTaskIsPaused|clearPairPauseIfNeeded\(latest\).*launchSavedTask/s);
  assert.match(interactive, /latest\?\.state === "BLOCKED"/);
  assert.match(interactive, /Use \/resume only if you intentionally want to switch/i);
});

test("background execution remains single-owner and command discovery exposes only live-valid read/control commands", async () => {
  const [interactive, session, slash] = await Promise.all([
    text("src/tui/interactive-app.ts"),
    text("src/tui/session.ts"),
    text("src/tui/slash-commands.ts"),
  ]);
  assert.match(interactive, /LIVE_BACKGROUND_COMMANDS = new Set\(\["\/status", "\/review", "\/task", "\/history", "\/pause", "\/help", "\/quit"\]\)/);
  assert.match(interactive, /background && !LIVE_BACKGROUND_COMMANDS\.has\(command\)/);
  assert.match(interactive, /availableCommands: background \? \[\.\.\.LIVE_BACKGROUND_COMMANDS\] : undefined/);
  assert.match(interactive, /commandPalette\(background \? LIVE_BACKGROUND_COMMANDS : undefined\)/);
  assert.doesNotMatch(interactive.match(/LIVE_BACKGROUND_COMMANDS = new Set\([^\n]+/)?.[0] ?? "", /\/new|\/auto|\/run|\/continue|\/resume|\/mode|\/config|\/web|\/uninstall/);
  assert.match(session, /allowedCommands/);
  assert.match(slash, /commandAllowed/);
});

test("interactive terminal separates interrupt from exit, preserves multiline input, and offers bounded reverse history search", async () => {
  const session = await text("src/tui/session.ts");
  assert.match(session, /WCO_COMPOSER_INTERRUPT/);
  assert.match(session, /WCO_COMPOSER_EXIT/);
  assert.match(session, /interruptRequest/);
  assert.match(session, /key\.ctrl && key\.name === "j"/);
  assert.match(session, /key\.ctrl && key\.name === "r"/);
  assert.match(session, /findReverseHistoryMatch/);
  assert.match(session, /MAX_SESSION_HISTORY = 100/);
  assert.match(session, /key\.shift/);
  assert.match(session, /replace\(\/\\r\\n\?\/gu, "\\n"\)/);
});

test("advanced compatibility profiles stay foreground so they never race the live composer for stdin", async () => {
  const interactive = await text("src/tui/interactive-app.ts");
  assert.match(interactive, /if \(!isLocal\(\)\) return await startAndDriveTask/);
  assert.match(interactive, /if \(!isLocal\(\)\) return await runSavedTask/);
});

test("normal path keeps mutation and shipment authority local and human-owned", async () => {
  const contract = await text("docs/user-experience-contract.md");
  const bridge = await text("docs/web-bridge.md");
  assert.match(contract, /Harness remains the only mutation authority/i);
  assert.match(contract, /human alone decides merge\/release/i);
  assert.match(contract, /automatic merge\/release\s+=\s*0/i);
  assert.match(bridge, /WCO parses provider output|WCO\/Harness revalidates|WCO validates/i);
  assert.match(bridge, /human merge\/release/i);
});

test("advanced compatibility profiles remain explicit", async () => {
  const bridge = await text("docs/web-bridge.md");
  assert.match(bridge, /web_native_mcp/);
  assert.match(bridge, /managed_actions/);
  assert.match(bridge, /manual_file/);
  assert.match(bridge, /explicit `web_bridge` profiles|advanced compatibility profiles/i);
});
