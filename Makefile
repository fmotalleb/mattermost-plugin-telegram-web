# Makefile for the Telegram Web UI Mattermost plugin.
#
# The webapp bundle plus a small Go server component (view tracking). The Go toolchain is only
# needed for `make server` / `make release`; webapp-only targets (`make bundle`, `make test`)
# work without it.
#
#   make            # build the webapp bundle, the server binaries and the tarball
#   make bundle     # only build webapp/dist/main.js
#   make server     # build server/dist/plugin-<goos>-<goarch>
#   make test       # type check + smoke/bundle tests (needs a previous `make bundle`)
#   make release    # package release/<id>-<version>.tar.gz
#   make version VERSION=1.2.3   # apply a version to plugin.json + webapp/package.json
#   make clean      # remove build output

PLUGIN_ID      := $(shell node -e "process.stdout.write(require('./plugin.json').id)")
PLUGIN_VERSION := $(shell node -e "process.stdout.write(require('./plugin.json').version)")
BUNDLE_NAME    := $(PLUGIN_ID)-$(PLUGIN_VERSION).tar.gz
RELEASE_DIR    := release

WEBAPP_DIR    := webapp
BUNDLE_PATH   := $(WEBAPP_DIR)/dist/main.js
SERVER_DIR    := server
SERVER_DIST   := $(SERVER_DIR)/dist
SERVER_OUTPUT := $(SERVER_DIST)/plugin-linux-amd64 $(SERVER_DIST)/plugin-linux-arm64

# Files that go into the installable tarball, laid out the way a Mattermost server expects them.
PACKAGE_FILES := plugin.json assets $(BUNDLE_PATH)

.PHONY: all bundle server test test-smoke test-bundle check-types release version clean

all: release

# --------------------------------------------------------------------------- webapp bundle

$(WEBAPP_DIR)/node_modules: $(WEBAPP_DIR)/package.json
	cd $(WEBAPP_DIR) && npm install

bundle: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && npx webpack --mode=production

# --------------------------------------------------------------------------- server component

# CGO is off so we can cross-compile both linux architectures from any host.
$(SERVER_DIST)/plugin-linux-amd64: $(SERVER_DIR)/*.go $(SERVER_DIR)/go.mod $(SERVER_DIR)/go.sum
	@mkdir -p $(SERVER_DIST)
	cd $(SERVER_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o dist/plugin-linux-amd64 .

$(SERVER_DIST)/plugin-linux-arm64: $(SERVER_DIR)/*.go $(SERVER_DIR)/go.mod $(SERVER_DIR)/go.sum
	@mkdir -p $(SERVER_DIST)
	cd $(SERVER_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o dist/plugin-linux-arm64 .

server: $(SERVER_OUTPUT)

# --------------------------------------------------------------------------- checks

check-types: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && npx tsc --noEmit

test: check-types test-smoke test-bundle test-server

test-smoke: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && node test/smoke.js

test-bundle: bundle
	cd $(WEBAPP_DIR) && node test/bundle.js

test-server:
	cd $(SERVER_DIR) && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null .

# --------------------------------------------------------------------------- package

# Apply a version (e.g. from a git tag) to plugin.json and webapp/package.json.
version:
	@node scripts/version.js $(VERSION)

release: bundle server
	@rm -rf $(RELEASE_DIR)
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)
	@cp plugin.json $(RELEASE_DIR)/$(PLUGIN_ID)/
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)/assets
	@cp -r assets/. $(RELEASE_DIR)/$(PLUGIN_ID)/assets/
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)/$(WEBAPP_DIR)/dist
	@cp $(BUNDLE_PATH) $(RELEASE_DIR)/$(PLUGIN_ID)/$(WEBAPP_DIR)/dist/main.js
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)/server/dist
	@cp $(SERVER_OUTPUT) $(RELEASE_DIR)/$(PLUGIN_ID)/server/dist/
	@cd $(RELEASE_DIR)/$(PLUGIN_ID) && tar -czf ../$(BUNDLE_NAME) .
	@rm -rf $(RELEASE_DIR)/$(PLUGIN_ID)
	@echo "packaged $(RELEASE_DIR)/$(BUNDLE_NAME)"

clean:
	rm -rf $(RELEASE_DIR) $(WEBAPP_DIR)/dist $(SERVER_DIST)
