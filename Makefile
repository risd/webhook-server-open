build:
	docker build --tag risd-webhook-master --build-arg BRANCH=master .

build-develop:
	docker build --tag risd-webhook-develop --build-arg BRANCH=develop .

build-dockerify:
	docker build --tag risd-webhook-dockerify --build-arg BRANCH=feature/dockerify .

run:
	docker container run \
		--name risd-webhook-prod \
		-p 3000:3000 \
		--env-file .env.prod.local-v2 \
		risd-webhook-master

run-develop:
	docker container run \
		--name risd-webhook-stage \
		-p 3000:3000 \
		--env-file .env.risd.stage \
		risd-webhook-develop

run-dockerify:
	docker container run \
		--name risd-webhook-stage-dockerify \
		-p 3000:3000 \
		--env-file .env.risd.stage \
		risd-webhook-dockerify

run-dockerify-it:
	docker container run \
		--name risd-webhook-stage-dockerify \
		-p 3000:3000 \
		--env-file .env.risd.stage \
		-it \
		risd-webhook-dockerify

prune:
	docker container prune

ip-addy:
	docker inspect -f "{{ .NetworkSettings.IPAddress }}" risd-webhook-stage-dockerify
