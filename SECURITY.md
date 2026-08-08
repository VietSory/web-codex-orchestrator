# Security Policy

WCO is designed around explicit, bounded, reproducible authority. External archives, Web-authored artifacts, repository content, verdict files, model output, and browser/session state are not trusted simply because they exist.

## Security properties

The implementation aims to preserve these properties across normal execution and crash recovery:

- fail closed on ambiguous authority, stale identities, malformed state, or unsupported capabilities;
- validate every security-sensitive handoff against exact run/repository/content identities;
- keep model, verifier, Git, filesystem, and GitHub privileges scoped to the operation that needs them;
- use isolated worktrees and closed-world changed-path policies;
- bound archives, state files, process output, retries, concurrency, model turns, tokens, and diagnostics;
- re-attest commit, remote, Draft PR, Result Bundle, and verdict identities before adopting externally visible work;
- never grant autonomous merge, Mark Ready, auto-merge, deployment, or destructive existing-ref update authority.

The detailed trust model is documented in [docs/architecture.md](docs/architecture.md) and protocol boundaries in [docs/protocols.md](docs/protocols.md).

## Reporting a vulnerability

Do not place credentials, private task content, exploit details, or sensitive repository data in a public issue.

If GitHub's private security-advisory/reporting channel is available for this repository, use it for security-sensitive reports. Non-sensitive hardening suggestions can use the normal issue tracker.

A useful report includes the affected command/component, expected invariant, reproducible input or state shape, observed behavior, and whether the issue can modify a repository, leak data, bypass authority, or cause unbounded resource use.

## Supported versions

WCO is pre-release. Until tagged releases exist, only the current release candidate is actively hardened. After releases begin, this document will list supported versions explicitly.

## Non-goals

WCO does not claim protection against an attacker with unrestricted control of the same OS account who can replace the WCO binary/source, trusted configuration, repository, credentials, and all durable state simultaneously.

WCO also does not patch or redefine security properties of OpenAI Codex, Git, GitHub, the browser, or the operating system. Those are external dependencies whose capabilities are detected and bounded at WCO's interfaces.
