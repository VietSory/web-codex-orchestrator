import { runInteractiveSession, terminalIo } from "../../src/tui/session.js";

const io = terminalIo();
const scenario = process.env.WCO_PTY_SCENARIO ?? "interactive";
let active = false;
let sealed = false;

const acceptGoal = async (goal: string): Promise<string> => {
  active = true;
  sealed = false;
  if (scenario === "interactive") {
    setTimeout(() => io.write("BG_PROGRESS · repository scan complete\n"), 1_000);
  }
  return `accepted:${goal}`;
};

await runInteractiveSession(io, {
  state: async () => ({
    active,
    sealed,
    summary: active ? (sealed ? "PAIR · Plan locked" : "PAIR · Understanding goal") : "READY",
  }),
  newTask: acceptGoal,
  clarify: async (value) => `clarified:${value}`,
  command: async (command, args) => {
    if (command === "/new") return { message: args ? await acceptGoal(args) : "Usage: /new <goal>" };
    if (command === "/auto") return { message: args ? await acceptGoal(args) : "Usage: /auto <goal>" };
    if (command === "/status") return { message: "status: ok" };
    if (command === "/quit") return { message: "bye", quit: true };
    return { message: `command:${command}${args ? ` ${args}` : ""}` };
  },
  exitRequest: async () => ({ message: "safe-exit", quit: true }),
});
