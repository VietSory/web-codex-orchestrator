# WCO Artifact Registry

## Rule

**Web sends no executable artifact outside the registry. WCO accepts no executable artifact outside the registry.**

The registry is content-addressed. Authority comes from immutable registration records bound to exact artifact bytes and an exact canonical run, not from a mutable filename, chat message, branch name, or latest-file convention.

## Registered artifact identity

A Phase 9 Web implementation pack is addressed by:

```text
run_id + artifact_sha256
```

`run_id` already binds the accepted Task Bundle SHA-256. `artifact_sha256` binds the complete Web implementation ZIP.

Canonical path:

```text
<state>/authority/runs/<task-id>/<task-bundle-sha256>/artifacts/<artifact-sha256>/
  web-implementation-pack.zip
  registration.json
```

## Registration record

`registration.json` binds:

- artifact kind/version;
- exact archive SHA-256 and byte size;
- canonical run/task/Task Bundle identity;
- Web pack ID;
- repository ID/base branch/base commit/tree SHA;
- spec/inventory/read-coverage/project-map/source/preimage/architecture/acceptance/prohibited-change/operations digests;
- implementation manifest SHA-256;
- registration timestamp.

A record at an existing content-addressed path may only be adopted when the bytes are identical. Different bytes at the same immutable path are an integrity conflict.

## No mutable registry authority

WCO may later maintain indexes for UX/performance, but an index is derived state only. Deleting or corrupting an index must not alter which artifacts are authoritative. The canonical registry can be reconstructed by scanning and validating immutable registration directories.

## Consumers

- Phase 9 registers Web implementation packs.
- Phase 10 may apply code **only** from a valid registration record and its matching archive.
- Later Web response/revision/mission artifacts must use the same content-addressed principle.

## Forbidden shortcuts

The following never create authority:

- a chat message saying a patch is approved;
- a loose `.patch` file beside the state directory;
- replacing a ZIP in-place;
- editing `registration.json`;
- renaming an unregistered archive to a known filename;
- selecting the newest artifact by mtime;
- trusting a derived index without revalidating the immutable record.
