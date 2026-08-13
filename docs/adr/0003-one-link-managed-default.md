# ADR 0003 — One-link managed Web authorization is the former normal-user default

Status: **superseded by ADR 0004 for normal-user transport once ADR 0004 release gates pass**.

This ADR is retained as historical and advanced-managed-service documentation. Its maintainer-operated HTTPS control plane is not compatible with the project's current single-user/local-first normal-user requirement because it introduces a WCO-hosted service dependency.

The retained `managed_actions` profile may still be useful for an explicitly selected future multi-user/SaaS deployment. It must never become a silent fallback when `chatgpt_codex` is unavailable.

The authority boundary remains unchanged: managed transport can carry bounded semantic requests/results only; it cannot edit the local repository, execute shell/Git, bypass verification, merge, mark ready, deploy or release. Harness remains the sole mutation/verification authority and humans alone ship.

See `0004-chatgpt-codex-local-default.md` for the authoritative one-authorization local transport decision and release gate.
