IMAGE ?= aiop:pi-agent-platform
KUBECTL ?= kubectl

.PHONY: verify-node test-agent-platform image deploy-staging rollback-staging

verify-node:
	npm run verify:node

test-agent-platform:
	npm run test:agent-platform

image:
	docker build -t $(IMAGE) .
	docker run --rm $(IMAGE) npm exec -- tsx -e "import('@aiop/agent-runtime-core').then(() => console.log('workspace-ok'))"
	docker run --rm $(IMAGE) npm run verify:node

deploy-staging:
	$(KUBECTL) apply -f deploy/k8s/

rollback-staging:
	$(KUBECTL) -n aiop rollout undo deployment/aiop
