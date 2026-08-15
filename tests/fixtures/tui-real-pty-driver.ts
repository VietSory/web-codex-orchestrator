import { runInteractiveSession, terminalIo } from "../../src/tui/session.js";

const io = terminalIo();
const scenario = process.env.WCO_PTY_SCENARIO ?? "interactive";
let active = false;
let sealed = false;

await runInteractiveSession(io, {
  state: async () => ({
    active,
    sealed,
    summary: active ? (sealed ? "PAIR · Plan locked" : "PAIR · Understanding goal") : "READY",
  }),
  newTask: async (goal) => {
    active = true;
    sealed = false;
    if (scenario === "interactive") {
      setTimeout(() => io.write("BG_PROGRESS · repository scan complete\n"), 1_000);
    }
    return `accepted:${goal}`;
  },
  clarify: async (value) => `clarified:${value}`,
  command: async (command) => {
    if (command === "/status") return { message: "status: ok" };
    if (command === "/quit") return { message: "bye", quit: true };
    return { message: `command:${command}` };
  },
  exitRequest: async () => ({ message: "safe-exit", quit: true }),
});
