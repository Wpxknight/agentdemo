# Sandbox Key Selection

## Inputs

Resolve these inputs before selecting a Key:

- `targetClusterId`: cluster required by the agent task.
- `targetClusterKind`: `portal` or `compute`.
- `projectId`: current platform project.
- minimum CPU/memory required by the task; default to the smallest available specification when no larger requirement is stated.
- optional target namespace.

Query enabled Keys for the current user and project. Treat a missing `keyType` as `resource` for compatibility.

Relevant Key fields:

```json
{
  "id": "key-id",
  "status": "enabled",
  "keyType": "resource|generic",
  "projectId": "1001",
  "clusterId": "35",
  "resourceSpecId": 12,
  "resourceSpecInfo": "2c4g",
  "genericSpecId": "1c1g",
  "genericSpecVersion": 1,
  "nativeResources": {
    "requests": { "cpu": "1", "memory": "1Gi" },
    "limits": { "cpu": "1", "memory": "1Gi" }
  }
}
```

## Deterministic algorithm

1. Discard disabled Keys and Keys outside the current project/user scope.
2. Determine requested CPU and memory quantities.
3. A Key fits only when both CPU and memory meet or exceed the request.
4. Sort fitting candidates by CPU ascending, memory ascending, then Key ID ascending.
5. For a Portal target, select the first fitting Generic Key.
6. For a compute target, select the first fitting Resource Key whose `clusterId` equals `targetClusterId`.
7. If step 6 finds none, select the first fitting Generic Key.
8. If no Key fits, report the exact target cluster and minimum resource requirement; do not silently choose an undersized Key or a Resource Key from another cluster.

Use Kubernetes Quantity semantics when comparing values (`500m`, `1`, `1024Mi`, `1Gi`).

## Examples

### Portal target

Available Generic Keys are `1c1g`, `2c4g`, and `4c8g`. A Portal release task has no larger stated requirement.

Result: choose `1c1g` and create with:

```json
{
  "template": "portal-operator-reader",
  "placement": {
    "clusterId": "portal-01",
    "namespace": "portal-system"
  }
}
```

### Compute target with Resource Key

Target cluster is `compute-35`. Enabled Resource Keys include `1c1g` on `compute-21` and `2c4g` on `compute-35`; a Generic `1c1g` is also enabled.

Result: choose the `2c4g` Resource Key on `compute-35`. Cluster affinity takes precedence over the smaller Generic fallback. Placement may be omitted.

### Compute target with Generic fallback

Target cluster is `compute-42`, but no enabled Resource Key is bound to it. Generic Keys `1c1g` and `2c4g` are enabled.

Result: choose the smallest fitting Generic Key and include:

```json
{
  "placement": {
    "clusterId": "compute-42"
  }
}
```

## Runtime-role decision

Use `sandbox-reader` for cluster inventory, Pod/Node inspection, logs, events, and read-only troubleshooting.

Use `sandbox-diag` only for actions requiring privileged node/network access. The selected template carries the role; sandbox creation must not accept caller-provided ServiceAccount, RBAC, privileged flags, capabilities, host namespace flags, or host mounts.

## Failure handling

- Generic Key without `placement.clusterId`: correct the request before retrying.
- Resource Key with mismatched placement: select a same-cluster Resource Key or use a Generic Key; do not retry the mismatch.
- Target cluster unavailable: report it as placement/provider availability, not as a Key-capacity error.
- Generic specification unavailable: refresh the enabled Key/spec list before selecting again.
