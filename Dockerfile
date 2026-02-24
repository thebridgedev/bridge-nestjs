# syntax=docker/dockerfile:1

# Base image supports ARM + x86-64
FROM node:22 as base

# Install zsh for parity with other bridge dev containers
RUN apt-get update && apt-get install -y zsh
SHELL ["/bin/zsh", "-c"]

# Common tooling
RUN apt-get update && \
    apt-get -y install iproute2 lsof vim less curl jq dumb-init && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ARG APP_USER=bridgeuser
WORKDIR /home/bridgeuser/app

# Create non-root user
RUN groupadd -r $APP_USER && useradd -r -s /bin/bash -g $APP_USER $APP_USER && \
    mkdir -p /home/$APP_USER && \
    chown -R $APP_USER:$APP_USER /home/$APP_USER

# Optional: bun for scripts matching other bridge projects
RUN npm i -g bun

# Dev stage
FROM base as dev
USER $APP_USER
COPY . .
CMD ["zsh"]
