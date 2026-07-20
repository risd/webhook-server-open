# debug start up script

`$ sudo journalctl | grep startup-script`

`$ sudo docker exec risd-systems-container supervisorctl status`

`$ sudo docker exec risd-systems-container supervisorctl tail -f http_server`

`$ sudo docker exec risd-systems-container supervisorctl tail -f build_worker:build_worker_00`
`$ sudo docker exec risd-systems-container supervisorctl tail -f build_worker:build_worker_01`
`$ sudo docker exec risd-systems-container supervisorctl tail -f build_worker:build_worker_02`
`$ sudo docker exec risd-systems-container supervisorctl tail -f build_worker:build_worker_03`

`$ sudo docker exec risd-systems-container supervisorctl tail -f command_delegator`
`$ sudo docker exec risd-systems-container supervisorctl tail -f create_worker`
`$ sudo docker exec risd-systems-container supervisorctl tail -f cron`
`$ sudo docker exec risd-systems-container supervisorctl tail -f domain_map_worker`
`$ sudo docker exec risd-systems-container supervisorctl tail -f invite_worker`
`$ sudo docker exec risd-systems-container supervisorctl tail -f memcached`
`$ sudo docker exec risd-systems-container supervisorctl tail -f preview_build_worker`
`$ sudo docker exec risd-systems-container supervisorctl tail -f redirects_worker`
`$ sudo docker exec risd-systems-container supervisorctl tail -f reindex_worker`

`$ sudo docker exec risd-systems-container npx grunt echoConfig`

`$ sudo docker exec risd-systems-container supervisorctl stop command_delegator`

`$ sudo docker exec risd-systems-container ./bin/build-command --userId=rrodrigu@risd.edu --siteName=risd-nature-lab.risd.systems --branch=develop --siteBucket=naturelab.risd.systems`

sudo docker run \
  --name=risd-systems-container \
  --privileged \
  --restart=always \
  --tty \
  --detach \
  --network="host" \
  --env-file env \
  us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-docker-repo/risd-webhook-prod:v3-0-4

COS_ENV=`curl -f http://metadata.google.internal/computeMetadata/v1/instance/attributes/COS_ENV -H "Metadata-Flavor: Google" 2>/dev/null`

sudo docker run \
  --name=risd-systems-container \
  --privileged \
  --restart=always \
  --tty \
  --detach \
  --network="host" \
  --env-file $COS_ENV \
  us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-docker-repo/risd-webhook-prod:v3-0-4

sudo docker run \
  --name=risd-systems-container \
  --privileged \
  --restart=always \
  --tty \
  --detach \
  --network="host" \
  --env $COS_ENV \
  us-central1-docker.pkg.dev/risd-media-webhook/risd-webhook-docker-repo/risd-webhook-prod:v3-0-4