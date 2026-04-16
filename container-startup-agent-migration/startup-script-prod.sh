#!/bin/bash

# Enable incoming traffic
iptables -A INPUT -j ACCEPT

# branch-based
CONTAINER_IMAGE="us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-server/risd-webhook-prod:v3.0.3"

CONTAINER_NAME="risd-systems-container"

docker stop $CONTAINER_NAME || true
docker rm $CONTAINER_NAME || true

docker pull $(CONTAINER_IMAGE)

# env comes from ./bin/env-to-docker-args ./.env.rackspace.prod-v3
docker run \
  --name=$CONTAINER_NAME \
  --privileged \
  --restart=always \
  --tty \
  --detach \
  --network="host" \
  --env GOOGLE_PROJECT_ID --env GOOGLE_SERVICE_ACCOUNT --env GOOGLE_KEY_JSON_STRING --env GOOGLE_BUCKET_DEFAULT_CORS --env DEVELOPMENT_DOMAIN --env MAILGUN_SECRET_KEY --env MAILGUN_DOMAIN --env FROM_EMAIL --env REPLY_EMAIL --env FIREBASE --env FIREBASE_SERVICE_ACCOUNT_KEY --env FIREBASE_SERVICE_ACCOUNT_KEY_STRING --env SITES_BUCKET --env BACKUPS_BUCKET --env UPLOADS_BUCKET --env CLOUDFLARE_EMAIL --env CLOUDFLARE_KEY --env CLOUDFLARE_DOMAINS --env FASTLY_TOKEN --env FASTLY_SERVICE_ID --env FASTLY_DOMAINS --env BUILDER_MAX_PARALLEL --env ELASTIC_SEARCH_SERVER --env ELASTIC_SEARCH_API_KEY --env WEBHOOK_SERVER_PORT --env WEBHOOK_SERVER_HOST --env MEMCACHED_SERVERS --env BEANSTALK_SERVER \
  $CONTAINER_IMAGE
