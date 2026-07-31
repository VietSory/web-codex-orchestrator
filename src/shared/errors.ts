export class BundleValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BundleValidationError";
    this.code = code;
  }
}
