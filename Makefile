SHELL := /bin/bash
COMPOSE := docker compose

.DEFAULT_GOAL := help

.PHONY: help setup up down restart logs cli status reload-users test test-host certs clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Create .env, users.json (random passwords) and TLS certificates
	@./scripts/setup.sh

up: ## Build and start Asterisk + the web phone
	@./scripts/setup.sh >/dev/null
	$(COMPOSE) up -d --build --wait
	@./scripts/setup.sh

down: ## Stop everything
	$(COMPOSE) down

restart: ## Restart the containers (picks up config changes)
	$(COMPOSE) restart

logs: ## Follow the logs
	$(COMPOSE) logs -f --tail=100

cli: ## Open the Asterisk CLI
	$(COMPOSE) exec asterisk asterisk -rvvv

status: ## Show containers, registrations and active channels
	@$(COMPOSE) ps
	@$(COMPOSE) exec asterisk asterisk -rx "pjsip show contacts"
	@$(COMPOSE) exec asterisk asterisk -rx "core show channels"

reload-users: ## Apply users.json changes without a restart
	$(COMPOSE) exec asterisk asterisk-reload-users

certs: ## Re-issue the server certificate (keeps the local CA)
	@rm -f certs/server.crt certs/server.key
	@./scripts/gen-certs.sh $$(grep -E '^EXTERNAL_IP=' .env | cut -d= -f2-)
	$(COMPOSE) restart

test: ## Run the browser end-to-end tests in a container
	$(COMPOSE) --profile test run --rm --build e2e

test-host: ## Run the end-to-end tests with a local Chromium
	cd web && npm ci && npx playwright install chromium && npx playwright test

clean: ## Stop and delete containers and volumes
	$(COMPOSE) --profile test down -v
