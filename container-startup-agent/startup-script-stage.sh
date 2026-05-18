#!/bin/bash

# Enable incoming traffic
iptables -A INPUT -j ACCEPT

DOCKER_ZONE=us-central1

# branch-based
CONTAINER_IMAGE=$DOCKER_ZONE"-docker.pkg.dev/risd-media-webhook/risd-webhook-docker-repo/risd-webhook-stage:v3-0-8"

# stable VARS
## Set home directory to save docker credentials & env
export HOME=/home/appuser
CONTAINER_NAME="risd-systems-container"
COS_ENV_PATH=$HOME/env

docker stop $CONTAINER_NAME || true
docker rm $CONTAINER_NAME || true

# Configure docker with credentials for gcr.io and pkg.dev
docker-credential-gcr configure-docker --registries $DOCKER_ZONE"-docker.pkg.dev"

docker pull $CONTAINER_IMAGE

# save ENV metadata
sudo curl -o $COS_ENV_PATH http://metadata.google.internal/computeMetadata/v1/instance/attributes/COS_ENV -H "Metadata-Flavor: Google"

docker run   --name=$CONTAINER_NAME   --privileged   --restart=always   --tty   --detach   --network="host"   --env-file=$COS_ENV_PATH   $CONTAINER_IMAGE
