build:
	docker buildx build --tag risd-webhook-prod --build-arg BRANCH=master --platform linux/amd64,linux/arm64 .

build-develop:
	docker buildx build --tag risd-webhook-develop --build-arg BRANCH=develop --platform linux/amd64,linux/arm64 .

run:
	docker container run \
		--name risd-webhook-prod-vm \
		--publish 80:80 \
		--env-file .env.rackspace.prod-v3 \
		--label risd-webhook=prod \
		risd-webhook-prod

run-prod-mounted:
	docker container run \
		--name risd-webhook-prod-vm \
		--publish 80:80 \
		--env-file .env.rackspace.prod-v3 \
		--env DEBUG=* \
		--label risd-webhook=prod \
		--mount src="$(shell pwd)",target=/home/webhook/webhook-server-open,type=bind \
		risd-webhook-prod

run-prod-site-build:
	docker container run \
		--name risd-webhook-prod-vm \
		--publish 80:80 \
		--env-file .env.rackspace.prod-v3 \
		--env DEBUG=* \
		--label risd-webhook=prod \
		risd-webhook-prod \
		./bin/build-command -u rrodrigu@risd.edu -n risd-nature-lab,1risd,1systems --siteBucket=naturelab.risd.systems --branch=develop

run-develop:
	docker container run \
		--name risd-webhook-develop-vm \
		--publish 80:80 \
		--env-file .env.risd.stage-v3 \
		--label risd-webhook=stage \
		risd-webhook-develop

run-develop-http-server:
	docker container run \
		--name risd-webhook-stage-develop \
		--publish 80:80 \
		--env-file .env.risd.stage-v3 \
		--label risd-webhook=stage \
		risd-webhook-develop \
		/bin/sh -c "npm start"

prune-prod:
	docker container prune --force --filter "label=risd-webhook=prod"

prune-stage:
	docker container prune --force --filter "label=risd-webhook=stage"

prune: prune-stage prune-prod

# deploy steps 1: login to the gcp artifact registry
docker-gcp-login:
	gcloud auth print-access-token | \
  docker login \
	  -u oauth2accesstoken \
	  --password-stdin https://us-central1-docker.pkg.dev

# deploy steps 2: tag the local image with a remote location
gcp-tag-stage:
	docker tag risd-webhook-dockerify us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-dockerify:v3.0.0

gcp-tag-prod:
	docker tag risd-webhook-prod us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-prod:v3.0.0

# deploy steps 3: push the image to the artifact registry
docker-push-image-stage:
	docker push us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-dockerify:v3.0.0

docker-push-image-prod:
	docker push us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-prod:v3.0.0

# the gcp project includes http-server & https-server tags which will apply
# firewall rules to allow for traffic on these ports. if these are not created, use
# the `gcp-create-firewall-rules` command below
gcp-deploy-stage: build-dockerify docker-gcp-login gcp-tag-stage docker-push-image-stage
	gcloud compute instances create-with-container risd-webhook-instance-dockerify \
		--zone us-central1-a \
		--container-image=us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-dockerify:v3.0.0 \
		--container-env-file .env.risd.stage-v3 \
		--tags http-server,https-server \
		--machine-type e2-medium \
		--boot-disk-size 40GB
	echo "Update cloudflare with this IP address"

gcp-deploy-prod:
	gcloud compute instances create-with-container risd-webhook-instance-prod \
		--zone us-central1-a \
		--container-image=us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-prod:v3.0.0 \
		--container-env-file .env.rackspace.prod-v3 \
		--tags http-server,https-server \
		--machine-type e2-medium \
		--boot-disk-size 40GB
	echo "Update cloudflare with this IP address"

gcp-update-stage:
	gcloud compute instances update-container risd-webhook-instance-dockerify \
		--zone us-central1-a \
		--container-env-file .env.risd.stage-v3

gcp-update-prod:
	gcloud compute instances update-container risd-webhook-instance-prod \
		--zone us-central1-a \
		--container-env-file .env.rackspace.prod-v3

gcp-delete-stage:
	gcloud compute instances delete risd-webhook-instance-dockerify \
		--zone us-central1-a

gcp-delete-prod:
	gcloud compute instances delete risd-webhook-instance-prod \
		--zone us-central1-a

gcp-ssh-stage:
	gcloud compute ssh risd-webhook-instance-dockerify \
		--zone us-central1-a

gcp-ssh-prod:
	gcloud compute ssh risd-webhook-instance-prod \
		--zone us-central1-a

gcp-create-firewall-rules:
	gcloud compute firewall-rules create allow-http --allow tcp:80 --target-tags http-server
	gcloud compute firewall-rules create allow-https --allow tcp:443 --target-tags https-server

gcp-list-firewall-rules:
	gcloud compute firewall-rules list
