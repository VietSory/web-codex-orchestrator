import type { IntakeErrorCode } from "./contracts.js";

export class IntakeError extends Error {
  constructor(
    readonly code: IntakeErrorCode,
    message: string,
    readonly entry?: string,
  ) {
    super(message);
    this.name = "IntakeError";
  }
}

export function isIntakeError(error: unknown): error is IntakeError {
  return error instanceof IntakeError;
}
