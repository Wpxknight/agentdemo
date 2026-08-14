ifeq ($(origin IMAGE_TAG), undefined)
IMAGE_TAG := $(shell git rev-parse --short HEAD)-w4-$(shell date +%Y%m%d%H%M%S)
endif
IMAGE ?= aiop:$(IMAGE_TAG)
WEB_IMAGE ?= aiop-web:$(IMAGE_TAG)
IMAGE_PREFIX ?= deploy.bocloud.k8s:40443/aios
PUBLISH_IMAGE ?= $(IMAGE_PREFIX)/aiop:$(IMAGE_TAG)
PUBLISH_WEB_IMAGE ?= $(IMAGE_PREFIX)/aiop-web:$(IMAGE_TAG)
PLATFORMS ?= linux/amd64,linux/arm64
KUBECTL ?= kubectl
AIOP_KUBECONFIG ?= /home/lb/.kube/config-10.241.0.166
AIOP_NAMESPACE ?= aios-system
AIOP_KUBECTL = $(KUBECTL) --kubeconfig $(AIOP_KUBECONFIG)
AIOP_IMAGE_PULL_POLICY ?= Always
AIOP_ALLOW_MIXED_IDENTITY_SOURCE ?= false
AIOP_AIOS_DEBUG_LOCAL_LOGIN ?= false
DEBUG_LOCAL_TENANT ?= default
DEBUG_LOCAL_USERNAME ?= admin
DEBUG_LOCAL_PASSWORD_SECRET ?= aiop-debug-local-login
SANDBOX_IMAGE ?= deploy.bocloud.k8s:40443/aios/aiop-sandbox:latest
SANDBOX_PLATFORM ?= linux/amd64
SANDBOX_KUBECTL_VERSION ?= v1.32.4
SANDBOX_KUBECTL_ARCH ?= amd64
SANDBOX_KUBECTL_DIST ?= dist/opensandbox/kubectl-$(SANDBOX_KUBECTL_VERSION)-linux-$(SANDBOX_KUBECTL_ARCH)
ROLLBACK_REVISION ?=
ROLLBACK_TO_REVISION = $(if $(strip $(ROLLBACK_REVISION)),--to-revision=$(ROLLBACK_REVISION),)

.PHONY: verify-node test-agent-platform test-runtime-refactor verify-runtime-refactor test-dual-auth test-migrations-mariadb check-dual-deploy-config package-web-core verify-web-core-package test-web-core-consumer image-check check-user-id-migration migrate-user-id-staging image pipeline sandbox-prepare-kubectl sandbox-image sandbox-image-check sandbox-image-push sandbox-pipeline deploy-staging rollback-staging deploy-aiop deploy-standalone deploy-aios-integrated reset-aios-debug-local-password rollback-aiop backup-aiop-staging-k8s-settings backup-aiop-staging-db-settings rebuild-aiop-staging-db deploy-aiop-staging deploy-aiop-staging-workload deploy-aiop-staging-fresh

verify-node:
	npm run verify:node

test-agent-platform:
	npm run test:agent-platform

test-runtime-refactor:
	npm run test:runtime-refactor

verify-runtime-refactor: test-runtime-refactor
	npm --prefix web run build
	$(MAKE) image

test-dual-auth:
	npm run typecheck
	npm test -- --run tests/auth.test.ts tests/oidc.test.ts tests/aios-integration.test.ts tests/rbac.test.ts tests/config.test.ts tests/http.test.ts
	npm --prefix web run build
	$(MAKE) verify-web-core-package
	$(MAKE) check-dual-deploy-config

package-web-core:
	@mkdir -p dist
	rm -f dist/aiop-web-*.tgz
	npm --prefix web run package:lib

verify-web-core-package: package-web-core
	@set -eu; archive=$$(ls dist/aiop-web-*.tgz); \
		tar -tzf "$$archive" > dist/web-core-package-all-files; \
		grep -q '^package/dist-lib/web-core.js$$' dist/web-core-package-all-files; \
		grep -q '^package/dist-lib/web-core.d.ts$$' dist/web-core-package-all-files; \
		grep -q '^package/dist-lib/style.css$$' dist/web-core-package-all-files; \
		grep -q '^package/package.json$$' dist/web-core-package-all-files; \
		(cd web && tar -cf - dist-lib) | tar -tf - | sed 's#/$##' | sort > dist/web-core-build-files; \
		grep '^package/dist-lib' dist/web-core-package-all-files | sed 's#^package/##; s#/$##' | sort > dist/web-core-package-files; \
		diff -u dist/web-core-build-files dist/web-core-package-files; \
		rm -f dist/web-core-package-all-files dist/web-core-build-files dist/web-core-package-files

# Install the local tgz into an isolated consumer and prove JS, explicit CSS, dynamic chunks and bundled assets resolve.
test-web-core-consumer: package-web-core
	@set -eu; root="$$PWD/dist/web-core-consumer"; archive=$$(ls "$$PWD"/dist/aiop-web-*.tgz); \
		rm -rf "$$root"; mkdir -p "$$root/src" "$$root/dist" "$$PWD/dist/npm-cache"; \
		printf '%s\n' '{"private":true,"type":"module","scripts":{"build":"vite build"}}' > "$$root/package.json"; \
		printf '%s\n' '{"compilerOptions":{"target":"ES2022","lib":["ES2022","DOM","DOM.Iterable"],"module":"ESNext","moduleResolution":"Bundler","strict":true,"skipLibCheck":true,"jsx":"react-jsx","noEmit":true},"include":["src"]}' > "$$root/tsconfig.json"; \
		printf '%s\n' '<div id="root"></div><script type="module" src="/src/main.tsx"></script>' > "$$root/index.html"; \
		printf '%s\n' "declare module '*.css';" > "$$root/src/env.d.ts"; \
		printf '%s\n' "import React from 'react'; import {createRoot} from 'react-dom/client'; import {WebCore} from 'aiop-web'; import 'aiop-web/style.css'; const host={deploymentMode:'standalone',authProvider:'local',apiBase:'',getToken:()=>'',setToken:()=>{},onUnauthorized:()=>{}} as const; createRoot(document.getElementById('root')!).render(<WebCore host={host}/>);" > "$$root/src/main.tsx"; \
		cd "$$root"; npm_config_cache="$$PWD/../npm-cache" npm install --offline --legacy-peer-deps --no-save "$$archive"; ln -s "$$OLDPWD/web/node_modules/react" node_modules/react; ln -s "$$OLDPWD/web/node_modules/react-dom" node_modules/react-dom; mkdir -p node_modules/@types; ln -s "$$OLDPWD/web/node_modules/@types/react" node_modules/@types/react; ln -s "$$OLDPWD/web/node_modules/@types/react-dom" node_modules/@types/react-dom; "$$OLDPWD/node_modules/.bin/tsc" -p tsconfig.json --noEmit; "$$OLDPWD/node_modules/.bin/vite" build; \
		test -n "$$(ls dist/assets/*.js)"; test -n "$$(ls dist/assets/*.css)"; \
		test -f node_modules/aiop-web/dist-lib/assets/logo.jpg; test -f node_modules/aiop-web/dist-lib/assets/user-avatar.jpg; \
		test "$$(ls dist/assets/*.js | wc -l)" -gt 1; cd ..; rm -rf web-core-consumer

test-migrations-mariadb:
	@mkdir -p dist
	@set -eu; name=aiop-migrations-mariadb-$$$$; cleanup() { docker rm -f "$$name" >/dev/null 2>&1 || true; }; trap cleanup EXIT INT TERM; \
		docker run -d --rm --name "$$name" -e MARIADB_ROOT_PASSWORD=aiop-integration \
			--health-cmd='healthcheck.sh --connect --innodb_initialized' --health-interval=1s --health-timeout=5s --health-retries=60 \
			-p 127.0.0.1::3306 mariadb:11.4 >dist/mariadb-migration-container-id; \
		port=$$(docker port "$$name" 3306/tcp | cut -d: -f2); \
		for attempt in $$(seq 1 60); do status=$$(docker inspect -f '{{.State.Health.Status}}' "$$name"); test "$$status" = healthy && break; test "$$status" != unhealthy -a "$$attempt" -lt 60 || { docker logs "$$name"; exit 1; }; sleep 1; done; \
		AIOP_MARIADB_INTEGRATION=1 MARIADB_HOST=127.0.0.1 MARIADB_PORT="$$port" MARIADB_USER=root MARIADB_PASSWORD=aiop-integration \
			npm exec -- vitest run tests/integration/runtime-migrations.mariadb.test.ts 2>&1 | tee dist/mariadb-migration-test.log

check-dual-deploy-config:
	npm exec -- tsx scripts/check-dual-deploy-config.ts

image-check: verify-web-core-package
	docker image inspect $(IMAGE) >/dev/null
	docker image inspect $(WEB_IMAGE) >/dev/null
	docker run --rm $(IMAGE) npm run verify:node
	docker run --rm $(IMAGE) npm exec -- tsx -e "import('@aiop/pi-runtime').then(() => console.log('workspace-ok'))"

deploy-standalone:
	@test "$(DEPLOYMENT_MODE)" = "standalone" || (printf '%s\n' 'Set DEPLOYMENT_MODE=standalone' >&2; exit 1)
	@test "$(AUTH_PROVIDER)" = "local" -o "$(AUTH_PROVIDER)" = "oidc" || (printf '%s\n' 'Set AUTH_PROVIDER=local or AUTH_PROVIDER=oidc' >&2; exit 1)
	$(MAKE) deploy-aiop DEPLOYMENT_MODE=standalone AUTH_PROVIDER=$(AUTH_PROVIDER)

deploy-aios-integrated:
	@test "$(DEPLOYMENT_MODE)" = "aios-integrated" || (printf '%s\n' 'Set DEPLOYMENT_MODE=aios-integrated' >&2; exit 1)
	@test "$(AIOP_ALLOW_MIXED_IDENTITY_SOURCE)" = "false" -o "$(AIOP_ALLOW_MIXED_IDENTITY_SOURCE)" = "true" || (printf '%s\n' 'AIOP_ALLOW_MIXED_IDENTITY_SOURCE must be false or true' >&2; exit 1)
	@test "$(AIOP_AIOS_DEBUG_LOCAL_LOGIN)" = "false" -o "$(AIOP_AIOS_DEBUG_LOCAL_LOGIN)" = "true" || (printf '%s\n' 'AIOP_AIOS_DEBUG_LOCAL_LOGIN must be false or true' >&2; exit 1)
	@# 测试环境部署不自动执行身份迁移预检；需要诊断时显式运行 check-user-id-migration。
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret aiop-secrets -o name >/dev/null
	$(AIOP_KUBECTL) apply -f deploy/aiop/configmap-aios-integrated.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/pvc-skills.yaml
	@# Fabric 不会可靠清理 Service targetPort 原地变更的旧 NodePort 链，重建以避免流量命中陈旧后端。
	$(AIOP_KUBECTL) delete -f deploy/aiop/service-aios-integrated.yaml --ignore-not-found --wait=true
	$(AIOP_KUBECTL) apply -f deploy/aiop/service-aios-integrated.yaml
	$(AIOP_KUBECTL) set image -f deploy/aiop/deployment-aios-integrated.yaml aiop=$(PUBLISH_IMAGE) aiop-web=$(PUBLISH_WEB_IMAGE) --local -o yaml | $(AIOP_KUBECTL) apply -f -
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) set env deployment/aiop-server AIOP_DEPLOY_IMAGE=$(PUBLISH_IMAGE) AIOP_DEPLOY_WEB_IMAGE=$(PUBLISH_WEB_IMAGE) AIOP_ALLOW_MIXED_IDENTITY_SOURCE=$(AIOP_ALLOW_MIXED_IDENTITY_SOURCE) AIOP_AIOS_DEBUG_LOCAL_LOGIN=$(AIOP_AIOS_DEBUG_LOCAL_LOGIN)
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout status deployment/aiop-server --timeout=300s

reset-aios-debug-local-password:
	@set -eu; \
		if $(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret "$(DEBUG_LOCAL_PASSWORD_SECRET)" >/dev/null 2>&1; then \
			$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret "$(DEBUG_LOCAL_PASSWORD_SECRET)" -o jsonpath='{.data.password}' \
				| base64 -d \
				| $(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) exec -i deploy/aiop-server -c aiop -- npm exec -- tsx src/index.ts reset-local-password "$(DEBUG_LOCAL_TENANT)" "$(DEBUG_LOCAL_USERNAME)"; \
		elif test -t 0; then \
			stty -echo; trap 'stty echo' EXIT INT TERM; printf 'New password: ' >&2; IFS= read -r password; printf '\n' >&2; stty echo; trap - EXIT INT TERM; \
			test -n "$$password" || { printf '%s\n' 'Password must not be empty' >&2; exit 1; }; \
			printf '%s' "$$password" | $(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) exec -i deploy/aiop-server -c aiop -- npm exec -- tsx src/index.ts reset-local-password "$(DEBUG_LOCAL_TENANT)" "$(DEBUG_LOCAL_USERNAME)"; \
		else \
			printf '%s\n' 'Create Secret $(DEBUG_LOCAL_PASSWORD_SECRET) with key password, or run interactively' >&2; exit 1; \
		fi

check-user-id-migration:
	@test -n "$(DEPLOYMENT_MODE)" -a -n "$(AUTH_PROVIDER)" || (printf '%s\n' 'Set explicit DEPLOYMENT_MODE and AUTH_PROVIDER' >&2; exit 1)
	DEPLOYMENT_MODE="$(DEPLOYMENT_MODE)" AUTH_PROVIDER="$(AUTH_PROVIDER)" npm exec -- tsx scripts/check-user-id-migration.ts

migrate-user-id-staging:
	@CONFIRM_USER_ID_MIGRATION="$(CONFIRM_USER_ID_MIGRATION)" \
		USER_ID_MIGRATION_BACKUP="$(USER_ID_MIGRATION_BACKUP)" \
		MIGRATION_NAMESPACE="$(MIGRATION_NAMESPACE)" MIGRATION_DEPLOYMENT="$(MIGRATION_DEPLOYMENT)" \
		MIGRATION_EXPECTED_REPLICAS="$(MIGRATION_EXPECTED_REPLICAS)" MIGRATION_KUBECONFIG="$(MIGRATION_KUBECONFIG)" \
		AIOP_EXPECTED_KUBE_CONTEXT="$(AIOP_EXPECTED_KUBE_CONTEXT)" \
		DEPLOYMENT_MODE="$(DEPLOYMENT_MODE)" AUTH_PROVIDER="$(AUTH_PROVIDER)" \
		MYSQL_HOST="$(MYSQL_HOST)" MYSQL_DATABASE="$(MYSQL_DATABASE)" MYSQL_USER="$(MYSQL_USER)" \
		KUBECTL="$(KUBECTL)" ./scripts/migrate-user-id-staging.sh

image: verify-web-core-package
	docker build -t $(IMAGE) .
	docker build -f web/Dockerfile -t $(WEB_IMAGE) .
	docker run --rm $(IMAGE) npm exec -- tsx -e "import('@aiop/pi-runtime').then(() => console.log('workspace-ok'))"
	docker run --rm $(IMAGE) npm run verify:node

pipeline: verify-node
ifeq ($(USE_EXISTING_IMAGES),1)
	docker image inspect $(IMAGE) >/dev/null
	docker image inspect $(WEB_IMAGE) >/dev/null
	docker tag $(IMAGE) $(PUBLISH_IMAGE)
	docker tag $(WEB_IMAGE) $(PUBLISH_WEB_IMAGE)
	docker push $(PUBLISH_IMAGE)
	docker push $(PUBLISH_WEB_IMAGE)
else
	docker buildx build --platform $(PLATFORMS) --tag $(PUBLISH_IMAGE) --push .
	docker buildx build --platform $(PLATFORMS) --file web/Dockerfile --tag $(PUBLISH_WEB_IMAGE) --push .
endif
	docker manifest inspect --insecure $(PUBLISH_IMAGE)
	docker manifest inspect --insecure $(PUBLISH_WEB_IMAGE)

sandbox-prepare-kubectl:
	@mkdir -p dist/opensandbox
	@test -f $(SANDBOX_KUBECTL_DIST) || curl -fL --retry 3 -o $(SANDBOX_KUBECTL_DIST) https://dl.k8s.io/release/$(SANDBOX_KUBECTL_VERSION)/bin/linux/$(SANDBOX_KUBECTL_ARCH)/kubectl
	@test -f $(SANDBOX_KUBECTL_DIST).sha256 || curl -fL --retry 3 -o $(SANDBOX_KUBECTL_DIST).sha256 https://dl.k8s.io/release/$(SANDBOX_KUBECTL_VERSION)/bin/linux/$(SANDBOX_KUBECTL_ARCH)/kubectl.sha256
	@printf '%s  %s\n' "$$(cat $(SANDBOX_KUBECTL_DIST).sha256)" "$(SANDBOX_KUBECTL_DIST)" | sha256sum --check
	install -m 0755 $(SANDBOX_KUBECTL_DIST) deploy/opensandbox/kubectl
	deploy/opensandbox/kubectl version --client

sandbox-image: sandbox-prepare-kubectl
	docker build --platform $(SANDBOX_PLATFORM) --network host \
		-f deploy/opensandbox/Dockerfile.allinone -t $(SANDBOX_IMAGE) .

sandbox-image-check:
	docker image inspect $(SANDBOX_IMAGE) >/dev/null
	docker run --rm --platform $(SANDBOX_PLATFORM) $(SANDBOX_IMAGE) sh -ec 'python3 -c "import requests, yaml, cryptography, openpyxl"; node -e "if (typeof fetch !== \"function\" || typeof WebSocket !== \"function\") process.exit(1)"; chromium --version; Xvfb -help >/dev/null 2>&1; fc-list :lang=zh family | grep -q .; kubectl version --client; for binary in Xvfb fc-list tcpdump conntrack dig iptables nft nsenter ovs-ofctl ovs-vsctl; do command -v "$$binary" >/dev/null; done'

sandbox-image-push: sandbox-image-check
	docker push $(SANDBOX_IMAGE)
	docker manifest inspect --insecure $(SANDBOX_IMAGE) >/dev/null

sandbox-pipeline: sandbox-image sandbox-image-push

deploy-staging:
	$(KUBECTL) apply -f deploy/dev-k8s/namespace.yaml
	$(KUBECTL) -n aiop-dev get secret aiop-dev-secrets -o name >/dev/null
	$(KUBECTL) apply -f deploy/dev-k8s/mysql.yaml
	$(KUBECTL) apply -f deploy/dev-k8s/oidc-test.yaml
	$(KUBECTL) apply -f deploy/dev-k8s/aiop-configmap.yaml
	$(KUBECTL) apply -f deploy/dev-k8s/aiop-service-nodeport.yaml
	$(KUBECTL) apply -f deploy/dev-k8s/ops-rbac.yaml
	$(KUBECTL) set image -f deploy/dev-k8s/aiop-deployment.yaml aiop=$(IMAGE) aiop-web=$(WEB_IMAGE) --local -o yaml | $(KUBECTL) apply -f -
	$(KUBECTL) -n aiop-dev rollout status deployment/mysql --timeout=180s
	$(KUBECTL) -n aiop-dev rollout status deployment/dex --timeout=180s
	$(KUBECTL) -n aiop-dev rollout status deployment/aiop-server --timeout=180s

rollback-staging:
	$(KUBECTL) -n aiop-dev rollout undo deployment/aiop-server $(ROLLBACK_TO_REVISION)
	$(KUBECTL) -n aiop-dev rollout status deployment/aiop-server --timeout=180s

deploy-aiop:
	@test "$(DEPLOYMENT_MODE)" = "standalone" || (printf '%s\n' 'Set DEPLOYMENT_MODE=standalone' >&2; exit 1)
	@test "$(AUTH_PROVIDER)" = "local" -o "$(AUTH_PROVIDER)" = "oidc" || (printf '%s\n' 'Set AUTH_PROVIDER=local or AUTH_PROVIDER=oidc' >&2; exit 1)
	$(MAKE) check-user-id-migration DEPLOYMENT_MODE=standalone AUTH_PROVIDER=$(AUTH_PROVIDER)
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret aiop-secrets -o name >/dev/null
	$(AIOP_KUBECTL) apply -f deploy/aiop/configmap.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/pvc-skills.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/service-nodeport.yaml
	$(AIOP_KUBECTL) set image -f deploy/aiop/deployment.yaml aiop=$(PUBLISH_IMAGE) aiop-web=$(PUBLISH_WEB_IMAGE) --local -o yaml | $(AIOP_KUBECTL) apply -f -
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout status deployment/aiop-server --timeout=300s

backup-aiop-staging-k8s-settings:
	AIOP_KUBECONFIG=$(AIOP_KUBECONFIG) AIOP_NAMESPACE=$(AIOP_NAMESPACE) AIOP_BACKUP_DIR=$(AIOP_BACKUP_DIR) ./scripts/backup-aiop-k8s-settings.sh

backup-aiop-staging-db-settings:
	AIOP_KUBECONFIG=$(AIOP_KUBECONFIG) AIOP_NAMESPACE=$(AIOP_NAMESPACE) AIOP_BACKUP_DIR=$(AIOP_BACKUP_DIR) AIOP_VERIFIED_MYSQL_HOST=$(AIOP_VERIFIED_MYSQL_HOST) AIOP_VERIFIED_MYSQL_PORT=$(AIOP_VERIFIED_MYSQL_PORT) AIOP_VERIFIED_MYSQL_DATABASE=$(AIOP_VERIFIED_MYSQL_DATABASE) ./scripts/backup-aiop-staging-db-settings.sh

rebuild-aiop-staging-db:
	AIOP_KUBECONFIG=$(AIOP_KUBECONFIG) AIOP_NAMESPACE=$(AIOP_NAMESPACE) AIOP_BACKUP_DIR=$(AIOP_BACKUP_DIR) DB_REBUILD_MODE=$(DB_REBUILD_MODE) AIOP_VERIFIED_MYSQL_HOST=$(AIOP_VERIFIED_MYSQL_HOST) AIOP_VERIFIED_MYSQL_PORT=$(AIOP_VERIFIED_MYSQL_PORT) AIOP_VERIFIED_MYSQL_DATABASE=$(AIOP_VERIFIED_MYSQL_DATABASE) ./scripts/rebuild-aiop-staging-db.sh

deploy-aiop-staging:
	$(AIOP_KUBECTL) apply -f deploy/aiop/configmap.yaml
	$(MAKE) deploy-aiop-staging-workload

deploy-aiop-staging-workload:
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get configmap aiop-config -o name >/dev/null
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret aiop-secrets -o name >/dev/null
	$(AIOP_KUBECTL) apply -f deploy/aiop/pvc-skills.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/service-nodeport.yaml
	$(AIOP_KUBECTL) set image -f deploy/aiop/deployment.yaml aiop=$(PUBLISH_IMAGE) aiop-web=$(PUBLISH_WEB_IMAGE) --local -o yaml | $(AIOP_KUBECTL) apply -f -
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) set env deployment/aiop-server AIOP_DEPLOY_IMAGE=$(PUBLISH_IMAGE) AIOP_DEPLOY_WEB_IMAGE=$(PUBLISH_WEB_IMAGE)
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) patch deployment aiop-server --type=strategic --patch='{"spec":{"template":{"spec":{"containers":[{"name":"aiop","imagePullPolicy":"$(AIOP_IMAGE_PULL_POLICY)"},{"name":"aiop-web","imagePullPolicy":"$(AIOP_IMAGE_PULL_POLICY)"}]}}}}'
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout status deployment/aiop-server --timeout=300s

deploy-aiop-staging-fresh:
	IMAGE_TAG=$(IMAGE_TAG) AIOP_KUBECONFIG=$(AIOP_KUBECONFIG) AIOP_NAMESPACE=$(AIOP_NAMESPACE) ./scripts/deploy-aiop-staging-fresh.sh

rollback-aiop:
	AIOP_KUBECONFIG=$(AIOP_KUBECONFIG) AIOP_NAMESPACE=$(AIOP_NAMESPACE) KUBECTL=$(KUBECTL) \
		ROLLBACK_REVISION=$(ROLLBACK_REVISION) ./scripts/rollback-aiop-compatible.sh
