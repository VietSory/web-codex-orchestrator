import type { ExecutionErrorCode } from "./contracts.js";

export class ExecutionContractError extends Error {
  constructor(readonly code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionContractError";
  }
}

export function isExecutionContractError(error: unknown): error is ExecutionContractError {
  return error instanceof ExecutionContractError;
}

export class ExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ExecutionError";
  }
}

export function isExecutionError(error: unknown): error is ExecutionError {
  return error instanceof ExecutionError;
}
