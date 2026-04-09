DESKTOP_DIR := apps/desktop

.PHONY: install fmt fmt-check build desktop-build test check tauri-dev

install:
	npm --prefix $(DESKTOP_DIR) install

fmt:
	cargo fmt --all
	npm --prefix $(DESKTOP_DIR) run format:write

fmt-check:
	cargo fmt --all -- --check
	npm --prefix $(DESKTOP_DIR) run format

build:
	cargo build --workspace
	npm --prefix $(DESKTOP_DIR) run build

desktop-build:
	npm --prefix $(DESKTOP_DIR) run tauri build -- --debug

test:
	cargo test --workspace
	npm --prefix $(DESKTOP_DIR) run test

check:
	cargo check --workspace
	npm --prefix $(DESKTOP_DIR) run typecheck

tauri-dev:
	npm --prefix $(DESKTOP_DIR) run tauri dev
