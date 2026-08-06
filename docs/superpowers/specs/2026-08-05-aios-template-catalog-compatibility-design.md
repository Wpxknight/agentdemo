# AIOS Template Catalog Compatibility Design

## Problem

The deployed AIOS `GET /templates` endpoint returns the standard E2B template fields but does not
include AIOP's additive `aios` metadata object. AIOP currently requires that object, rejects every
otherwise valid template, and marks the catalog unavailable.

## Compatibility policy

- Continue to consume the existing top-level AIOS/E2B fields: `templateID`, `names`, `aliases`, and
  `buildStatus`.
- When `aios` is absent, install the ready template as a least-privilege code profile:
  - `description`: first normalized display name
  - `envType`: `code`
  - `runtimeRole`: `sandbox-reader`
  - `image`: empty because creation is selected by `templateID`
  - no template-level timeout override
- When `aios` is present, keep strict validation. Malformed or unknown metadata must be rejected and
  must never fall back to a reader profile.
- Never infer browser or diagnostic privileges from template names, aliases, image names, or other
  mutable display data.
- Keep the existing ready-status filtering, normalization, duplicate handling, stable sorting, and
  catalog fingerprint behavior.

## Security boundary

Compatibility only reduces capabilities. A legacy template cannot become a browser template,
diagnostic template, privileged profile, or platform-admin-only profile without valid explicit
metadata. This prevents a malformed privileged declaration from being silently downgraded into an
accessible template while also preventing name-based privilege inference.

## Observability

A catalog containing accepted legacy entries emits one sanitized warning with the compatibility
class and entry count, avoiding one warning per template on every background refresh. Template IDs,
names, images, response bodies, and credentials remain absent from the log payload.

## Testing

Tests cover a catalog containing the current legacy response shape, mixed legacy/extended entries,
and a present-but-malformed `aios` object. Existing strict metadata and error-sanitization tests
remain authoritative.
