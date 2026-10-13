# Makefile for the Telegram Web UI Mattermost plugin.
#
# The plugin is webapp-only (no Go server component), so this Makefile does not need the Go
# toolchain that the standard mattermost-plugin-starter-template Makefile requires. It builds the
# webapp bundle and packages the installable plugin tarball.
#
#   make            # build the webapp bundle and the tarball
#   make bundle     # only build webapp/dist/main.js
#   make test       # type check + smoke/bundle tests (needs a previous `make bundle`)
#   make release    # package release/<id>-<version>.tar.gz
#   make version VERSION=1.2.3   # apply a version to plugin.json + webapp/package.json
#   make clean      # remove build output

PLUGIN_ID      := $(shell node -e "process.stdout.write(require('./plugin.json').id)")
PLUGIN_VERSION := $(shell node -e "process.stdout.write(require('./plugin.json').version)")
BUNDLE_NAME    := $(PLUGIN_ID)-$(PLUGIN_VERSION).tar.gz
RELEASE_DIR    := release

WEBAPP_DIR  := webapp
BUNDLE_PATH := $(WEBAPP_DIR)/dist/main.js

# Files that go into the installable tarball, laid out the way a Mattermost server expects them.
PACKAGE_FILES := plugin.json assets $(BUNDLE_PATH)

.PHONY: all bundle test test-smoke test-bundle check-types release version clean

all: release

# --------------------------------------------------------------------------- webapp bundle

$(WEBAPP_DIR)/node_modules: $(WEBAPP_DIR)/package.json
	cd $(WEBAPP_DIR) && npm install

bundle: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && npx webpack --mode=production

# --------------------------------------------------------------------------- checks

check-types: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && npx tsc --noEmit

test: check-types test-smoke test-bundle

test-smoke: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && node test/smoke.js

test-bundle: bundle
	cd $(WEBAPP_DIR) && node test/bundle.js

# --------------------------------------------------------------------------- package

# Apply a version (e.g. from a git tag) to plugin.json and webapp/package.json.
version:
	@node scripts/version.js $(VERSION)

release: bundle
	@rm -rf $(RELEASE_DIR)
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)
	@cp plugin.json $(RELEASE_DIR)/$(PLUGIN_ID)/
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)/assets
	@cp -r assets/. $(RELEASE_DIR)/$(PLUGIN_ID)/assets/
	@mkdir -p $(RELEASE_DIR)/$(PLUGIN_ID)/$(WEBAPP_DIR)/dist
	@cp $(BUNDLE_PATH) $(RELEASE_DIR)/$(PLUGIN_ID)/$(WEBAPP_DIR)/dist/main.js
	@cd $(RELEASE_DIR)/$(PLUGIN_ID) && tar -czf ../$(BUNDLE_NAME) .
	@rm -rf $(RELEASE_DIR)/$(PLUGIN_ID)
	@echo "packaged $(RELEASE_DIR)/$(BUNDLE_NAME)"

clean:
	rm -rf $(RELEASE_DIR) $(WEBAPP_DIR)/dist
