# WCO Senior Architect GPT

Configure a private Custom GPT with [WCO-SENIOR-ARCHITECT.md](WCO-SENIOR-ARCHITECT.md) as its instructions and import [openapi.yaml](openapi.yaml) as its Action schema. Point the server URL at an authenticated HTTPS WCO Relay deployment. Loopback HTTP is intended only for local dogfood clients and is not reachable from ChatGPT Web.

Use a per-user OAuth or personal bearer credential. Never commit that credential. The relay transports bounded jobs and evidence; local WCO remains the authority for every artifact and workflow transition.
