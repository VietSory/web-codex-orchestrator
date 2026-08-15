# WCO Web semantic assets

`WCO-SENIOR-ARCHITECT.md` is the canonical semantic instruction set shared by WCO Web transports. The normal single-user path is now `web_native_mcp`: the human creates a private WCO MCP app and private WCO Workspace Agent in official OpenAI/ChatGPT configuration, using this instruction file. WCO then triggers that Workspace Agent programmatically through the official Workspace Agent API while the local WCO MCP server is reached through OpenAI Secure MCP Tunnel.

The checked-in `openapi.yaml` remains only for the optional `managed_actions` / Action-relay compatibility surface. It deliberately uses the reserved `deployment-required.invalid` origin until real managed infrastructure exists and must not be mistaken for the normal Web-native endpoint.

Advanced `personal_actions` users may run `wco web setup --personal`; WCO materializes a separate API-key/Bearer Action schema and instruction bundle under WCO-owned state. That profile is not the default and may require a user-selected RelayProtocol-compatible HTTPS endpoint. No relay secret belongs in a schema, manifest, repository, model context or Result Bundle.

Regardless of transport, Web may retrieve exact bounded context and submit semantic contract/implementation/review envelopes only. The relay/MCP/Workspace-Agent layer is never Harness, Git, merge, deployment or release authority.