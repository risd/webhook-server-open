PROJECT=risd-media-webhook
ZONE_DOCKER=us-central1
ZONE_GCP=us-central1-a

REPO_NAME=risd-webhook-docker-repo

DOCKER_PROJECT=risd-webook-server
DOCKER_VERSION=v3-0-4

ENV_PROD=.env.rackspace.prod-v3
ENV_STAGE=.env.risd.stage-v3

# change these per deployment
ENV_NAME=prod
BRANCH=master
ENV=../$(ENV_PROD)

# stable
# DOCKER_NAME should match the startup-script CONTAINER_IMAGE
DOCKER_NAME_ACTIVE=risd-webhook-$(ENV_NAME)
DOCKER_NAME_TAGGED=$(DOCKER_NAME_ACTIVE):$(DOCKER_VERSION)
INSTANCE_NAME=instance--$(DOCKER_NAME_ACTIVE)--$(DOCKER_VERSION)
DOCKER_LABEL=risd-webhook=$(BRANCH)
STARTUP=startup-script-$(ENV_NAME).sh

build:
	docker buildx build --tag $(DOCKER_NAME_ACTIVE) --build-arg BRANCH=$(BRANCH) --platform linux/amd64,linux/arm64 ../

# echo-test:
# 	echo $(shell ./bin/env-to-gcp-args $(ENV))

# Push image to Artifact Registry
# 1. One time: Create artifact in google
artifact-repo-create:
	gcloud artifacts repositories create $(REPO_NAME) \
		--repository-format=docker \
		--location=$(ZONE_DOCKER) \
		--description="risd-webhook-docker-repo" \
		--project=$(PROJECT)

# 2. verify it exists
artifact-repo-verify:
	gcloud artifacts repositories list \
		--project=$(PROJECT)

artifact-repo-describe:
	gcloud artifacts repositories describe $(REPO_NAME) \
		--location=$(ZONE_DOCKER) \
		--project=$(PROJECT)

# 3. Log in to docker
auth-docker:
	gcloud auth print-access-token | \
	  docker login \
		  -u oauth2accesstoken \
		  --password-stdin https://$(ZONE_DOCKER)-docker.pkg.dev
	gcloud auth configure-docker $(ZONE_DOCKER)-docker.pkg.dev

# 4. tag for artifact registry. 
tag-image:
	docker tag $(DOCKER_NAME_ACTIVE) \
		$(ZONE_DOCKER)-docker.pkg.dev/$(PROJECT)/$(REPO_NAME)/$(DOCKER_NAME_TAGGED)

# 5. push artifact registry name to to docker hub
docker-push-image:
	docker push $(ZONE_DOCKER)-docker.pkg.dev/$(PROJECT)/$(REPO_NAME)/$(DOCKER_NAME_TAGGED)

artifact-list-images:
	gcloud artifacts docker images list \
		$(ZONE_DOCKER)-docker.pkg.dev/$(PROJECT)/$(REPO_NAME) \
		--limit=5 \
		--include-tags

# ENSURE: startup script points to the correct version
instance-create:
	./bin/gen-startup-script $(ENV_NAME)
	gcloud compute instances create $(INSTANCE_NAME) \
		--zone=$(ZONE_GCP) \
		--image-family=cos-stable \
		--image-project=cos-cloud \
		--machine-type e2-medium \
		--boot-disk-size 40GB \
		--tags http-server,https-server \
		--metadata-from-file COS_ENV=$(ENV),startup-script="./$(STARTUP)"
	echo "Update cloudflare with this IP address"

instance-ssh:
	gcloud compute ssh $(INSTANCE_NAME) \
		--zone $(ZONE_GCP)

instance-delete:
	gcloud compute instances delete $(INSTANCE_NAME) \
		--zone=$(ZONE_GCP)

env-parsing:
	DOCKER_ENV=$(ENV) ./bin/env-string-to-docker-env

server-run-docker-env:
	DOCKER_ENV='GOOGLE_PROJECT_ID="oh-hai"' npx grunt echoConfig

run:
	docker container run \
		--name risd-webhook-vm \
		--publish 80:80 \
		--env DEBUG=* \
		--env-file $(ENV) \
		--label $(DOCKER_LABEL) \
		$(DOCKER_NAME_ACTIVE)

run-dev:
	docker container run \
		--name risd-webhook-vm \
		--publish 80:80 \
		--env DEBUG=* \
		--env-file $(ENV) \
		--label $(DOCKER_LABEL) \
		--mount src="$(shell pwd)",target=/home/webhook/webhook-server-open,type=bind \
		$(DOCKER_NAME_ACTIVE)

prune:
	docker container prune --force --filter "label=$(DOCKER_LABEL)"
