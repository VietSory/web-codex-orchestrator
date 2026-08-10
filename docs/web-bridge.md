# ChatGPT Web bridge

WCO v0.3 integrates ChatGPT Web through an explicit Custom GPT Action and authenticated WCO Relay. It does not scrape or automate the ChatGPT DOM.

The relay is bounded durable transport. It can queue authoring/review jobs, repository read requests, structured submissions and verdicts. It cannot validate a Task Bundle, accept an implementation, apply code, advance canonical run state, publish, or merge.

Local WCO reads only Git objects at the sealed base commit for Web authoring. Tree/search/file responses have count, byte and time limits; `.env`, keys, credentials, secrets and Git metadata are denied. Every file read creates a local read-coverage receipt. A replacement or deletion cannot enter a canonical Web Implementation Pack without a full exact read receipt and locally derived preimage.

Configure the GPT with the files under `web/gpt/`. Use OAuth for hosted deployments or a per-user bearer credential for private dogfood. Store the credential outside repositories; `WCO_RELAY_TOKEN` is supported by the reference client/server.

`wco web status` verifies relay state. `wco web open` only opens the configured URL and never claims that opening a browser established a connection. `manual_file` remains available as an offline/backward-compatible transport, and all v0.2 manual bundle/pack/verdict commands remain supported.
