from pathlib import Path


TARGET = Path("/app/src/services/k8s/batchsandbox_provider.py")

source = TARGET.read_text()

source = source.replace(
    "        extra_volumes, extra_mounts = self._extract_template_pod_extras()\n",
    "        extra_volumes, extra_mounts, extra_container_patch = self._extract_template_pod_extras()\n",
)
source = source.replace(
    "        self._merge_pod_spec_extras(batchsandbox, extra_volumes, extra_mounts)\n",
    "        self._merge_pod_spec_extras(batchsandbox, extra_volumes, extra_mounts, extra_container_patch)\n",
)

start = source.find("    def _extract_template_pod_extras")
end = source.find("    # TODO: support empty cmd or env", start)
if start == -1 or end == -1:
    raise SystemExit("could not find template extras functions to patch")

replacement = '''    def _extract_template_pod_extras(self) -> tuple[list[Dict[str, Any]], list[Dict[str, Any]], Dict[str, Any]]:
        """
        Extract extra template pod fields that runtime containers otherwise overwrite.

        Upstream v0.1.9 preserves template volumes and volumeMounts only. Netdiag
        also needs the runtime sandbox container to inherit securityContext.privileged.
        """
        template = self.template_manager.get_base_template()
        spec = template.get("spec", {}) if isinstance(template, dict) else {}
        template_spec = spec.get("template", {}).get("spec", {})
        extra_volumes = template_spec.get("volumes", []) or []

        extra_mounts: list[Dict[str, Any]] = []
        extra_container_patch: Dict[str, Any] = {}
        containers = template_spec.get("containers", []) or []
        if containers:
            target = None
            for container in containers:
                if container.get("name") == "sandbox":
                    target = container
                    break
            if target is None:
                target = containers[0]
            extra_mounts = target.get("volumeMounts", []) or []
            for key in ("securityContext", "imagePullPolicy"):
                if key in target:
                    extra_container_patch[key] = target[key]

        if not isinstance(extra_volumes, list):
            extra_volumes = []
        if not isinstance(extra_mounts, list):
            extra_mounts = []
        if not isinstance(extra_container_patch, dict):
            extra_container_patch = {}
        return extra_volumes, extra_mounts, extra_container_patch

    def _merge_pod_spec_extras(
        self,
        batchsandbox: Dict[str, Any],
        extra_volumes: list[Dict[str, Any]],
        extra_mounts: list[Dict[str, Any]],
        extra_container_patch: Dict[str, Any] | None = None,
    ) -> None:
        """Merge template-provided pod extras into the runtime-generated pod spec."""
        try:
            spec = batchsandbox["spec"]["template"]["spec"]
        except KeyError:
            return

        volumes = spec.get("volumes", []) or []
        if isinstance(volumes, list) and extra_volumes:
            existing = {v.get("name") for v in volumes if isinstance(v, dict)}
            for vol in extra_volumes:
                if not isinstance(vol, dict):
                    continue
                name = vol.get("name")
                if not name or name in existing:
                    continue
                volumes.append(vol)
                existing.add(name)
            spec["volumes"] = volumes

        containers = spec.get("containers", []) or []
        if not containers or not isinstance(containers, list):
            return
        main_container = containers[0]

        def merge_template_dict(template_value: Dict[str, Any], runtime_value: Dict[str, Any]) -> Dict[str, Any]:
            merged = {}
            for key, value in template_value.items():
                if isinstance(value, dict):
                    merged[key] = merge_template_dict(value, {})
                elif isinstance(value, list):
                    merged[key] = list(value)
                else:
                    merged[key] = value
            for key, value in runtime_value.items():
                if isinstance(merged.get(key), dict) and isinstance(value, dict):
                    merged[key] = merge_template_dict(merged[key], value)
                else:
                    merged[key] = value
            return merged

        if isinstance(extra_container_patch, dict):
            for key, value in extra_container_patch.items():
                if key == "securityContext" and isinstance(value, dict):
                    existing = main_container.get("securityContext")
                    if isinstance(existing, dict):
                        main_container["securityContext"] = merge_template_dict(value, existing)
                    else:
                        main_container["securityContext"] = merge_template_dict(value, {})
                elif key not in main_container:
                    main_container[key] = value

        mounts = main_container.get("volumeMounts", []) or []
        if isinstance(mounts, list) and extra_mounts:
            existing = {m.get("name") for m in mounts if isinstance(m, dict)}
            for mnt in extra_mounts:
                if not isinstance(mnt, dict):
                    continue
                name = mnt.get("name")
                if not name or name in existing:
                    continue
                mounts.append(mnt)
                existing.add(name)
            main_container["volumeMounts"] = mounts

'''

source = source[:start] + replacement + source[end:]

if "extra_container_patch" not in source or '"securityContext"' not in source:
    raise SystemExit("patch did not inject securityContext merge")

TARGET.write_text(source)
