IMAGE ?= aiop:pi-agent-platform
KUBECTL ?= kubectl

.PHONY: verify-node test-agent-platform image deploy-staging rollback-staging

verify-node:
	npm run verify:node

test-agent-platform:
	npm run test:agent-platform

image:
	docker build -t $(IMAGE) .

deploy-staging:
	$(KUBECTL) apply -f deploy/k8s/

rollback-staging:
	$(KUBECTL) -n aiop rollout undo deployment/aiop
