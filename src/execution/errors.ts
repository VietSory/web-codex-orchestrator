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
