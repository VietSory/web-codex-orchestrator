import type { AcceptanceResult } from "../execution/contracts.js";
export interface AcceptanceEvidence { acceptance_id: string; status: "PASS" | "FAIL" | "UNVERIFIED"; evidence: string[]; }
export function buildAcceptanceEvidence(results: AcceptanceResult[]): AcceptanceEvidence[] { return results.map((item) => ({ acceptance_id: item.acceptance_id, status: item.status, evidence: item.evidence })); }
