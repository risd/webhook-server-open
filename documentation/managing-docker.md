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
