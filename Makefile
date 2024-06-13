build:
	docker build -t risd-webhook .

# run as long running process
# can access shell within Docker app
run:
	docker container run --name risd-webhook-stage -p 80:3000 risd-webhook

# interactive
run-it:
	docker container run --name risd-webhook-stage -it risd-webhook /bin/bash