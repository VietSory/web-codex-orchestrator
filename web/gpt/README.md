# WCO Senior Architect GPT

These are the canonical Senior Architect instruction/schema templates. The checked-in OpenAPI file is the managed OAuth template. A personal user runs `wco web setup --personal`; WCO safely materializes a separate API-key/Bearer schema and exact instruction bundle under WCO-owned state for the human to add once in the GPT editor.

The checked-in schema deliberately uses the reserved `deployment-required.invalid` origin until real managed infrastructure exists; it is not a usable or claimed production endpoint. Managed deployment replaces it and records only public metadata in `web/managed-service.json`. Personal materialization never edits that managed file. No secret belongs in either schema, manifest, repository or Result Bundle. The relay transports bounded jobs and evidence; local WCO remains the authority for every artifact and workflow transition.
