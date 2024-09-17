# Managing Docker

```bash
$ make gcp-ssh-prod
$ sudo docker container ls
# using the last argument, you can exec using that container
# show all processes
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl status
# check logs for individual processes
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl tail -f http_server
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl tail -f command_delegator
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl tail -f build_worker:build_worker_00
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl tail -f build_worker:build_worker_01
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl tail -f build_worker:build_worker_02
$ sudo docker exec klt-risd-webhook-instance-prod-soqr supervisorctl tail -f build_worker:build_worker_03
```


# Development

```Makefile
build:
  docker buildx build --tag risd-webhook-prod --build-arg BRANCH=master --platform linux/amd64,linux/arm64 .

run-prod-mounted:
  docker container run \
    --name risd-webhook-prod-vm \
    --publish 80:80 \
    --env-file .env.rackspace.prod-v3 \
    --env DEBUG=* \
    --label risd-webhook=prod \
    --mount src="$(shell pwd)",target=/home/webhook/webhook-server-open,type=bind \
    risd-webhook-prod
```

use `make build` to build a conatiner you can use. then `make run-prod-mounted`, this will mount the current repo as the directory that is used to run webhook stuff. then use `docker container ls` to get the container name, and run commands within it. you could start by turning off processes with `docker exec risd-webhook-prod-vm supervisorctl stop all`. and then run individual individual commands that you can run to test various functionality. either running tests `npx tape test/*` or using the `./bin` interfaces to run a build `./bin/build-command {args}`.
