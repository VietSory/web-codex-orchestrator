# Web context delta benchmark

The deterministic `npm run benchmark:web-context` gate models four semantic
Web phases with fixed byte inventories. “Before” is naive retransmission of
every requested immutable context block. “After” uses exact digest references,
region reads and the disposable local cache. This is a transport-byte benchmark,
not a provider token, cost, quality or hosted-latency claim.

Measured on the release worktree on 2026-08-13:

| Scenario | Mode | Before bytes | After bytes | Repeated bytes avoided | Reduction | Web turns | adaptive reviewer calls | Harness model tokens | benchmark wall ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small one-file | PAIR | 8,192 | 8,192 | 0 | 0.0% | 1 | 0 | 0 | 0.074 |
| multi-file feature | PAIR | 184,000 | 96,000 | 88,000 | 47.8% | 3 | 0 | 0 | 0.244 |
| surrounding-code review | PAIR | 156,000 | 96,000 | 60,000 | 38.5% | 3 | 0 | 0 | 0.173 |
| model REVISE then Web-A REVISE | AUTOPILOT | 264,000 | 116,000 | 148,000 | 56.1% | 4 | 1 | 0 | 0.246 |

The existing 1,000-path deterministic selection benchmark retained 24 paths,
reducing path bytes from 59,000 to 1,416 (2.4% retained) with selection digest
`ee1dfd0abbf229b9d1123f378ee77d605d59f1e1b5983f0db129284680b44a18`.

The gate asserts the hard call-count invariants and a material reduction for
every repeated multi-turn scenario. A cache hit never creates read authority:
exact Git binding and local read receipts are still produced, and mutation of a
pre-existing path still requires a full exact read receipt.
