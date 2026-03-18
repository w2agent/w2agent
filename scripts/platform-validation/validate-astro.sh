#!/usr/bin/env bash
# validate-astro.sh — Test w2agent integration across 10 Astro repo configurations
# Run from OSS repo root: bash scripts/platform-validation/validate-astro.sh [options]
set -euo pipefail

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"
RESULTS_FILE="$SCRIPT_DIR/results-astro.md"
TMP_BASE="/tmp/w2agent-validate-astro"
PORT_START=16000

# --- State ---
SINGLE_REPO=""
SKIP_CLEANUP=0
SERVER_PID=""
PASS_COUNT=0
FAIL_COUNT=0
declare -a ROWS=()

# --- Args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    SINGLE_REPO="$2"; shift 2 ;;
    --keep)    SKIP_CLEANUP=1; shift ;;
    --results) RESULTS_FILE="$2"; shift 2 ;;
    --help)
      echo "Usage: validate-astro.sh [options]"
      echo "  --repo <name>    Run only this repo (e.g. --repo astro-minimal)"
      echo "  --keep           Keep temp dirs even on success (default: delete on success)"
      echo "  --results <file> Write results to this file (default: results-astro.md in script dir)"
      echo "  --help           Show this help"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Prereqs ---
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required (brew install jq)"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node required"; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "ERROR: git required"; exit 1; }
command -v nc   >/dev/null 2>&1 || { echo "ERROR: nc required"; exit 1; }

[[ -f "$REPO_ROOT/packages/cli/dist/index.js" ]] || {
  echo "ERROR: CLI not built. Run: cd $REPO_ROOT && pnpm build"
  exit 1
}

# --- Trap ---
cleanup_all() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap cleanup_all EXIT INT TERM

# --- Helpers ---
log() { echo "[$(date '+%H:%M:%S')] $*"; }

pass() {
  local label="$1"; shift
  local detail="${*:-}"
  log "  PASS: $label${detail:+ — $detail}"
  echo "- **$label**: PASS${detail:+ — $detail}" >> "$RESULTS_FILE"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  local label="$1"; shift
  local detail="${*:-}"
  log "  FAIL: $label${detail:+ — $detail}"
  echo "- **$label**: FAIL${detail:+ — $detail}" >> "$RESULTS_FILE"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

na() {
  local label="$1"; shift
  local detail="${*:-}"
  echo "- **$label**: N/A${detail:+ — $detail}" >> "$RESULTS_FILE"
}

find_port() {
  local p=$PORT_START
  while nc -z localhost "$p" 2>/dev/null; do
    p=$((p + 1))
  done
  echo "$p"
}

# Poll until HTTP server responds (any status counts — just needs to accept connections)
wait_for_server() {
  local port="$1"
  local max="${2:-20}"
  local i=0
  while [[ $i -lt $max ]]; do
    if curl -s "http://localhost:$port/" >/dev/null 2>&1; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Check /llms.txt and /.well-known/agent-card.json for a running server
check_endpoints() {
  local port="$1"
  local mode="$2"  # "production" or "dev"

  # /llms.txt — expect 200 + body starting with "# "
  local code body
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/llms.txt" 2>/dev/null || echo "000")
  body=$(curl -s "http://localhost:$port/llms.txt" 2>/dev/null || echo "")
  if [[ "$code" == "200" && "$body" == "# "* ]]; then
    pass "[$mode] /llms.txt" "200, content: \"${body:0:60}\""
  else
    fail "[$mode] /llms.txt" "HTTP $code"
  fi

  # /.well-known/agent-card.json — expect 200 + valid JSON
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/.well-known/agent-card.json" 2>/dev/null || echo "000")
  body=$(curl -s "http://localhost:$port/.well-known/agent-card.json" 2>/dev/null || echo "")
  if [[ "$code" == "200" ]] && echo "$body" | jq . >/dev/null 2>&1; then
    pass "[$mode] /.well-known/agent-card.json" "200, valid JSON"
  else
    fail "[$mode] /.well-known/agent-card.json" "HTTP $code"
  fi
}

# Detect package manager from lockfiles in app_dir
detect_pkg_manager() {
  local app_dir="$1"
  if [[ -f "$app_dir/pnpm-lock.yaml" ]]; then
    echo "pnpm"
  elif [[ -f "$app_dir/yarn.lock" ]]; then
    echo "yarn"
  else
    echo "npm"
  fi
}

# Install deps using the detected package manager
install_deps() {
  local app_dir="$1"
  local pm
  pm=$(detect_pkg_manager "$app_dir")
  log "  Installing deps with $pm..."
  case "$pm" in
    pnpm) (cd "$app_dir" && pnpm install --no-frozen-lockfile 2>&1 | tail -3) ;;
    yarn) (cd "$app_dir" && yarn install --no-immutable 2>&1 | tail -3) ;;
    *)    (cd "$app_dir" && npm install 2>&1 | tail -3) || \
          (cd "$app_dir" && npm install --legacy-peer-deps 2>&1 | tail -3) ;;
  esac
}

# --- Setup functions ---

# Create a generated Astro project from a template (static output)
# Must use -- separator before Astro CLI flags; --skip-houston suppresses welcome banner
setup_astro_create() {
  local template="$1"
  local dir="$2"
  mkdir -p "$dir"
  printf '\n\n\n\n' | npm create astro@latest "$dir/app" -- \
    --template "$template" --no-install --no-git --skip-houston 2>&1 | tail -5
}

# Create a generated Astro project patched to SSR with @astrojs/node adapter
setup_astro_ssr() {
  local dir="$1"
  mkdir -p "$dir"
  # Step 1: create minimal project (no install)
  printf '\n\n\n\n' | npm create astro@latest "$dir/app" -- \
    --template minimal --no-install --no-git --skip-houston 2>&1 | tail -5
  # Step 2: install deps + @astrojs/node adapter
  (cd "$dir/app" && npm install 2>&1 | tail -3)
  (cd "$dir/app" && npm install @astrojs/node 2>&1 | tail -3)
  # Step 3: patch astro.config.mjs to inject node adapter
  local config="$dir/app/astro.config.mjs"
  sed -i.bak \
    's|import { defineConfig } from.*|import { defineConfig } from "astro/config";\nimport node from "@astrojs/node";|' \
    "$config"
  sed -i.bak2 \
    's|defineConfig({|defineConfig({ output: "server", adapter: node({ mode: "standalone" }),|' \
    "$config"
  log "  Patched astro.config.mjs for SSR"
}

# repo_spec format: "owner/repo:optional/subdir"
do_clone() {
  local repo="$1"    # e.g. satnaing/astro-paper
  local subdir="$2"  # e.g. examples/blog (empty = use whole repo)
  local dir="$3"
  mkdir -p "$dir"
  git clone --depth 1 "https://github.com/$repo" "$dir/repo" 2>&1 | tail -3
  if [[ -n "$subdir" ]]; then
    cp -r "$dir/repo/$subdir" "$dir/app"
  else
    mv "$dir/repo" "$dir/app"
  fi
}

# --- REPOS (10 entries) ---
# Format: "name|type|mode|setup_fn|setup_arg"
# mode: static | ssr — controls production server launch and dist check
# setup_fn: astro_create | astro_ssr | clone
# setup_arg: template name (for astro_create) or "owner/repo:subdir" (for clone)
declare -a REPOS=(
  "astro-minimal|Minimal generated|static|astro_create|minimal"
  "astro-blog|Blog generated|static|astro_create|blog"
  "astro-starlight|Starlight docs generated|static|astro_create|starlight"
  "astro-ssr|SSR generated (node)|ssr|astro_ssr|"
  "astro-paper|Popular blog (satnaing)|static|clone|satnaing/astro-paper:"
  "astrowind|Marketing site (onwidget)|static|clone|onwidget/astrowind:"
  "astro-blog-template|Minimal blog (Charca)|static|clone|Charca/astro-blog-template:"
  "withastro-blog-example|Official blog example|static|clone|withastro/astro:examples/blog"
  "accessible-astro|Accessibility starter|static|clone|incluud/accessible-astro-starter:"
  "astroship|Landing page starter|static|clone|surjithctly/astroship:"
)

# --- Per-repo runner ---
run_repo() {
  local name="$1"
  local type="$2"
  local mode="$3"
  local setup_fn="$4"
  local setup_arg="${5:-}"

  local dir="$TMP_BASE/$name"
  local app_dir="$dir/app"
  local r_setup="—" r_integrate="—" r_install="—" r_build="—" r_dist="—" r_prod="—" r_dev="—"

  log "=== $name ($type, $mode) ==="
  printf '\n---\n\n## %s — %s (%s)\n\n' "$name" "$type" "$mode" >> "$RESULTS_FILE"

  # 1. Setup
  log "  Setup..."
  local setup_ok=0
  if [[ "$setup_fn" == "clone" ]]; then
    local repo="${setup_arg%%:*}"
    local subdir="${setup_arg#*:}"
    [[ "$subdir" == "$repo" ]] && subdir=""  # no colon case
    if do_clone "$repo" "$subdir" "$dir" 2>&1; then
      pass "Setup" "cloned $repo${subdir:+/$subdir}"
      setup_ok=1; r_setup="✅"
    else
      fail "Setup" "clone failed"; r_setup="❌"
    fi
  elif [[ "$setup_fn" == "astro_create" ]]; then
    if setup_astro_create "$setup_arg" "$dir" 2>&1; then
      pass "Setup" "generated via npm create astro --template $setup_arg"
      setup_ok=1; r_setup="✅"
    else
      fail "Setup" "npm create astro failed"; r_setup="❌"
    fi
  elif [[ "$setup_fn" == "astro_ssr" ]]; then
    if setup_astro_ssr "$dir" 2>&1; then
      pass "Setup" "generated SSR project with @astrojs/node"
      setup_ok=1; r_setup="✅"
    else
      fail "Setup" "SSR setup failed"; r_setup="❌"
    fi
  else
    fail "Setup" "unknown setup_fn: $setup_fn"; r_setup="❌"
  fi

  if [[ $setup_ok -eq 0 ]]; then
    na "Integrate (--install)"; na "Install deps"; na "Build"; na "dist/llms.txt"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_dist|$r_prod|$r_dev")
    return
  fi

  # 2. Integrate
  log "  Integrate..."
  local integrate_out
  integrate_out=$($CLI integrate http://example.com \
    --platform astro --install --project-dir "$app_dir" 2>&1 || true)

  if echo "$integrate_out" | grep -qiE "^error|unhandled|ENOENT|Cannot find"; then
    fail "Integrate (--install)" "${integrate_out:0:120}"; r_integrate="❌"
    na "Install deps"; na "Build"; na "dist/llms.txt"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_dist|$r_prod|$r_dev")
    return
  fi

  local files_written
  files_written=$(echo "$integrate_out" | grep -oE "(middleware|route|llms)" | sort -u | tr '\n' ' ' || echo "")
  pass "Integrate (--install)" "files written: ${files_written:-see output}"
  r_integrate="✅"

  # 3. Install deps (skip for astro_ssr — already installed during setup)
  if [[ "$setup_fn" == "astro_ssr" ]]; then
    pass "Install deps" "already installed during SSR setup"
    r_install="✅"
  elif install_deps "$app_dir"; then
    pass "Install deps"
    r_install="✅"
  else
    fail "Install deps"
    r_install="❌"
    na "Build"; na "dist/llms.txt"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_dist|$r_prod|$r_dev")
    return
  fi

  # 4. Build
  log "  Building (astro build)..."
  if (cd "$app_dir" && npx astro build 2>&1 | tail -5); then
    pass "Build"
    r_build="✅"
  else
    fail "Build"
    r_build="❌"
    na "dist/llms.txt"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_dist|$r_prod|$r_dev")
    return
  fi

  # 4b. Static dist check (Astro-specific: public/ is copied to dist/ at build time)
  if [[ "$mode" == "static" ]]; then
    if [[ -f "$app_dir/dist/llms.txt" ]]; then
      pass "dist/llms.txt" "file exists in dist/"
      r_dist="✅"
    else
      fail "dist/llms.txt" "not found in dist/ after build"
      r_dist="❌"
    fi
  else
    na "dist/llms.txt" "SSR mode — no static dist/llms.txt"
    r_dist="N/A"
  fi

  # 5–7. Production server
  local PORT
  PORT=$(find_port)
  if [[ "$mode" == "ssr" ]]; then
    log "  Starting SSR production server (node standalone) on :$PORT..."
    # @astrojs/node standalone server reads HOST and PORT env vars
    (cd "$app_dir" && HOST=localhost PORT="$PORT" node dist/server/entry.mjs >/dev/null 2>&1) &
    SERVER_PID=$!
    local prod_timeout=30
  else
    log "  Starting static preview server on :$PORT..."
    # --host localhost needed to bind to localhost
    (cd "$app_dir" && npx astro preview --host localhost --port "$PORT" >/dev/null 2>&1) &
    SERVER_PID=$!
    local prod_timeout=20
  fi

  if wait_for_server "$PORT" "$prod_timeout"; then
    pass "Start (production)" "port $PORT"
    local prod_fail_before=$FAIL_COUNT
    check_endpoints "$PORT" "production"
    [[ $FAIL_COUNT -eq $prod_fail_before ]] && r_prod="✅" || r_prod="❌"
  else
    fail "Start (production)" "server did not respond within ${prod_timeout}s"
    r_prod="❌"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
  fi

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""

  # 8–11. Dev server (Vite startup can be slow — allow 60s)
  PORT=$(find_port)
  log "  Starting dev server on :$PORT..."
  (cd "$app_dir" && npx astro dev --host localhost --port "$PORT" >/dev/null 2>&1) &
  SERVER_PID=$!

  if wait_for_server "$PORT" 60; then
    pass "Start (dev)" "port $PORT"
    local dev_fail_before=$FAIL_COUNT
    check_endpoints "$PORT" "dev"
    [[ $FAIL_COUNT -eq $dev_fail_before ]] && r_dev="✅" || r_dev="❌"
  else
    fail "Start (dev)" "server did not respond within 60s"
    r_dev="❌"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
  fi

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""

  ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_dist|$r_prod|$r_dev")

  # Cleanup
  if [[ $SKIP_CLEANUP -eq 0 ]]; then
    rm -rf "$dir" || true
    log "  Cleaned up $dir"
  else
    log "  Kept temp dir: $dir (--keep)"
  fi
}

# --- Main ---

mkdir -p "$(dirname "$RESULTS_FILE")"
cat > "$RESULTS_FILE" << HEADER
# Astro Platform Validation Results

Generated: $(date)
CLI: packages/cli/dist/index.js
Platform: astro (static + 1 SSR)
HEADER

log "Starting Astro platform validation"
log "Results: $RESULTS_FILE"
[[ -n "$SINGLE_REPO" ]] && log "Single repo mode: $SINGLE_REPO"

mkdir -p "$TMP_BASE"

for entry in "${REPOS[@]}"; do
  IFS='|' read -r name type mode setup_fn setup_arg <<< "$entry"
  [[ -n "$SINGLE_REPO" && "$name" != "$SINGLE_REPO" ]] && continue
  run_repo "$name" "$type" "$mode" "$setup_fn" "$setup_arg"
done

# Write summary table
{
  printf '\n---\n\n## Summary Table\n\n'
  printf '| Repo | Setup | Integrate | Install | Build | dist/llms.txt | Prod | Dev |\n'
  printf '|------|-------|-----------|---------|-------|---------------|------|-----|\n'
  for row in "${ROWS[@]}"; do
    IFS='|' read -r rname rsetup rinteg rinstall rbuild rdist rprod rdev <<< "$row"
    printf '| %-30s | %-5s | %-9s | %-7s | %-5s | %-13s | %-4s | %-3s |\n' \
      "$rname" "$rsetup" "$rinteg" "$rinstall" "$rbuild" "$rdist" "$rprod" "$rdev"
  done
} >> "$RESULTS_FILE"

cat >> "$RESULTS_FILE" << FOOTER

---

## Summary

- **PASS**: $PASS_COUNT
- **FAIL**: $FAIL_COUNT
- **Total checks**: $((PASS_COUNT + FAIL_COUNT))
FOOTER

log "=== Done: $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
log "Results: $RESULTS_FILE"
