#!/usr/bin/env bash
# validate-nextjs.sh — Test w2agent integration across 10 Next.js repo configurations
# Run from OSS repo root: bash scripts/platform-validation/validate-nextjs.sh [options]
set -euo pipefail

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"
RESULTS_FILE="$SCRIPT_DIR/results-nextjs.md"
TMP_BASE="/tmp/w2agent-validate-nextjs"
PORT_START=14000

# --- State ---
SINGLE_REPO=""
SKIP_CLEANUP=0
SERVER_PID=""
PASS_COUNT=0
FAIL_COUNT=0

# --- Args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    SINGLE_REPO="$2"; shift 2 ;;
    --keep)    SKIP_CLEANUP=1; shift ;;
    --results) RESULTS_FILE="$2"; shift 2 ;;
    --help)
      echo "Usage: validate-nextjs.sh [options]"
      echo "  --repo <name>    Run only this repo (e.g. --repo nextjs14-app)"
      echo "  --keep           Keep temp dirs even on success (default: delete on success)"
      echo "  --results <file> Write results to this file (default: results-nextjs.md in script dir)"
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

# --- Setup functions ---

setup_generated_app14() {
  local dir="$1"
  mkdir -p "$dir"
  echo "" | npx --yes create-next-app@14 "$dir/app" \
    --ts --app --no-tailwind --no-eslint --use-npm --no-import-alias --yes 2>&1 | tail -5
}

setup_generated_app15() {
  local dir="$1"
  mkdir -p "$dir"
  # Pass --yes last; pipe empty stdin in case any prompt slips through
  echo "" | npx --yes create-next-app@15 "$dir/app" \
    --ts --app --no-tailwind --no-eslint --use-npm --no-import-alias --yes 2>&1 | tail -5
}

setup_generated_pages() {
  local dir="$1"
  mkdir -p "$dir"
  echo "" | npx --yes create-next-app@14 "$dir/app" \
    --ts --no-app --no-tailwind --no-eslint --use-npm --yes 2>&1 | tail -5
}

setup_generated_src() {
  local dir="$1"
  mkdir -p "$dir"
  npx --yes create-next-app@14 "$dir/app" \
    --ts --app --src-dir --no-tailwind --no-eslint --use-npm --no-import-alias 2>&1 | tail -5
}

# setup_clone is called directly in run_repo (different arg signature)
# repo_spec format: "owner/repo:optional/subdir"
do_clone() {
  local repo="$1"    # e.g. vercel/next.js
  local subdir="$2"  # e.g. examples/blog-starter (empty = use whole repo)
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
# setup_fn: setup_generated_app14 | setup_generated_app15 | setup_generated_pages | setup_generated_src | clone
# setup_arg for clone: "owner/repo:subdir" (empty subdir = root of repo)
declare -a REPOS=(
  "nextjs14-app|App Router|14|setup_generated_app14|"
  "nextjs15-app|App Router|15|setup_generated_app15|"
  "nextjs14-pages|Pages Router|14|setup_generated_pages|"
  "nextjs14-src|App Router + src/|14|setup_generated_src|"
  "vercel-blog-starter|App Router|14|clone|vercel/next.js:examples/blog-starter"
  "vercel-with-tailwind|App Router|14|clone|vercel/next.js:examples/with-tailwindcss"
  "timlrx-starter-blog|App Router|14|clone|timlrx/tailwind-nextjs-starter-blog:"
  "vercel-commerce|App Router|14|clone|vercel/commerce:"
  "shadcn-next-template|App Router|14|clone|shadcn-ui/next-template:"
  "steven-tey-dub|App Router|14|clone|steven-tey/dub:"
)

# --- Per-repo runner ---
run_repo() {
  local name="$1"
  local router_type="$2"
  local version="$3"
  local setup_fn="$4"
  local setup_arg="${5:-}"

  local dir="$TMP_BASE/$name"
  local app_dir="$dir/app"
  local is_pages_router=0
  [[ "$router_type" == "Pages Router" ]] && is_pages_router=1

  log "=== $name ($router_type, Next.js $version) ==="
  printf '\n---\n\n## %s — %s (Next.js %s)\n\n' "$name" "$router_type" "$version" >> "$RESULTS_FILE"

  # 1. Setup
  log "  Setup..."
  local setup_ok=0
  if [[ "$setup_fn" == "clone" ]]; then
    local repo="${setup_arg%%:*}"
    local subdir="${setup_arg#*:}"
    [[ "$subdir" == "$repo" ]] && subdir=""  # no colon case
    if do_clone "$repo" "$subdir" "$dir" 2>&1; then
      pass "Setup" "cloned $repo${subdir:+/$subdir}"
      setup_ok=1
    else
      fail "Setup" "clone failed"
    fi
  else
    if $setup_fn "$dir" 2>&1; then
      pass "Setup" "generated via $setup_fn"
      setup_ok=1
    else
      fail "Setup" "$setup_fn failed"
    fi
  fi

  if [[ $setup_ok -eq 0 ]]; then
    na "Integrate (--install)"; na "Install deps"; na "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    return
  fi

  # 2. Integrate
  log "  Integrate..."
  local integrate_out
  integrate_out=$($CLI integrate http://example.com \
    --platform nextjs --install --project-dir "$app_dir" 2>&1 || true)

  if [[ $is_pages_router -eq 1 ]]; then
    # Pages Router: expect a skip/warning, no files installed
    if echo "$integrate_out" | grep -qiE "app router|pages|skip|warning"; then
      pass "Integrate (--install)" "EXPECTED SKIP — App Router required warning"
    else
      fail "Integrate (--install)" "expected skip warning, got: ${integrate_out:0:120}"
    fi
    na "Install deps" "Pages Router skipped"
    na "Build" "Pages Router skipped"
    na "[production] /llms.txt" "Pages Router skipped"
    na "[production] /.well-known/agent-card.json" "Pages Router skipped"
    na "[dev] /llms.txt" "Pages Router skipped"
    na "[dev] /.well-known/agent-card.json" "Pages Router skipped"
    return
  fi

  if echo "$integrate_out" | grep -qiE "^error|unhandled|ENOENT|Cannot find"; then
    fail "Integrate (--install)" "${integrate_out:0:120}"
    na "Install deps"; na "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    return
  fi

  local files_written
  files_written=$(echo "$integrate_out" | grep -oE "(middleware|route|llms)" | sort -u | tr '\n' ' ' || echo "")
  pass "Integrate (--install)" "files written: ${files_written:-see output}"

  # 3. Install deps
  log "  npm install..."
  if (cd "$app_dir" && npm install --prefer-offline 2>&1 | tail -3); then
    pass "Install deps"
  else
    fail "Install deps"
    na "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    return
  fi

  # 4. Build
  log "  npm run build..."
  if (cd "$app_dir" && npm run build 2>&1 | tail -5); then
    pass "Build"
  else
    fail "Build"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
    return
  fi

  # 5–7. Production server
  local PORT
  PORT=$(find_port)
  log "  Starting production server on :$PORT..."
  (cd "$app_dir" && npx next start -p "$PORT" >/dev/null 2>/dev/null) &
  SERVER_PID=$!

  if wait_for_server "$PORT" 20; then
    pass "Start (production)" "port $PORT"
    check_endpoints "$PORT" "production"
  else
    fail "Start (production)" "server did not respond within 20s"
    na "[production] /llms.txt"; na "[production] /.well-known/agent-card.json"
  fi

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""

  # 8–11. Dev server (slower startup — allow 45s)
  PORT=$(find_port)
  log "  Starting dev server on :$PORT..."
  (cd "$app_dir" && npx next dev -p "$PORT" >/dev/null 2>/dev/null) &
  SERVER_PID=$!

  if wait_for_server "$PORT" 45; then
    pass "Start (dev)" "port $PORT"
    check_endpoints "$PORT" "dev"
  else
    fail "Start (dev)" "server did not respond within 45s"
    na "[dev] /llms.txt"; na "[dev] /.well-known/agent-card.json"
  fi

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""

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
# Next.js Platform Validation Results

Generated: $(date)
CLI: packages/cli/dist/index.js
HEADER

log "Starting Next.js platform validation"
log "Results: $RESULTS_FILE"
[[ -n "$SINGLE_REPO" ]] && log "Single repo mode: $SINGLE_REPO"

mkdir -p "$TMP_BASE"

for entry in "${REPOS[@]}"; do
  IFS='|' read -r name router_type version setup_fn setup_arg <<< "$entry"
  [[ -n "$SINGLE_REPO" && "$name" != "$SINGLE_REPO" ]] && continue
  run_repo "$name" "$router_type" "$version" "$setup_fn" "$setup_arg"
done

cat >> "$RESULTS_FILE" << FOOTER

---

## Summary

- **PASS**: $PASS_COUNT
- **FAIL**: $FAIL_COUNT
- **Total checks**: $((PASS_COUNT + FAIL_COUNT))
FOOTER

log "=== Done: $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
log "Results: $RESULTS_FILE"
