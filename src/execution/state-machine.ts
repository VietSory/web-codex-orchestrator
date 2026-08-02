import type { ExecutionState } from "./contracts.js";
import { EXECUTION_STATES } from "./contracts.js";
import { ExecutionError } from "./errors.js";

const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  READY_FOR_CODEX: ["CODEX_PREFLIGHT", "INTERRUPTED", "FAILED"],
  CODEX_PREFLIGHT: ["TERRA_ASSESSING", "POLICY_BLOCKED", "HUMAN_REQUIRED", "FAILED", "INTERRUPTED"],
  TERRA_ASSESSING: ["TERRA_IMPLEMENTING", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "POLICY_BLOCKED", "AGENT_FAILED", "BUDGET_EXHAUSTED", "FAILED", "INTERRUPTED"],
  TERRA_IMPLEMENTING: ["POLICY_CHECKING", "TERRA_FIXING", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "POLICY_BLOCKED", "AGENT_FAILED", "BUDGET_EXHAUSTED", "FAILED", "INTERRUPTED"],
  POLICY_CHECKING: ["VERIFYING", "TERRA_FIXING", "POLICY_BLOCKED", "FAILED", "INTERRUPTED"],
  VERIFYING: ["TERRA_REVIEWING", "TERRA_FIXING", "VERIFICATION_FAILED", "BUDGET_EXHAUSTED", "FAILED", "INTERRUPTED"],
  TERRA_FIXING: ["TERRA_IMPLEMENTING", "BUDGET_EXHAUSTED", "AGENT_FAILED", "FAILED", "INTERRUPTED"],
  TERRA_REVIEWING: ["SOL_REVIEWING", "TERRA_FIXING", "WEB_REVIEW_REQUIRED", "HUMAN_REQUIRED", "AGENT_FAILED", "BUDGET_EXHAUSTED", "FAILED", "INTERRUPTED"],
  SOL_REVIEWING: ["READY_FOR_PUBLISH", "TERRA_FIXING", "WEB_REVIEW_REQUIRED", "HUMAN_REQUIRED", "AGENT_FAILED", "BUDGET_EXHAUSTED", "FAILED", "INTERRUPTED"],
  READY_FOR_PUBLISH: [],
  REPLAN_REQUIRED: [], WEB_REVIEW_REQUIRED: [], HUMAN_REQUIRED: [], POLICY_BLOCKED: [],
  VERIFICATION_FAILED: ["TERRA_FIXING", "FAILED"], AGENT_FAILED: ["TERRA_FIXING", "FAILED"],
  BUDGET_EXHAUSTED: [], INTERRUPTED: ["CODEX_PREFLIGHT", "TERRA_FIXING"], FAILED: [],
};

export function isExecutionState(value: unknown): value is ExecutionState {
  return typeof value === "string" && (EXECUTION_STATES as readonly string[]).includes(value);
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransition(from, to)) throw new ExecutionError("EXECUTION_STATE_INVALID", `transition ${from} -> ${to} is not allowed`);
}

export function allowedTransitions(from: ExecutionState): readonly ExecutionState[] {
  return transitions[from] ?? [];
}

export class ExecutionStateMachine {
  constructor(public state: ExecutionState) {}
  transition(to: ExecutionState): ExecutionState {
    assertTransition(this.state, to);
    this.state = to;
    return this.state;
  }
}
