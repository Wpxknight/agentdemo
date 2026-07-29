IMAGE ?= aiop:pi-agent-platform
KUBECTL ?= kubectl

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
	docker run --rm $(IMAGE) npm exec -- tsx -e "import('@aiop/pi-runtime').then(() => console.log('workspace-ok'))"
	docker run --rm $(IMAGE) npm run verify:node

deploy-staging:
	$(KUBECTL) apply -f deploy/k8s/

rollback-staging:
	$(KUBECTL) -n aiop rollout undo deployment/aiop
