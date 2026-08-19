# Cognitum Spaces user guide

Cognitum Spaces is the governed spatial world model used by RuView and
`radio-moe`. RuView keeps raw RF/CSI and perception processing local. Cognitum
receives only permitted P2/P3 semantic state: sites, buildings, floors,
rooms/spaces, zones, anonymous entities, semantic events, and alerts.

The integration is read-only. Reading a Space can inform an observation or
recommendation, but it cannot publish state, approve a policy, command a device,
or actuate anything.

## Capabilities

| Capability | Legacy `/v1/spaces` | Versioned `/v1/spatial/*` | `radio-moe` behavior |
|---|---|---|---|
| Current room/space twins | Yes | Yes, as `spaces` | Strictly validates P2/P3 and the local-edge boundary |
| Sites, buildings, floors, zones | No | Yes | Paged, typed, read-only |
| Anonymous entities | No | Yes | Rejects person/track data without `identityMode=anonymous` |
| Semantic events and alerts | No | Yes | Preserves message/sequence lineage |
| Raw CSI, CIR, RF tensors, recordings, pose, vitals, identity observations | No | No | Rejects forbidden aliases at every nesting depth |
| OAuth activation | `spaces:read` | `spaces:read` | Bearer token supplied by the caller |
| API-key compatibility | Yes | Yes, with an explicit workspace UUID | Reads `COGNITUM_SPACES_API` only at call time |
| Writes or actuator commands | Not exposed | Not exposed | No client method exists |

## Install

```bash
npm install radio-moe
```

## Authenticate

For an end user, activate RuView with Cognitum OAuth:

```bash
wifi-densepose login --spaces
wifi-densepose whoami
```

The public client uses Authorization Code + PKCE and requests
`sensing:read spaces:read`. Pass the resulting access token to your process by
your normal secret channel; do not put it in source, logs, URLs, or a gist.

For service compatibility, set an API key without printing it:

```bash
export COGNITUM_SPACES_API='cog_...'
```

OAuth is preferred for end-user activation. API-key versioned reads require an
explicit workspace UUID because an API key does not carry the signed workspace
claim that an OAuth access token carries.

## Read current Space twins

```ts
import {
  CognitumSpacesClient,
  envApiKeyAuth,
} from 'radio-moe';

const spaces = new CognitumSpacesClient({ auth: envApiKeyAuth() });
const result = await spaces.listSpacesResult();

console.log(result.data.map(({ id, name, status }) => ({ id, name, status })));
console.log(result.boundary.excluded); // raw sensing that remains local
```

Credentials are resolved when the request is made, so key rotation does not
require constructing a new client. The client requires HTTPS except for an
explicit loopback test origin, rejects redirects and ambiguous credentials,
bounds response time/size/shape, and validates the reported local-edge privacy
boundary.

## Page versioned resources

```ts
import {
  CognitumSpacesClient,
  bearerAuth,
  spatialResourceToObservation,
} from 'radio-moe';

const client = new CognitumSpacesClient({
  auth: bearerAuth(() => process.env.COGNITUM_OAUTH_ACCESS_TOKEN),
});

let cursor: string | undefined;
do {
  const page = await client.listSpatial('events', { limit: 50, cursor });
  for (const resource of page.data) {
    const observation = spatialResourceToObservation(resource);
    // Pass through admitObservation before using it as a fact.
    console.log(observation.kind, observation.lineage);
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

With API-key auth, add `workspaceId`:

```ts
await client.listSpatial('alerts', {
  workspaceId: '00000000-0000-4000-8000-000000000000',
  limit: 25,
});
```

Cursors are opaque and kind-bound. Do not edit or reuse a cursor for another
collection.

## Observation admission

`spatialResourceToObservation` marks every cloud-derived record with
`lineage.derived=true`. It carries tenant, message, sequence, and provenance
references forward without turning cloud recollection into new sensing
authority. Missing calibration identity, confidence, provenance, or expiry
remains missing; `admitObservation` then rejects the record instead of
inventing trust.

This is the expected flow:

```text
local RuView sensing
  -> bounded P2/P3 semantic event
  -> Cognitum tenant/workspace history
  -> read-only radio-moe observation
  -> fail-closed observation admission
  -> observe or recommend
  -> separate policy approval for any consequential execution
```

## Troubleshooting

- `HTTP 401`: the credential is absent, expired, malformed, or not a supported
  API key/RuView access token.
- `HTTP 403`: OAuth is missing `spaces:read`, the client/audience is wrong, or
  the workspace binding is not authorized.
- `API-key spatial reads require workspace id`: supply the tenant's workspace
  UUID; do not guess it.
- `forbidden raw field`: the server response contained a field that violates
  the semantic-only cloud boundary. Treat this as a privacy failure.
- `invalid spatial resource`: hierarchy, UUID, timestamp, entity privacy,
  confidence, or schema-version validation failed. Do not coerce the record.
- An empty list is valid and means no authorized state is present; it is not
  proof that a site is empty.

## Security boundary

- Keep tokens and keys out of command history, source, screenshots, and logs.
- Do not interpret OAuth consent as write, approval, or actuator authority.
- Do not forward raw sensing into `attributes` or `provenance`.
- Treat `observedAt` and `expiresAt` as the freshness authority; retrieval
  time does not refresh an observation.
- Preserve tenant/workspace separation when caching or embedding history.

The design of record is
[ADR-402](../../../docs/adr/ADR-402-ruview-cognitum-spaces-spatial-intelligence.md).
