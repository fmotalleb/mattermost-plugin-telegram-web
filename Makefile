# Build one installable plugin archive per server platform. Plain make targets linux-amd64.
#   make / make release / make amd64   # Linux amd64
#   make arm / make arm64 / make riscv64
#   make darwin                        # macOS amd64 + arm64
#   make release-all / make server-all
#   make release PLATFORM=darwin-arm64  # choose one platform explicitly
#   make package PLATFORM=linux-arm64  # reuse the existing webapp bundle

.DEFAULT_GOAL := all

PLUGIN_ID      := $(shell node -e "process.stdout.write(require('./plugin.json').id)")
PLUGIN_VERSION := $(shell node -e "process.stdout.write(require('./plugin.json').version)")
PLATFORMS      := linux-amd64 linux-arm linux-arm64 linux-riscv64 darwin-amd64 darwin-arm64
PLATFORM       ?= linux-amd64
RELEASE_DIR    := release
WEBAPP_DIR     := webapp
BUNDLE_PATH    := $(WEBAPP_DIR)/dist/main.js
SERVER_DIR     := server
SERVER_DIST    := $(SERVER_DIR)/dist
SERVER_OUTPUTS := $(addprefix $(SERVER_DIST)/plugin-,$(PLATFORMS))
SERVER_TARGETS := $(addprefix server-,$(PLATFORMS))
RELEASE_TARGETS := $(addprefix release-,$(PLATFORMS))

ifeq ($(filter $(PLATFORM),$(PLATFORMS)),)
$(error Unsupported PLATFORM '$(PLATFORM)'; choose one of: $(PLATFORMS))
endif

.PHONY: all bundle server server-all $(SERVER_TARGETS) test test-smoke test-bundle test-server test-package check-types release release-all $(RELEASE_TARGETS) package amd64 arm arm64 riscv64 darwin version clean

all: release
amd64: release-linux-amd64
arm: release-linux-arm
arm64: release-linux-arm64
riscv64: release-linux-riscv64
darwin: release-darwin-amd64 release-darwin-arm64

# --------------------------------------------------------------------------- webapp bundle

$(WEBAPP_DIR)/node_modules: $(WEBAPP_DIR)/package.json
	cd $(WEBAPP_DIR) && npm install

bundle: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && npx webpack --mode=production

# --------------------------------------------------------------------------- server component

# CGO is off for cross-compilation. GOARM=7 applies only to the 32-bit Linux ARM build.
$(SERVER_OUTPUTS): $(SERVER_DIST)/plugin-%: $(wildcard $(SERVER_DIR)/*.go) $(SERVER_DIR)/go.mod $(SERVER_DIR)/go.sum Makefile
	@mkdir -p $(SERVER_DIST)
	@platform='$*'; target_os=$${platform%-*}; target_arch=$${platform#*-}; \
		cd $(SERVER_DIR) && CGO_ENABLED=0 GOOS=$$target_os GOARCH=$$target_arch GOARM=7 go build -trimpath -o dist/plugin-$* .

$(SERVER_TARGETS): server-%: $(SERVER_DIST)/plugin-%
server: server-$(PLATFORM)
server-all: $(SERVER_TARGETS)

# --------------------------------------------------------------------------- checks

check-types: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && npx tsc --noEmit

test: check-types test-smoke test-bundle test-server test-package

test-smoke: $(WEBAPP_DIR)/node_modules
	cd $(WEBAPP_DIR) && node test/todos.js && node test/unread-position.js && node test/scheduled-list.js && node test/profile-photos.js && node test/file-preview.js && node test/autolinks.js && node test/emoji-rendering.js && node test/chat-header-menu.js && node test/mermaid.js && node test/channel-notifications.js && node test/unread-settings.js && node test/send-options.js && node test/system-profiles.js && node test/commands.js && node test/quick-chat.js && node test/smoke.js

test-bundle: bundle
	cd $(WEBAPP_DIR) && node test/pdf-assets.js && node test/bundle.js

test-server:
	cd $(SERVER_DIR) && go test ./... && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null .

# --------------------------------------------------------------------------- package

version:
	@node scripts/version.js $(VERSION)

# Archives coexist in release/; platform-specific staging directories allow parallel builds.
release: release-$(PLATFORM)
release-all: $(RELEASE_TARGETS)
$(RELEASE_TARGETS): release-%: bundle server-%
	node scripts/package.js $* $(RELEASE_DIR)

# CI downloads the shared webapp build first, then builds just the selected server component.
package: server
	node scripts/package.js $(PLATFORM) $(RELEASE_DIR)

test-package:
	node scripts/test-package.js

clean:
	rm -rf $(RELEASE_DIR) $(WEBAPP_DIR)/dist $(SERVER_DIST) public/pdfjs
