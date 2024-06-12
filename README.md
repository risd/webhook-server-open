# @risd/wh Overview

This repository is for the Webhook command line tools. There are several other repositories in Webhook's core.

* [@risd/wh](https://github.com/risd/webhook) - The Webhook command line tools.
* [@risd/webhook-generate](https://github.com/risd/webhook-generate) - The local runserver for Webhook.
* [@risd/webhook-cms](https://github.com/risd/webhook-cms) - The CMS layer and frotend GUI. A single page Ember app.
* [@risd/webhook-server-open](https://github.com/risd/webhook-server-open) - The production server for serving and regenerating live Webhook sites.
* [webhook-images](https://github.com/risd/webhook-images) - Image resizing for the Webhook frontend. For Google App Engine.

These @risd forks of the project are currently maintained for the purposes of the Rhose Island School of Design. These forks have been developed with the intention of extending the orignal [webhook](http://www.webhook.com) platform to accomodate the team's needs. The work has been done in an open-source friendly way, keeping the details of any specific platform to the job of configuration, making it possible for others to piggy back on the work, given that they publish their own self-hosted instance.

If you are interested in self-hosting, [check the instructions here](http://www.webhook.com/docs/self-host-webhook/), per the original Webhook project.


## Webhook Server

This repository contains the code needed to run a Webhook server.

The Webhook Server runs several workers and web servers that are used in conjuction with the webhook-cms and webhook tools to generate static sites.

The workers handle things such as: Generating static sites on demand, uploading static sites to cloud storage, inviting users to work on sites, backing up data periodically, etc.

The web server handles things such as: Uploading images, searching using elastic search, and uploading sites to the workers.


## Development

Install [node & npm](https://nodejs.org/en/download/), [beanstalkd](http://kr.github.io/beanstalkd/download.html) & [memcached](https://memcached.org/downloads).

When all are available on your path, `npm install`.

A `.env` file that includes the values outlined in `.env.example` is expected in order to run in development and production.

```
GOOGLE_PROJECT_ID=
GOOGLE_SERVICE_ACCOUNT=
GOOGLE_KEY_JSON=
```

The `GOOGLE_KEY_JSON` is the service account JSON that includes a private key, project id, and service account email address.

```
DEVELOPMENT_DOMAIN
```

`DEVELOPMENT_DOMAIN` is used to configure tests. It represents the domain where sites are published to when they are created. `@risd/wh deploys` can be used to add more deploy targets to a site once it has been created.

```
ELASTIC_SEARCH_SERVER=
ELASTIC_SEARCH_USER=
ELASTIC_SEARCH_PASSWORD=
```

These entries will configure an Elastic Search server, used to power search within individual webhook CMS instances across that site's content.

```
MAILGUN_SECRET_KEY=
MAILGUN_DOMAIN=
FROM_EMAIL=
```

These entries will configure Mailgun, used to send emails that invite users to collaborate on a site. `FROM_EMAIL` is the email that will be used for sending the emails.

```
FIREBASE=
FIREBASE_SERVICE_ACCOUNT_KEY=
```

These entries will configure Firebase Admin SDK usage. `FIREBASE` is the name of the Firebase instance. `FIREBASE_SERVICE_ACCOUNT_KEY` is a file path to the JSON admin credentials.


```
SITES_BUCKET=
BACKUPS_BUCKET=
UPLOADS_BUCKET=
```

These entries will configure the Google Cloud Storage buckets used to manage the site. `SITES_BUCKETS` stores site templates. `BACKUPS_BUCKET` stores daily backups for the entire Firebase database. `UPLOADS_BUCKET` stores media that is uploaded to any of site's CMS. In addition to these buckets, each site that is published gets its own bucket, with the name of the site.

```
CLOUDFLARE_EMAIL=
CLOUDFLARE_KEY=
CLOUDFLARE_DOMAINS=
```

These entries will configure ClouldFlare, used to create CNAMEs for any domain that matches on `CLOUDFLARE_DOMAINS`. `CLOUDFLARE_DOMAINS` is expected to be an array of objects that contain a `domain` & `cname` key (`[{ domain, cname }]`). The `domain` key will be passed into [`minimatch`][minimatch] along with the domain of the site that is currently being built, if the result is `true`, a CNAME is made within CloudFlare, with the value set in the `cname` key of the object. If you can use CloudFlare for DNS management, the build and deploy process will support it. Otherwise, leave `CLOUDFLARE_DOMAINS` as an empty array to not use it.

```
FASTLY_TOKEN=
FASTLY_SERVICE_ID=
FASTLY_DOMAINS=
```

These entries will configure Fastly, used as the CDN for any domain that matches on `FASTLY_DOMAINS`. `FASTLY_DOMAINS` is expected to be an array of objects that contain a `domain`, `address` & `forceSSL` key ( `[{ domain, address, forceSSL }]` ). The `domain` key will be passed into [`minimatch`][minimatch] along with the domain of the site that is currently being built, if the result is `true`, the domain will be added to the Fastly service. The `address` value will be used when purging the cache for the service, this should be the IP of the Fastly service. The `forceSSL` key is a boolean that will determine if the domain should be configured to use SSL.

```
BUILDER_MAX_PARALLEL=10
```

These entries will configure `libs/builder.js`, `BUILDER_MAX_PARALLEL` will determine how many `grunt build-{page,template}` commands will be run concurrently.

With everything in place, `npm run dev` will start all the processes as defined in `Procfile.dev`.

[minimatch]:https://www.npmjs.com/package/minimatch