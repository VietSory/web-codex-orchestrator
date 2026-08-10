# WCO Senior Architect GPT

These are maintainer deployment assets for the single managed WCO Senior Architect GPT. End users must never import them or edit a GPT. The maintainer configures [WCO-SENIOR-ARCHITECT.md](WCO-SENIOR-ARCHITECT.md), [openapi.yaml](openapi.yaml), the stable TLS relay, and OAuth once globally.

The checked-in schema deliberately uses the reserved `deployment-required.invalid` origin until real managed infrastructure exists; it is not a usable or claimed production endpoint. At deployment, the maintainer replaces that origin with the one verified stable relay in both the Action/OAuth configuration and `web/managed-service.json`, then publishes the fixed GPT URL. No secret belongs in either file. The relay transports bounded jobs and evidence; local WCO remains the authority for every artifact and workflow transition.
