#!/usr/bin/env bash
set -euo pipefail

: "${AIOP_NAMESPACE:?Set AIOP_NAMESPACE explicitly}"

kubectl_cmd=("${KUBECTL:-kubectl}")
if [[ -n "${AIOP_KUBECONFIG:-}" ]]; then
  kubectl_cmd+=(--kubeconfig "$AIOP_KUBECONFIG")
fi
kube() { "${kubectl_cmd[@]}" -n "$AIOP_NAMESPACE" "$@"; }

revision_args=()
if [[ -n "${ROLLBACK_REVISION:-}" ]]; then
  [[ "$ROLLBACK_REVISION" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s\n' 'ROLLBACK_REVISION must be a positive integer' >&2
    exit 1
  }
  revision_args+=(--to-revision="$ROLLBACK_REVISION")
fi

# The dry-run materializes the target ReplicaSet template without changing cluster state.
# Old images that only understand string user IDs have no compatibility annotation and are rejected.
target_schema="$(kube rollout undo deployment/aiop-server "${revision_args[@]}" --dry-run=server \
  -o jsonpath='{.spec.template.metadata.annotations.aiop\.bocloud\.com/schema-compatibility}')"
if [[ "$target_schema" != positive-user-ids-v1 ]]; then
  printf 'Rollback target schema compatibility is %q; expected positive-user-ids-v1. Refusing unsafe rollback.\n' "$target_schema" >&2
  exit 1
fi

# ConfigMaps are not part of Deployment rollout history. Reject a cross-mode rollback because it
# would restore an image/template while leaving the current mode-specific ConfigMap in place.
target_mode="$(kube rollout undo deployment/aiop-server "${revision_args[@]}" --dry-run=server \
  -o jsonpath='{.spec.template.metadata.annotations.aiop\.bocloud\.com/deployment-mode}')"
config_mode="$(kube get configmap/aiop-config \
  -o jsonpath='{.metadata.annotations.aiop\.bocloud\.com/deployment-mode}')"
if [[ -z "$target_mode" || "$target_mode" != "$config_mode" ]]; then
  printf 'Rollback target mode %q does not match active ConfigMap mode %q. Apply the matching config before rollback.\n' \
    "$target_mode" "$config_mode" >&2
  exit 1
fi

kube rollout undo deployment/aiop-server "${revision_args[@]}"
kube rollout status deployment/aiop-server --timeout=300s
