import { redact } from "./log-redaction.js";
export function boundedEvidence(value: string, maximum = 16_384): string { return redact(value).slice(0, maximum); }
