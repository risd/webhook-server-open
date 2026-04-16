PROJECT=risd-media-webhook
ZONE_DOCKER=us-central1
ZONE_GCP=us-central1-a

REPO_NAME=risd-webhook-docker-repo

DOCKER_PROJECT=risd-webook-server
DOCKER_NAME_PROD=risd-webhook-prod
DOCKER_NAME_STAGE=risd-webhook-stage
DOCKER_VERSION=v3.0.3

ENV_PROD=.env.rackspace.prod-v3
ENV_STAGE=.env.risd.stage-v3

STARTUP_PROD=startup-script-prod.sh
STARTUP_STAGE=startup-script-stage.sh

# change these per deployment
BRANCH=master
DOCKER_NAME_ACTIVE=$(DOCKER_NAME_PROD)
ENV=../$(ENV_PROD)
STARTUP=$(STARTUP_PROD)

# stable
DOCKER_NAME=$(DOCKER_NAME_ACTIVE):$(DOCKER_VERSION)

build:
	docker buildx build --tag $(DOCKER_NAME_ACTIVE) --build-arg BRANCH=$(BRANCH) --platform linux/amd64,linux/arm64 .

echo-test:
	echo $(shell ./bin/env-to-gcp-args $(ENV))

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
	docker tag $(DOCKER_NAME_PROD) \
		$(ZONE_DOCKER)-docker.pkg.dev/$(PROJECT)/$(REPO_NAME)/$(DOCKER_NAME)

# 5. push artifact registry name to to docker hub
docker-push-image:
	docker push $(ZONE_DOCKER)-docker.pkg.dev/$(PROJECT)/$(REPO_NAME)/$(DOCKER_NAME)

instance-create:
	gcloud compute instances create instance-$(DOCKER_NAME) \
		--zone=$(ZONE_GCP) \
		--image-family="cos-cloud" \
		--image-project=$(PROJECT) \
		--machine-type e2-medium \
		--boot-disk-size 40GB \
		--metadata-from-file=$(ENV) \
		--metadata-from-file=startup-script="./$(STARTUP)"
		# -metadata $(shell ./bin/env-to-gcp-args $(ENV)) \
