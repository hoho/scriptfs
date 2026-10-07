PNPM ?= pnpm
CARGO ?= cargo
RUNTIME_IMAGE ?= localhost/scriptfs-runtime:0.1.0
RUNTIME_TEST_IMAGE ?= $(RUNTIME_IMAGE)-test
E2E_ARGS ?=
EXAMPLE ?= showcase
UNIT_ARGS ?=
JS_UNIT_ARGS ?=
NATIVE_BINARY := $(if $(filter Windows_NT,$(OS)),dist/scriptfs.exe,dist/scriptfs)
PNPM_RANGE := >=12.4.0 <13
NODE_MIN_MAJOR := 22
PODMAN_MACHINE ?=
PUBLISH_ARGS ?= --access public
NPM_TAG ?= $(shell node -p "require('./package.json').version.includes('-') ? 'next' : 'latest'")
RELEASE_TAG ?=
NATIVE_TARGET ?=
RELEASE_IMAGE ?=
BENCH_BASELINE ?= HEAD
BENCH_ROUNDS ?= 6
BENCH_SCALE ?= 1
BENCH_REPORT ?= target/benchmark/results.json
BENCH_FAILED_ROOT ?=
BENCH_PROFILE_REPORT ?= target/benchmark/profile.json

.DEFAULT_GOAL := help

.PHONY: benchmark-report benchmark-clean-failed benchmark-profile

.PHONY: help check-deps install-deps start-podman pnpm-install install \
	format format-check lint typecheck build build-native build-image test test-js test-rust check check-rust ci worker-lock example-locks \
	test-e2e test-e2e-rebuild test-examples example \
	bump-version check-version pack-dry-run publish-dry-run publish native-package check-native-packages \
	build-release-image release-image-reference check-release-image \
	build-js build-test-image build-rust-tests check-rust-linux pnpm-lock cargo-lock install-native status dev test-sdk-config test-js-selected test-rust-selected test-rust-linux-selected ci-expose-make ci-pnpm ci-rust ci-install ci-linux ci-linux-setup ci-windows-setup stop-podman runtime-check benchmark-info benchmark-prepare benchmark-run benchmark test-benchmark

help:
	@printf '%s\n' \
		'Dependencies:' \
		'  make check-deps        Check Node.js, pnpm, Podman, and the Podman runtime' \
		'  make install-deps      Install Node.js and Podman with Homebrew, then install pnpm' \
		'  make start-podman      Initialize/start a Podman VM if the runtime is unavailable' \
		'  make pnpm-install      Install locked pnpm dependencies' \
		'  make pnpm-lock         Refresh the pnpm lockfile after dependency changes' \
		'  make worker-lock       Refresh the runtime image'"'"'s npm lockfile' \
		'  make example-locks     Refresh the example modules'"'"' npm lockfiles' \
		'' \
		'Development:' \
		'  make format            Format the project' \
		'  make format-check      Check formatting' \
		'  make lint              Run ESLint' \
		'  make typecheck         Run the TypeScript type checker' \
		'  make build             Build the Rust binary and JavaScript SDK/launcher' \
		'  make build-native      Build just the Rust binary' \
		'  make build-image       Build the Rust FUSE/Samba runtime image' \
		'  make build-test-image  Build the isolated native syscall test image' \
		'  make test              Run all JavaScript and Rust unit tests' \
		'  make test-js           Run SDK transport and build-tooling unit tests' \
		'  make test-rust         Run Rust core and module protocol unit tests' \
		'  make check-rust        Check Rust formatting and run Clippy' \
		'  make check-rust-linux  Check/test Linux Rust code and patched FUSE' \
		'  make check             Run all portable checks' \
		'  make test-e2e          Run the real e2e using the cached runtime image' \
		'  make test-e2e-rebuild  Rebuild the runtime image and run the real e2e' \
		'  make test-examples     Run the example modules'"'"' @scriptfs/testing suites' \
		'  make ci                Run every portable check and fresh-image e2e test' \
		'  make benchmark         Compare FUSE/SMB performance against BENCH_BASELINE (default HEAD)' \
		'  make benchmark-profile Profile module callbacks and owned application processes' \
		'  make example           Build and run examples/$$EXAMPLE/config.json (default: showcase)' \
		'' \
		'Publishing:' \
		'  make bump-version VERSION=x.y.z  Update package, runtime image, and @scriptfs range versions' \
		'  make check-version     Verify package and runtime image versions match' \
		'  make native-package NATIVE_TARGET=<rust-target>  Build one @scriptfs/<os>-<cpu> binary' \
		'  make check-native-packages  Validate all six platform binaries before publishing' \
		'  make build-release-image  Build the published runtime image from a packages/native/linux-<cpu> binary' \
		'  make release-image-reference RELEASE_IMAGE=<name>@sha256:<digest>  Pin the pushed runtime image' \
		'  make check-release-image  Verify the pinned runtime image matches the package version' \
		'  make pack-dry-run      Preview the exact npm package contents' \
		'  make publish-dry-run   Validate and preview all npm packages' \
		'  make publish           Validate and publish all npm packages (used by the release workflow)'

check-deps:
	@command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
	@node -e "const major=Number(process.versions.node.split('.')[0]); if(major < $(NODE_MIN_MAJOR)){console.error('Node.js >= $(NODE_MIN_MAJOR) is required; found '+process.versions.node); process.exit(1)}"
	@command -v $(PNPM) >/dev/null || { echo 'pnpm $(PNPM_RANGE) is required; run make install-deps.' >&2; exit 1; }
	@version="$$($(PNPM) --version)" || { echo 'Could not determine the pnpm version; resolve the bootstrap error above.' >&2; exit 1; }; \
		node -e "const version=process.argv[1]; const match=/^12\.(\d+)\.\d+(?:\+[0-9A-Za-z.-]+)?$$/.exec(version); if(!match || Number(match[1])<4){console.error('pnpm $(PNPM_RANGE) is required; found '+version); process.exit(1)}" "$$version"
	@command -v podman >/dev/null || { echo 'Podman is required; run make install-deps.' >&2; exit 1; }
	@command -v $(CARGO) >/dev/null || { echo 'Rust and Cargo are required; install Rust, then rerun make check-deps.' >&2; exit 1; }
	@podman info >/dev/null || { echo 'Podman is installed but unavailable; run make start-podman.' >&2; exit 1; }
	@echo 'Dependencies are ready.'

install-deps:
	@command -v brew >/dev/null || { echo 'Automatic dependency installation requires Homebrew. Install Node.js >= $(NODE_MIN_MAJOR), pnpm $(PNPM_RANGE), and Podman, then rerun make check-deps.' >&2; exit 1; }
	@brew list --versions node >/dev/null 2>&1 || brew install node
	@brew list --versions podman >/dev/null 2>&1 || brew install podman
	@brew list --versions rust >/dev/null 2>&1 || brew install rust
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

ci-expose-make:
	node -e "require('node:fs').appendFileSync(process.env.GITHUB_PATH, process.env.MSYS2_LOCATION + '/usr/bin\n')"

ci-pnpm:
	npm install --prefix "$(RUNNER_TEMP)/scriptfs-pnpm" --no-audit --no-fund --registry="$$(npm config get registry)" pnpm@12.4.0
	@if [ "$(RUNNER_OS)" = Windows ]; then npm rebuild --prefix "$(RUNNER_TEMP)/scriptfs-pnpm" --ignore-scripts --no-audit --no-fund pnpm; fi
	@echo "$(RUNNER_TEMP)/scriptfs-pnpm/node_modules/.bin" >> "$(GITHUB_PATH)"

ci-rust:
	rustup toolchain install 1.93.1 --profile minimal --component clippy --component rustfmt
	rustup default 1.93.1

ci-install:
	$(PNPM) install --frozen-lockfile

ci-linux:
	sudo env "PATH=$$PATH" "CI=true" "NPM_CONFIG_USERCONFIG=$$(npm config get userconfig)" $(MAKE) check-rust-linux test-e2e

ci-linux-setup:
	sudo apt-get update
	sudo apt-get install -y podman cifs-utils
	sudo modprobe fuse
	sudo modprobe cifs
	test -c /dev/fuse
	sudo podman info

ci-windows-setup:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows.ps1

stop-podman:
	@if command -v podman >/dev/null; then podman machine stop; fi

runtime-check:
	./$(NATIVE_BINARY) --check

benchmark-info:
	git --no-pager log -5 --format='%h %s'
	git rev-parse "$(BENCH_BASELINE)"
	git --no-pager diff --stat "$(BENCH_BASELINE)" -- rust src container vendor Cargo.toml Cargo.lock package.json pnpm-lock.yaml

benchmark-prepare: check-deps
	BENCH_BASELINE="$(BENCH_BASELINE)" BENCH_MAKE="$(MAKE)" BENCH_PNPM="$(PNPM)" node scripts/benchmark.mjs prepare

benchmark-run:
	BENCH_BASELINE="$(BENCH_BASELINE)" BENCH_ROUNDS="$(BENCH_ROUNDS)" BENCH_SCALE="$(BENCH_SCALE)" BENCH_REPORT="$(BENCH_REPORT)" node scripts/benchmark.mjs run

benchmark: benchmark-prepare
	$(MAKE) benchmark-run

benchmark-report:
	BENCH_REPORT="$(BENCH_REPORT)" node scripts/benchmark.mjs report

benchmark-profile:
	BENCH_BASELINE="$(BENCH_BASELINE)" BENCH_REPORT="$(BENCH_PROFILE_REPORT)" node scripts/benchmark.mjs profile

benchmark-clean-failed:
	BENCH_BASELINE="$(BENCH_BASELINE)" node scripts/benchmark.mjs clean-failed "$(BENCH_FAILED_ROOT)"

test-benchmark:
	node --input-type=module -e "import assert from 'node:assert/strict'; import {median,isMeasurements} from './scripts/benchmark-workload.mjs'; import {summarize} from './scripts/benchmark.mjs'; assert.equal(median([3,1,2]),2); assert.equal(median([4,1,2,3]),2.5); assert.throws(()=>median([])); assert.throws(()=>median([NaN])); const rows=ms=>[{name:'read',operations:2,bytes:2097152,elapsedMs:ms}]; const sample=(version,round,ms)=>({version,round,startupMs:ms,memoryKiB:1024,runtime:{node:'same',samba:'same'},fuse:rows(ms),smb:rows(ms)}); const samples=[sample('before',0,20),sample('after',0,10),sample('before',1,40),sample('after',1,20)]; assert.equal(summarize(samples).workloads[0].speedup,2); assert.equal(summarize(samples).workloads[0].beforeMs,30); assert.throws(()=>summarize(samples.slice(1))); assert.throws(()=>summarize([samples[0],samples[1],samples[0],samples[1]])); assert.throws(()=>summarize([samples[0],{...samples[1],runtime:{node:'different',samba:'same'}}])); assert.equal(isMeasurements(rows(1)),true); assert.equal(isMeasurements(rows(-1)),false); assert.equal(isMeasurements([{name:'read'}]),false); console.log('Benchmark accounting checks passed.');"
	node --input-type=module -e "import assert from 'node:assert/strict'; import {isProfiles} from './scripts/benchmark-profile-workload.mjs'; const counter={calls:1,timeNs:2,bytes:3,fileCalls:1,directoryCalls:0,lengths:{4096:1}}; const process={name:'scriptfs',cpuNs:1,readCalls:2,writeCalls:3,readChars:4,writeChars:5,voluntarySwitches:6,involuntarySwitches:7}; const row={name:'whole/read',operations:1,elapsedMs:1,counters:{whole:{read:counter}},processes:{123:process}}; const rows=Array.from({length:7},()=>structuredClone(row)); assert.equal(isProfiles(rows),true); assert.equal(isProfiles(rows.slice(1)),false); for(const invalid of [{...row,operations:0},{...row,elapsedMs:NaN},{...row,counters:{whole:{read:{...counter,calls:-1}}}},{...row,processes:{123:{...process,cpuNs:-1}}},{...row,processes:{123:{name:'scriptfs'}}}]) assert.equal(isProfiles([invalid,...rows.slice(1)]),false); console.log('Diagnostic output checks passed.');"

install: pnpm-install

format:
	$(CARGO) fmt
	$(PNPM) exec prettier --write .

format-check:
	$(CARGO) fmt --check
	$(PNPM) exec prettier --check .

lint:
	$(PNPM) exec eslint .

typecheck:
	$(PNPM) exec tsc --noEmit

build: build-js
	$(MAKE) install-native

build-js:
	$(PNPM) exec tsdown

dev:
	$(PNPM) exec vite

build-native:
	$(CARGO) build --release --locked

install-native:
	CARGO="$(CARGO)" node scripts/build-native.mjs

build-image: build-js
	podman build --target runtime --build-arg "NPM_REGISTRY=$$(npm config get registry)" --tag "$(RUNTIME_IMAGE)" --file container/Containerfile .

build-test-image: build-image
	podman build --target runtime-test --build-arg "NPM_REGISTRY=$$(npm config get registry)" --tag "$(RUNTIME_TEST_IMAGE)" --file container/Containerfile .

build-rust-tests: build-js
	podman build --target rust-check-runtime --tag "$(RUNTIME_IMAGE)-checks" --build-arg "NPM_REGISTRY=$$(npm config get registry)" --file container/Containerfile .

check-rust-linux: build-rust-tests
	@set -e; \
		apparmor="$$(podman info --format '{{.Host.Security.AppArmorEnabled}}')"; \
		set -- --rm --cap-add SYS_ADMIN --device /dev/fuse --security-opt label=disable; \
		if [ "$$apparmor" = true ]; then set -- "$$@" --security-opt apparmor=unconfined; fi; \
		podman run "$$@" "$(RUNTIME_IMAGE)-checks"

test-rust-linux-selected: build-rust-tests
	@set -e; \
		apparmor="$$(podman info --format '{{.Host.Security.AppArmorEnabled}}')"; \
		set -- --rm --cap-add SYS_ADMIN --device /dev/fuse --security-opt label=disable; \
		if [ "$$apparmor" = true ]; then set -- "$$@" --security-opt apparmor=unconfined; fi; \
		podman run "$$@" --entrypoint /opt/scriptfs/scriptfs-tests "$(RUNTIME_IMAGE)-checks" $(UNIT_ARGS)

cargo-lock:
	$(CARGO) update --package fuser --offline

pnpm-lock:
	$(PNPM) install --lockfile-only --ignore-scripts
	node scripts/strip-lock-registry.mjs pnpm-lock.yaml

worker-lock:
	npm --prefix container install --package-lock-only --ignore-scripts --no-audit --no-fund --registry="$$(npm config get registry)"
	node scripts/strip-lock-registry.mjs container/npm-shrinkwrap.json

example-locks:
	for lock in examples/*/module/npm-shrinkwrap.json; do \
		npm --prefix "$${lock%/*}" install --package-lock-only --ignore-scripts --no-audit --no-fund \
			&& node scripts/strip-lock-registry.mjs "$$lock" || exit 1; \
	done

test-js:
	$(PNPM) exec vitest run --exclude "test/e2e/**"

test-js-selected:
	$(PNPM) exec vitest run $(JS_UNIT_ARGS)

test-sdk-config:
	node --input-type=module -e "import assert from 'node:assert/strict'; import path from 'node:path'; import {loadConfig,scriptFsConfigSchema} from './dist/index.js'; const config=await loadConfig('examples/showcase/config.json'); assert.ok(config.filesystems.every(fs=>path.isAbsolute(fs.source))); assert.ok(Object.values(config.modules).every(module=>path.isAbsolute(module.manifest))); const input={modules:{memory:{manifest:'./examples/showcase/modules/memory'}},filesystems:[{name:'code',source:'.',mountPoint:'mount',rules:[{match:'file',provider:{module:'memory',options:null}}]}]}; const parsed=scriptFsConfigSchema.parse(input); assert.equal(parsed.filesystems[0].rules[0].provider.options,null); assert.equal('hide' in parsed.filesystems[0].rules[0],false); assert.equal('path' in parsed.filesystems[0].rules[0].provider,false); assert.equal(scriptFsConfigSchema.safeParse({filesystems:[]}).success,false); console.log('Native SDK configuration bridge passed.');"

test-rust:
	$(CARGO) test --locked

test-rust-selected:
	$(CARGO) test --locked $(UNIT_ARGS)

test: test-js test-rust

check-rust:
	$(CARGO) fmt --check
	$(CARGO) clippy --all-targets --no-deps --locked -- -D warnings

check:
	$(MAKE) check-version format-check lint typecheck build test-sdk-config test-benchmark test check-rust

ci: check check-rust-linux
	$(MAKE) test-e2e-rebuild

test-e2e: build build-test-image
	SCRIPTFS_E2E_RUNTIME_IMAGE="$(RUNTIME_TEST_IMAGE)" node scripts/run-e2e.mjs $(E2E_ARGS)

test-e2e-rebuild:
	$(MAKE) test-e2e

test-examples: build build-test-image
	SCRIPTFS_E2E_RUNTIME_IMAGE="$(RUNTIME_TEST_IMAGE)" node scripts/run-e2e.mjs --examples

example: build
	./$(NATIVE_BINARY) examples/$(EXAMPLE)/config.json

bump-version:
	@test -n "$(VERSION)" || { echo 'VERSION is required; use make bump-version VERSION=x.y.z.' >&2; exit 1; }
	node scripts/bump-version.mjs "$(VERSION)"

check-version:
	node scripts/bump-version.mjs --check $(RELEASE_TAG)

native-package:
	@test -n "$(NATIVE_TARGET)" || { echo 'NATIVE_TARGET is required, such as make native-package NATIVE_TARGET=x86_64-unknown-linux-musl.' >&2; exit 1; }
	rustup target add "$(NATIVE_TARGET)"
	CARGO="$(CARGO)" node scripts/build-native.mjs --target "$(NATIVE_TARGET)"

check-native-packages:
	node scripts/build-native.mjs --check

# The published runtime image copies the Linux binary for the Podman machine's
# architecture from packages/native/linux-<cpu> (see make native-package).
build-release-image: build-js
	podman build --target runtime-release --build-arg "NPM_REGISTRY=$$(npm config get registry)" --tag "$(RUNTIME_IMAGE)-release" --file container/Containerfile .

release-image-reference:
	@test -n "$(RELEASE_IMAGE)" || { echo 'RELEASE_IMAGE is required, such as make release-image-reference RELEASE_IMAGE=ghcr.io/hoho/scriptfs-runtime@sha256:<digest>.' >&2; exit 1; }
	node scripts/release-image.mjs --write "$(RELEASE_IMAGE)"

check-release-image:
	node scripts/release-image.mjs --check

pack-dry-run: build-js
	$(PNPM) -r pack --dry-run

# Publishing needs the binaries for every platform, which the release workflow builds
# and validates with the full CI matrix. pnpm publishes the workspace in dependency
# order (platform packages before scriptfs) and skips versions already in the registry.
# A real publish also needs the runtime image pinned by make release-image-reference.
publish-dry-run: check-version check-native-packages build-js
	$(PNPM) -r publish --dry-run --no-git-checks --tag "$(NPM_TAG)" $(PUBLISH_ARGS)

publish: check-version check-native-packages check-release-image build-js
	$(PNPM) -r publish --no-git-checks --tag "$(NPM_TAG)" $(PUBLISH_ARGS)

status:
	git --no-pager status --short
	git --no-pager diff --stat
	git --no-pager diff --check
