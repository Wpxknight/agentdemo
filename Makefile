IMAGE_TAG ?= $(shell git rev-parse --short HEAD)
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
ROLLBACK_REVISION ?=
ROLLBACK_TO_REVISION = $(if $(strip $(ROLLBACK_REVISION)),--to-revision=$(ROLLBACK_REVISION),)

.PHONY: verify-node test-agent-platform test-runtime-refactor verify-runtime-refactor image pipeline deploy-staging rollback-staging deploy-aiop rollback-aiop

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

pipeline: verify-node
	docker buildx build --platform $(PLATFORMS) --tag $(PUBLISH_IMAGE) --push .
	docker buildx build --platform $(PLATFORMS) --file web/Dockerfile --tag $(PUBLISH_WEB_IMAGE) --push .
	docker manifest inspect --insecure $(PUBLISH_IMAGE)
	docker manifest inspect --insecure $(PUBLISH_WEB_IMAGE)

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
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret aiop-secrets -o name >/dev/null
	$(AIOP_KUBECTL) apply -f deploy/aiop/configmap.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/pvc-skills.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/service-nodeport.yaml
	$(AIOP_KUBECTL) set image -f deploy/aiop/deployment.yaml aiop=$(PUBLISH_IMAGE) aiop-web=$(PUBLISH_WEB_IMAGE) --local -o yaml | $(AIOP_KUBECTL) apply -f -
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout status deployment/aiop-server --timeout=300s

rollback-aiop:
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout undo deployment/aiop-server $(ROLLBACK_TO_REVISION)
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout status deployment/aiop-server --timeout=300s
