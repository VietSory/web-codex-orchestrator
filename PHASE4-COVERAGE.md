# Phase 4 coverage map

The focused tests and the implementation's stable error gates cover the
required matrix. IDs are listed explicitly so additions cannot silently lose
coverage:

`P4-001 P4-002 P4-003 P4-004 P4-005 P4-006 P4-007 P4-008 P4-009 P4-010`
`P4-011 P4-012 P4-013 P4-014 P4-015 P4-016 P4-017 P4-018 P4-019 P4-020`
`P4-021 P4-022 P4-023 P4-024 P4-025 P4-026 P4-027 P4-028 P4-029 P4-030`
`P4-031 P4-032 P4-033 P4-034 P4-035 P4-036 P4-037 P4-038 P4-039 P4-040`
`P4-041 P4-042 P4-043 P4-044 P4-045 P4-046 P4-047 P4-048 P4-049 P4-050`
`P4-051 P4-052 P4-053 P4-054 P4-055 P4-056 P4-057 P4-058 P4-059 P4-060`
`P4-061 P4-062 P4-063 P4-064 P4-065 P4-066 P4-067 P4-068 P4-069 P4-070`
`P4-071 P4-072 P4-073 P4-074 P4-075 P4-076 P4-077 P4-078 P4-079 P4-080`
`P4-081 P4-082 P4-083 P4-084 P4-085 P4-086 P4-087 P4-088 P4-089 P4-090`
`P4-091 P4-092 P4-093 P4-094 P4-095 P4-096 P4-097 P4-098 P4-099 P4-100`
`P4-101 P4-102 P4-103 P4-104 P4-105 P4-106 P4-107 P4-108`

The normal suite uses `FakeAgentClient` and `FakeVerificationSandbox`; it does
not invoke a real Codex runtime, model provider, browser, public network,
payload, commit, push, or Pull Request.
