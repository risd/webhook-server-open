# Webhook Overview

This repository is for Webhook's server component that handles regenerating and managing your sites. There are several other repositories in Webhook's core.

* [webhook](https://github.com/webhook/webhook) - The Webhook command line tools.
* [webhook-generate](https://github.com/webhook/webhook-generate) - The local runserver for Webhook.
* [webhook-cms](https://github.com/webhook/webhook-cms) - The CMS layer and frotend GUI. A single page Ember app.
* [webhook-server-open](https://github.com/webhook/webhook-server-open) - The production server for serving and regenerating live Webhook sites.
* [webhook-images](https://github.com/webhook/webhook-images) - Image resizing for the Webhook frontend. For Google App Engine.

If you are interested in self-hosting Webhook, [check the instructions here](http://www.webhook.com/docs/self-host-webhook/).

## Webhook Server

This repository contains the code needed to run a Webhook server.

A description of how to contribute and the various files that are in the repo can be found [here](https://github.com/webhook/webhook-server-open/blob/master/Contributing.md)

## Development

Install [node & npm](https://nodejs.org/en/download/), [beanstalkd](http://kr.github.io/beanstalkd/download.html) & [memcached](https://memcached.org/downloads).

When all are available on your path, `npm install`.

A `.env` file that includes the following values is expected in order to run in development and production.

```
GOOGLE_PROJECT_ID=
ELASTIC_SEARCH_SERVER=
MAILGUN_SECRET_KEY=
EMBEDLY_KEY=
FIREBASE=
FIREBASE_KEY=
FROM_EMAIL=
SITES_BUCKET=
BACKUPS_BUCKET=
UPLOADS_BUCKET=
GOOGLE_SERVICE_ACCOUNT=
GOOGLE_KEY_FILE=
ELASTIC_SEARCH_USER=
ELASTIC_SEARCH_PASSWORD=
CLOUDFLARE_EMAIL=
CLOUDFLARE_KEY=
CLOUDFLARE_ZONE=
```

The `GOOGLE_KEY_FILE` location can be defined by the path to the file produced by running `grunt extractKey=gcloud.json`, where `gcloud.json` is the Google Service Account JSON file associated with the project.


With everything in place, `npm run dev` will start all the processes as defined in `Procfile.dev`:

- memcached
- beanstalkd
- webhook_server
- command_delegator
- invite_worker
- create_worker
- build_worker
