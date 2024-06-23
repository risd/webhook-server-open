FROM buildpack-deps:bullseye AS os

FROM os AS node

RUN groupadd --gid 1000 node \
  && useradd --uid 1000 --gid node --shell /bin/bash --create-home node

ENV NODE_VERSION 20.14.0

RUN ARCH= && dpkgArch="$(dpkg --print-architecture)" \
  && case "${dpkgArch##*-}" in \
    amd64) ARCH='x64';; \
    ppc64el) ARCH='ppc64le';; \
    s390x) ARCH='s390x';; \
    arm64) ARCH='arm64';; \
    armhf) ARCH='armv7l';; \
    i386) ARCH='x86';; \
    *) echo "unsupported architecture"; exit 1 ;; \
  esac \
  # use pre-existing gpg directory, see https://github.com/nodejs/docker-node/pull/1895#issuecomment-1550389150
  && export GNUPGHOME="$(mktemp -d)" \
  # gpg keys listed at https://github.com/nodejs/node#release-keys
  && set -ex \
  && for key in \
    4ED778F539E3634C779C87C6D7062848A1AB005C \
    141F07595B7B3FFE74309A937405533BE57C7D57 \
    74F12602B6F1C4E913FAA37AD3A89613643B6201 \
    DD792F5973C6DE52C432CBDAC77ABFA00DDBF2B7 \
    61FC681DFB92A079F1685E77973F295594EC4689 \
    8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600 \
    C4F0DFFF4E8C1A8236409D08E73BC641CC11F4C8 \
    890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4 \
    C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C \
    108F52B48DB57BB0CC439B2997B01419BD92F80A \
    A363A499291CBBC940DD62E41F10027AF002F8B0 \
    CC68F5A3106FF448322E48ED27F5E38D5B0A215F \
  ; do \
      gpg --batch --keyserver hkps://keys.openpgp.org --recv-keys "$key" || \
      gpg --batch --keyserver keyserver.ubuntu.com --recv-keys "$key" ; \
  done \
  && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" \
  && curl -fsSLO --compressed "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.asc" \
  && gpg --batch --decrypt --output SHASUMS256.txt SHASUMS256.txt.asc \
  && gpgconf --kill all \
  && rm -rf "$GNUPGHOME" \
  && grep " node-v$NODE_VERSION-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
  && tar -xJf "node-v$NODE_VERSION-linux-$ARCH.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
  && rm "node-v$NODE_VERSION-linux-$ARCH.tar.xz" SHASUMS256.txt.asc SHASUMS256.txt \
  && ln -s /usr/local/bin/node /usr/local/bin/nodejs \
  # smoke tests
  && node --version \
  && npm --version

FROM node AS webhook

# setup dependencies
RUN apt-get -y update && apt-get install -y \
  beanstalkd \
  build-essential \
  cron \
  git \
  memcached \
  supervisor \
  unzip \
  && npm install -g grunt-cli reap

# setup reverse proxy with caddy
RUN apt install -y \
  debian-keyring \
  debian-archive-keyring \
  apt-transport-https \
  curl
RUN curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
RUN curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
RUN apt update
RUN apt install caddy

RUN groupadd --gid 1001 webhook \
 && useradd --uid 1001 --gid webhook --shell /bin/bash --create-home webhook

USER webhook

WORKDIR /home/webhook/

## working from git
ARG BRANCH=master
RUN git clone https://github.com/risd/webhook-server-open.git --branch $BRANCH webhook-server-open
WORKDIR /home/webhook/webhook-server-open/
RUN npm install \
  && crontab cron.example \
  && mkdir -p /home/webhook/build-folders
## working from local dir
# COPY . /home/webhook/webhook-server-open
# RUN mkdir -p /home/webhook/build-folders

FROM webhook AS finalize

USER root
WORKDIR /home/webhook/webhook-server-open/

# stop services that will run via supervisor
RUN service beanstalkd stop \
  && service supervisor stop \
  && service memcached stop
RUN cp webhook.conf /etc/supervisor/conf.d/ \
  && mkdir -p /var/beanstalk \
  && mkdir -p /var/log/supervisor \
  && mkdir -p /var/log/memcached

# ssh
EXPOSE 22
# http
EXPOSE 80
# https
EXPOSE 443

## run individual commands
# USER webhook
# CMD ["npm", "start"]
## run a single command for everything
CMD ["/usr/bin/supervisord", "-n"]
