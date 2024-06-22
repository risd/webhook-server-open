build:
	docker build --tag risd-webhook-master --build-arg BRANCH=master .

build-develop:
	docker build --tag risd-webhook-develop --build-arg BRANCH=develop .

build-dockerify:
	docker buildx build --tag risd-webhook-dockerify --build-arg BRANCH=feature/dockerify --platform linux/amd64,linux/arm64 .

run:
	docker container run \
		--name risd-webhook-prod \
		--publish 3000:3000 \
		--env-file .env.prod.local-v2 \
		risd-webhook-master

run-develop:
	docker container run \
		--name risd-webhook-stage \
		--publish 3000:3000 \
		--env-file .env.risd.stage \
		risd-webhook-develop

run-dockerify:
	docker container run \
		--name risd-webhook-stage-dockerify \
		--publish 3000:3000 \
		--env-file .env.risd.stage \
		risd-webhook-dockerify

run-dockerify-http-server:
	docker container run \
		--name risd-webhook-stage-dockerify \
		--publish 80:80 \
		--env-file .env.risd.stage \
		risd-webhook-dockerify \
		/bin/sh -c "npm start"

run-dockerify-it:
	docker container run \
		--name risd-webhook-stage-dockerify \
		--publish 80:80 \
		--env-file .env.risd.stage \
		-it \
		risd-webhook-dockerify

prune:
	docker container prune --force

# deploy steps 1: login to the gcp artifact registry
docker-gcp-login:
	gcloud auth print-access-token | \
  docker login \
	  -u oauth2accesstoken \
	  --password-stdin https://us-central1-docker.pkg.dev

# deploy steps 2: tag the local image with a remote location
gcp-tag-stage:
	docker tag risd-webhook-dockerify us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-dockerify:v3.0.0

# deploy steps 3: push the image to the artifact registry
docker-push-image:
	docker push us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-dockerify:v3.0.0

# the gcp project includes http-server & https-server tags which will apply
# firewall rules to allow for traffic on these ports. if these are not created, use
# the `gcp-create-firewall-rules` command below
gcp-deploy-stage:
	gcloud compute instances create-with-container risd-webhook-instance-dockerify \
		--zone us-central1-a \
		--container-image=us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-dockerify:v3.0.0 \
		--container-env-file .env.risd.stage \
		--tags http-server,https-server,http-server-3000

gcp-update-stage:
	gcloud compute instances update-container risd-webhook-instance-dockerify \
		--zone us-central1-a \
		--container-env-file .env.risd.stage

gcp-delete-stage:
	gcloud compute instances delete risd-webhook-instance-dockerify \
		--zone us-central1-a \

gcp-ssh-stage:
	gcloud compute ssh risd-webhook-instance-dockerify \
		--zone us-central1-a

gcp-create-firewall-rules:
	gcloud compute firewall-rules create allow-http-3000 --allow tcp:3000 --target-tags http-server-3000
	gcloud compute firewall-rules create allow-http --allow tcp:80 --target-tags http-server
	gcloud compute firewall-rules create allow-https --allow tcp:443 --target-tags https-server

gcp-list-firewall-rules:
	gcloud compute firewall-rules list
