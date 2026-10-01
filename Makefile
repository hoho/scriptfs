PNPM ?= pnpm
PNPM_RANGE := >=12.4.0 <13
NODE_MIN_MAJOR := 22
PODMAN_MACHINE ?=
PUBLISH_ARGS ?= --access public

.DEFAULT_GOAL := help

.PHONY: help check-deps install-deps start-podman pnpm-install install \
	format format-check lint typecheck build test check \
	test-e2e test-e2e-rebuild example \
	bump-version check-version pack-dry-run publish-dry-run publish

help:
	@printf '%s\n' \
		'Dependencies:' \
		'  make check-deps        Check Node.js, pnpm, Podman, and the Podman runtime' \
		'  make install-deps      Install Node.js and Podman with Homebrew, then install pnpm' \
		'  make start-podman      Initialize/start a Podman VM if the runtime is unavailable' \
		'  make pnpm-install      Install locked pnpm dependencies' \
		'' \
		'Development:' \
		'  make format            Format the project' \
		'  make format-check      Check formatting' \
		'  make lint              Run ESLint' \
		'  make typecheck         Run the TypeScript type checker' \
		'  make build             Build the package' \
		'  make test              Run unit tests' \
		'  make check             Run all portable checks' \
		'  make test-e2e          Run the real e2e using the cached runtime image' \
		'  make test-e2e-rebuild  Rebuild the runtime image and run the real e2e' \
		'  make example           Build and run examples/config.json' \
		'' \
		'Publishing:' \
		'  make bump-version VERSION=x.y.z  Update package and runtime image versions' \
		'  make check-version     Verify package and runtime image versions match' \
		'  make pack-dry-run      Preview the exact npm package contents' \
		'  make publish-dry-run   Build, validate, and preview the npm package' \
		'  make publish           Build, validate, and publish to public npm'

check-deps:
	@command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
	@node -e "const major=Number(process.versions.node.split('.')[0]); if(major < $(NODE_MIN_MAJOR)){console.error('Node.js >= $(NODE_MIN_MAJOR) is required; found '+process.versions.node); process.exit(1)}"
	@command -v $(PNPM) >/dev/null || { echo 'pnpm $(PNPM_RANGE) is required; run make install-deps.' >&2; exit 1; }
	@version="$$($(PNPM) --version)" || { echo 'Could not determine the pnpm version; resolve the bootstrap error above.' >&2; exit 1; }; \
		node -e "const version=process.argv[1]; const match=/^12\.(\d+)\.\d+(?:\+[0-9A-Za-z.-]+)?$$/.exec(version); if(!match || Number(match[1])<4){console.error('pnpm $(PNPM_RANGE) is required; found '+version); process.exit(1)}" "$$version"
	@command -v podman >/dev/null || { echo 'Podman is required; run make install-deps.' >&2; exit 1; }
	@podman info >/dev/null || { echo 'Podman is installed but unavailable; run make start-podman.' >&2; exit 1; }
	@echo 'Dependencies are ready.'

install-deps:
	@command -v brew >/dev/null || { echo 'Automatic dependency installation requires Homebrew. Install Node.js >= $(NODE_MIN_MAJOR), pnpm $(PNPM_RANGE), and Podman, then rerun make check-deps.' >&2; exit 1; }
	@brew list --versions node >/dev/null 2>&1 || brew install node
	@brew list --versions podman >/dev/null 2>&1 || brew install podman
	npm install --global --ignore-scripts=false --registry="$$(npm config get registry)" "pnpm@$(PNPM_RANGE)"
	@echo 'Run make start-podman, then make check-deps.'

start-podman:
	@command -v podman >/dev/null || { echo 'Podman is required; run make install-deps.' >&2; exit 1; }
	@set -e; \
		if podman info >/dev/null 2>&1; then \
			echo 'Podman is already available.'; \
			exit 0; \
		fi; \
		command -v node >/dev/null || { echo 'Node.js is required; run make install-deps.' >&2; exit 1; }; \
		machines="$$(podman machine list --format json)"; \
		machine="$$(printf '%s' "$$machines" | node -e "\
			const machines=JSON.parse(require('node:fs').readFileSync(0,'utf8')); \
			if(!Array.isArray(machines) || machines.some(m=>typeof m?.Name !== 'string' || !m.Name)) throw new Error('Invalid Podman machine list'); \
			const requested=process.argv[1]; \
			const selected=requested ? machines.find(m=>m.Name===requested) : machines.find(m=>m.Default===true) ?? (machines.length===1 ? machines[0] : undefined); \
			if(machines.length && !selected){console.error('Cannot select a Podman VM. Existing machines: '+machines.map(m=>m.Name).join(', ')+'. Use make start-podman PODMAN_MACHINE=<name>.'); process.exit(1);} \
			console.log(selected?.Name ?? '');" "$(PODMAN_MACHINE)")"; \
		if [ -z "$$machine" ]; then \
			machine="$(PODMAN_MACHINE)"; \
			[ -n "$$machine" ] || machine=podman-machine-default; \
			podman machine init "$$machine"; \
		fi; \
		podman machine start --update-connection "$$machine"; \
		podman info >/dev/null; \
		echo 'Podman is ready.'

pnpm-install: check-deps
	$(PNPM) install --frozen-lockfile

install: pnpm-install

format:
	$(PNPM) format

format-check:
	$(PNPM) format:check

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

build:
	$(PNPM) build

test:
	$(PNPM) test

check:
	$(PNPM) check

test-e2e:
	$(PNPM) test:e2e

test-e2e-rebuild:
	$(PNPM) test:e2e:rebuild

example: build
	node dist/cli.js examples/config.json

bump-version:
	@test -n "$(VERSION)" || { echo 'VERSION is required; use make bump-version VERSION=x.y.z.' >&2; exit 1; }
	node scripts/bump-version.mjs "$(VERSION)"

check-version:
	node scripts/bump-version.mjs --check

pack-dry-run:
	$(PNPM) pack --dry-run

publish-dry-run: check-version
	$(PNPM) publish --dry-run --no-git-checks $(PUBLISH_ARGS)

publish: check-version
	$(PNPM) publish --no-git-checks $(PUBLISH_ARGS)
