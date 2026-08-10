# ChatGPT Web bridge

WCO v0.3 integrates ChatGPT Web through one maintainer-managed Senior Architect GPT, its OAuth Action, and a stable managed WCO Relay. It does not scrape or automate the ChatGPT DOM and uses no undocumented ChatGPT API.

The relay is bounded durable transport. It can queue authoring/review jobs, repository read requests, structured submissions and verdicts. It cannot validate a Task Bundle, accept an implementation, apply code, advance canonical run state, publish, or merge.

Local WCO reads only Git objects at the sealed base commit for Web authoring. Tree/search/file responses have count, byte and time limits; `.env`, keys, credentials, secrets and Git metadata are denied. Every file read creates a local read-coverage receipt. A replacement or deletion cannot enter a canonical Web Implementation Pack without a full exact read receipt and locally derived preimage.

The maintainer configures the GPT once with the files under `web/gpt/`, deploys the relay at a stable TLS origin, and configures OAuth. Each installation creates a one-time, expiring, PKCE-bound device registration. The local credential is scoped to that device/account, refreshable, and stored outside trusted configuration with owner-only permissions. The Action OAuth identity and local device identity select only that account/device's pending work; there is no global “latest task”. Local WCO remains outbound-only.

`wco web connect` performs this managed flow without URL/token questions. `wco web status` verifies authenticated relay state. `wco web open` opens the fixed GPT URL and never claims that opening a browser established a connection. `/web connect --self-hosted` preserves the personal bearer/reference-relay path as an explicit advanced option. `manual_file` remains an offline/backward-compatible transport, and all v0.2 manual bundle/pack/verdict commands remain supported.
