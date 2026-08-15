# Optional Cloudflare personal relay adapter

This is one free reference adapter for the platform-neutral WCO RelayProtocol.
It uses a `workers.dev` TLS endpoint and one SQLite-backed Durable Object. It is
not required by WCO; another compatible HTTPS relay can be selected.

The Worker is a bounded authenticated mailbox only. It has no filesystem,
shell, Git, verifier, repository-mutation, approval, publication, merge or
release capability. `WCO_RELAY_TOKEN` must be installed as a Worker secret,
never as a checked-in variable.

`wco web setup --personal` materializes the exact GPT Action assets after a
compatible relay is reachable. A future provider adapter can implement the
same deployment boundary without changing `WebBridge` or Harness authority.

Deployment is intentionally a provider-authorized human boundary. Authenticate
the Cloudflare CLI, create the Durable Object from `wrangler.jsonc`, install
`WCO_RELAY_TOKEN` with the provider's secret command, and deploy `worker.mjs`.
Do not pass the secret on a command line, place it in `wrangler.jsonc`, or post
it to ChatGPT. Copy only the resulting `https://*.workers.dev` origin into
`wco web setup --personal`. Free-plan availability and account entitlement must
be confirmed in the provider account; WCO never upgrades or purchases a plan.
