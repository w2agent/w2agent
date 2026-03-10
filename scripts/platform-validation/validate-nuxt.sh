#!/usr/bin/env bash
# validate-nuxt.sh — Test w2agent integration across 10 Nuxt 3 repo configurations
# Run from OSS repo root: bash scripts/platform-validation/validate-nuxt.sh [options]
set -euo pipefail

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"
RESULTS_FILE="$SCRIPT_DIR/results-nuxt.md"
TMP_BASE="/tmp/w2agent-validate-nuxt"
PORT_START=15000

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
      echo "Usage: validate-nuxt.sh [options]"
      echo "  --repo <name>    Run only this repo (e.g. --repo nuxt3-init)"
      echo "  --keep           Keep temp dirs even on success (default: delete on success)"
      echo "  --results <file> Write results to this file (default: results-nuxt.md in script dir)"
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
    *)    (cd "$app_dir" && npm install --prefer-offline 2>&1 | tail -3) ;;
  esac
}

# --- Setup functions ---

setup_nuxi_init() {
  local dir="$1"
  mkdir -p "$dir"
  # nuxi may prompt for package manager — pipe newlines to accept defaults
  printf '\n\n\n\n' | npx --yes nuxi@latest init "$dir/app" 2>&1 | tail -5
}

setup_nuxi_content() {
  local dir="$1"
  mkdir -p "$dir"
  printf '\n\n\n\n' | npx --yes nuxi@latest init -t content "$dir/app" 2>&1 | tail -5
}

# repo_spec format: "owner/repo:optional/subdir"
do_clone() {
  local repo="$1"    # e.g. nuxt/starter
  local subdir="$2"  # e.g. some/subdir (empty = use whole repo)
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
# Format: "name|type|version|setup_fn|setup_arg"
# setup_fn: setup_nuxi_init | setup_nuxi_content | clone
# setup_arg for clone: "owner/repo:subdir" (empty subdir = root of repo)
declare -a REPOS=(
  "nuxt3-init|Basic SSR|3|setup_nuxi_init|"
  "nuxt3-content|Content site|3|setup_nuxi_content|"
  "nuxt-starter|Minimal template|3|clone|nuxt/starter:"
  "nuxt-movies|App (TMDB)|3|clone|nuxt/movies:"
  "content-wind|Blog/content|3|clone|Atinux/content-wind:"
  "nuxt-docus|Documentation|3|clone|nuxt-themes/docus:"
  "elk|Mastodon client|3|clone|elk-zone/elk:"
  "nuxt-vitesse|Opinionated starter|3|clone|antfu/vitesse-nuxt3:"
  "nuxt-ui|UI component demo|3|clone|nuxt/ui:"
  "nuxt-sidebase|Full-stack starter|3|clone|sidebase/nuxt-auth-example:"
)

# --- Per-repo runner ---
run_repo() {
  local name="$1"
  local type="$2"
  local version="$3"
  local setup_fn="$4"
  local setup_arg="${5:-}"

  local dir="$TMP_BASE/$name"
  local app_dir="$dir/app"
  local r_setup="—" r_integrate="—" r_install="—" r_build="—" r_prod="—" r_dev="—"

  log "=== $name ($type, Nuxt $version) ==="
  printf '\n---\n\n## %s — %s (Nuxt %s)\n\n' "$name" "$type" "$version" >> "$RESULTS_FILE"

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
  else
    if $setup_fn "$dir" 2>&1; then
      pass "Setup" "generated via $setup_fn"
      setup_ok=1; r_setup="✅"
    else
      fail "Setup" "$setup_fn failed"; r_setup="❌"
    fi
  fi

  if [[ $setup_ok -eq 0 ]]; then
    na "Integrate (--install)"; na "Install deps"; na "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_prod|$r_dev")
    return
  fi

  # 2. Integrate
  log "  Integrate..."
  local integrate_out
  integrate_out=$($CLI integrate http://example.com \
    --platform nuxt --install --project-dir "$app_dir" 2>&1 || true)

  if echo "$integrate_out" | grep -qiE "^error|unhandled|ENOENT|Cannot find"; then
    fail "Integrate (--install)" "${integrate_out:0:120}"; r_integrate="❌"
    na "Install deps"; na "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_prod|$r_dev")
    return
  fi

  local files_written
  files_written=$(echo "$integrate_out" | grep -oE "(middleware|route|llms)" | sort -u | tr '\n' ' ' || echo "")
  pass "Integrate (--install)" "files written: ${files_written:-see output}"
  r_integrate="✅"

  # 3. Install deps — use detected package manager
  if install_deps "$app_dir"; then
    pass "Install deps"
    r_install="✅"
  else
    fail "Install deps"
    r_install="❌"
    na "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_prod|$r_dev")
    return
  fi

  # 4. Build — use PM-aware run command, fall back to `npx nuxt build`
  local pm
  pm=$(detect_pkg_manager "$app_dir")
  log "  Building ($pm run build || npx nuxt build)..."
  if (cd "$app_dir" && { $pm run build 2>/dev/null || npx nuxt build; } 2>&1 | tail -5); then
    pass "Build"
    r_build="✅"
  else
    fail "Build"
    r_build="❌"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_prod|$r_dev")
    return
  fi

  # 5–7. Production server (nuxt preview — allow 30s, heavier than next start)
  local PORT
  PORT=$(find_port)
  log "  Starting production server on :$PORT..."
  (cd "$app_dir" && npx nuxt preview --port "$PORT" >/dev/null 2>/dev/null) &
  SERVER_PID=$!

  if wait_for_server "$PORT" 30; then
    pass "Start (production)" "port $PORT"
    local prod_fail_before=$FAIL_COUNT
    check_endpoints "$PORT" "production"
    [[ $FAIL_COUNT -eq $prod_fail_before ]] && r_prod="✅" || r_prod="❌"
  else
    fail "Start (production)" "server did not respond within 30s"
    r_prod="❌"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
  fi

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""

  # 8–11. Dev server (Vite startup can be slower — allow 60s)
  PORT=$(find_port)
  log "  Starting dev server on :$PORT..."
  (cd "$app_dir" && npx nuxt dev --port "$PORT" >/dev/null 2>/dev/null) &
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

  ROWS+=("$name|$r_setup|$r_integrate|$r_install|$r_build|$r_prod|$r_dev")

  # Cleanup
  if [[ $SKIP_CLEANUP -eq 0 ]]; then
    rm -rf "$dir"
    log "  Cleaned up $dir"
  else
    log "  Kept temp dir: $dir (--keep)"
  fi
}

# --- Main ---

mkdir -p "$(dirname "$RESULTS_FILE")"
cat > "$RESULTS_FILE" << HEADER
# Nuxt 3 Platform Validation Results

Generated: $(date)
CLI: packages/cli/dist/index.js
HEADER

log "Starting Nuxt 3 platform validation"
log "Results: $RESULTS_FILE"
[[ -n "$SINGLE_REPO" ]] && log "Single repo mode: $SINGLE_REPO"

mkdir -p "$TMP_BASE"

for entry in "${REPOS[@]}"; do
  IFS='|' read -r name type version setup_fn setup_arg <<< "$entry"
  [[ -n "$SINGLE_REPO" && "$name" != "$SINGLE_REPO" ]] && continue
  run_repo "$name" "$type" "$version" "$setup_fn" "$setup_arg"
done

# Write summary table
{
  printf '\n---\n\n## Summary Table\n\n'
  printf '| Repo | Setup | Integrate | Install | Build | Prod /llms.txt | Dev /llms.txt |\n'
  printf '|------|-------|-----------|---------|-------|----------------|---------------|\n'
  for row in "${ROWS[@]}"; do
    IFS='|' read -r rname rsetup rinteg rinstall rbuild rprod rdev <<< "$row"
    printf '| %-24s | %-5s | %-9s | %-7s | %-5s | %-14s | %-13s |\n' \
      "$rname" "$rsetup" "$rinteg" "$rinstall" "$rbuild" "$rprod" "$rdev"
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
