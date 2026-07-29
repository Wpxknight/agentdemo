IMAGE_TAG ?= $(shell git rev-parse --short HEAD)
IMAGE ?= aiop:$(IMAGE_TAG)
WEB_IMAGE ?= aiop-web:$(IMAGE_TAG)
KUBECTL ?= kubectl
ROLLBACK_REVISION ?=
ROLLBACK_TO_REVISION = $(if $(strip $(ROLLBACK_REVISION)),--to-revision=$(ROLLBACK_REVISION),)

.PHONY: verify-node test-agent-platform test-runtime-refactor verify-runtime-refactor image deploy-staging rollback-staging

verify-node:
	npm run verify:node

test-agent-platform:
	npm run test:agent-platform

test-runtime-refactor:
	npm run test:runtime-refactor

verify-runtime-refactor: test-runtime-refactor
	npm --prefix web run build
	$(MAKE) image

image:
	docker build -t $(IMAGE) .
	docker build -f web/Dockerfile -t $(WEB_IMAGE) .
	docker run --rm $(IMAGE) npm exec -- tsx -e "import('@aiop/pi-runtime').then(() => console.log('workspace-ok'))"
	docker run --rm $(IMAGE) npm run verify:node

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
