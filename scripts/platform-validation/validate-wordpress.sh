#!/usr/bin/env bash
# validate-wordpress.sh — Test w2agent integration across 10 WordPress theme/plugin configurations
# Run from OSS repo root: bash scripts/platform-validation/validate-wordpress.sh [options]
set -euo pipefail

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"
RESULTS_FILE="$SCRIPT_DIR/results-wordpress.md"
TMP_BASE="/tmp/w2agent-validate-wordpress"
WP_ENV_PORT=8888  # wp-env default port for development environment

# --- State ---
SINGLE_CONFIG=""
SKIP_CLEANUP=0
PASS_COUNT=0
FAIL_COUNT=0
HAS_PHP=0
HAS_DOCKER=0
declare -a ROWS=()

# --- Args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)  SINGLE_CONFIG="$2"; shift 2 ;;
    --keep)    SKIP_CLEANUP=1; shift ;;
    --results) RESULTS_FILE="$2"; shift 2 ;;
    --help)
      echo "Usage: validate-wordpress.sh [options]"
      echo "  --config <name>  Run only this config (e.g. --config wp-astra)"
      echo "  --keep           Keep temp dirs even on success"
      echo "  --results <file> Write results to this file"
      echo "  --help           Show this help"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Prereqs ---
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required (brew install jq)"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node required"; exit 1; }

[[ -f "$REPO_ROOT/packages/cli/dist/index.js" ]] || {
  echo "ERROR: CLI not built. Run: cd $REPO_ROOT && pnpm build"
  exit 1
}

# Detect optional prereqs — missing ones cause graceful N/A, not hard failure
if command -v php >/dev/null 2>&1; then
  HAS_PHP=1
  log_prereq="php available ($(php -r 'echo PHP_VERSION;' 2>/dev/null || echo "?"))"
else
  log_prereq="php not found — PHP syntax checks will be N/A"
fi

if command -v docker >/dev/null 2>&1 && timeout 5 docker info >/dev/null 2>&1; then
  HAS_DOCKER=1
fi

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

# Poll until HTTP server responds
wait_for_server() {
  local port="$1"
  local max="${2:-30}"
  local i=0
  while [[ $i -lt $max ]]; do
    if curl -s "http://localhost:$port/" >/dev/null 2>&1; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Check /llms.txt and /.well-known/agent-card.json
check_endpoints() {
  local port="$1"

  local code body
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/llms.txt" 2>/dev/null || echo "000")
  body=$(curl -s "http://localhost:$port/llms.txt" 2>/dev/null || echo "")
  if [[ "$code" == "200" && -n "$body" ]]; then
    pass "/llms.txt" "200, content: \"${body:0:60}\""
  else
    fail "/llms.txt" "HTTP $code"
  fi

  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/.well-known/agent-card.json" 2>/dev/null || echo "000")
  body=$(curl -s "http://localhost:$port/.well-known/agent-card.json" 2>/dev/null || echo "")
  if [[ "$code" == "200" ]] && echo "$body" | jq . >/dev/null 2>&1; then
    pass "/.well-known/agent-card.json" "200, valid JSON"
  else
    fail "/.well-known/agent-card.json" "HTTP $code"
  fi
}

# Run php -l on all PHP files in a directory
run_php_syntax() {
  local dir="$1"
  local errors=0
  local checked=0
  while IFS= read -r -d '' phpfile; do
    checked=$((checked + 1))
    if ! php -l "$phpfile" >/dev/null 2>&1; then
      errors=$((errors + 1))
      log "    php -l FAILED: $phpfile"
    fi
  done < <(find "$dir" -name "*.php" -print0 2>/dev/null)
  if [[ $checked -eq 0 ]]; then
    return 1  # no PHP files found
  fi
  [[ $errors -eq 0 ]]
}

# --- CONFIGS (10 entries) ---
# Format: "name|description|theme|extra_plugins"
# theme: WordPress.org theme slug (or "twentytwentyfour" for TT4)
# extra_plugins: space-separated WordPress.org plugin slugs (empty = none)
declare -a CONFIGS=(
  "wp-base|Twenty Twenty-Four, no extra plugins|twentytwentyfour|"
  "wp-astra|Astra theme, no extra plugins|astra|"
  "wp-generatepress|GeneratePress theme|generatepress|"
  "wp-kadence|Kadence theme|kadence|"
  "wp-woocommerce|TT4 + WooCommerce|twentytwentyfour|woocommerce"
  "wp-yoast|TT4 + Yoast SEO|twentytwentyfour|wordpress-seo"
  "wp-acf|TT4 + Advanced Custom Fields|twentytwentyfour|advanced-custom-fields"
  "wp-astra-woo|Astra + WooCommerce|astra|woocommerce"
  "wp-gp-yoast|GeneratePress + Yoast SEO|generatepress|wordpress-seo"
  "wp-all|TT4 + WooCommerce + Yoast + ACF|twentytwentyfour|woocommerce wordpress-seo advanced-custom-fields"
)

# --- Per-config runner ---
run_config() {
  local name="$1"
  local description="$2"
  local theme="$3"
  local extra_plugins="$4"

  local dir="$TMP_BASE/$name"
  local wp_root="$dir/wp-root"
  local plugin_dir="$wp_root/wp-content/plugins"
  local r_setup="—" r_integrate="—" r_php="—" r_wpenv="—" r_activate="—" r_llms="—" r_card="—"

  log "=== $name ($description) ==="
  printf '\n---\n\n## %s — %s\n\n' "$name" "$description" >> "$RESULTS_FILE"
  if [[ -n "$extra_plugins" ]]; then
    printf '_Theme: %s | Plugins: w2agent + %s_\n\n' "$theme" "$extra_plugins" >> "$RESULTS_FILE"
  else
    printf '_Theme: %s | Plugins: w2agent_\n\n' "$theme" >> "$RESULTS_FILE"
  fi

  # 1. Setup — create mock WP root
  log "  Setup..."
  if mkdir -p "$plugin_dir" 2>/dev/null; then
    pass "Setup" "created mock WP root at $wp_root"
    r_setup="✅"
  else
    fail "Setup" "mkdir failed"; r_setup="❌"
    na "Integrate (--install)" "setup failed"
    na "PHP syntax" "setup failed"
    na "wp-env start" "setup failed"
    na "Theme + plugin activate" "setup failed"
    na "/llms.txt" "setup failed"
    na "/.well-known/agent-card.json" "setup failed"
    ROWS+=("$name|$r_setup|$r_integrate|$r_php|$r_wpenv|$r_activate|$r_llms|$r_card")
    return
  fi

  # 2. Integrate — run CLI to write plugin files into mock WP root
  log "  Integrate..."
  local integrate_out
  integrate_out=$($CLI integrate http://example.com \
    --platform wordpress --install --project-dir "$wp_root" 2>&1 || true)

  if echo "$integrate_out" | grep -qiE "^error|unhandled|ENOENT|Cannot find"; then
    fail "Integrate (--install)" "${integrate_out:0:120}"; r_integrate="❌"
    na "PHP syntax" "integrate failed"
    na "wp-env start" "integrate failed"
    na "Theme + plugin activate" "integrate failed"
    na "/llms.txt" "integrate failed"
    na "/.well-known/agent-card.json" "integrate failed"
    ROWS+=("$name|$r_setup|$r_integrate|$r_php|$r_wpenv|$r_activate|$r_llms|$r_card")
    return
  fi

  # Check plugin files were written
  if [[ -f "$plugin_dir/w2agent/w2agent-plugin.php" ]]; then
    pass "Integrate (--install)" "w2agent plugin written to $plugin_dir/w2agent/"
    r_integrate="✅"
  else
    fail "Integrate (--install)" "w2agent-plugin.php not found after integrate"; r_integrate="❌"
    na "PHP syntax" "integrate failed"
    na "wp-env start" "integrate failed"
    na "Theme + plugin activate" "integrate failed"
    na "/llms.txt" "integrate failed"
    na "/.well-known/agent-card.json" "integrate failed"
    ROWS+=("$name|$r_setup|$r_integrate|$r_php|$r_wpenv|$r_activate|$r_llms|$r_card")
    return
  fi

  # 3. PHP syntax check — php -l on all PHP files in plugin dir
  if [[ $HAS_PHP -eq 0 ]]; then
    na "PHP syntax" "php not installed"
    r_php="—"
  else
    log "  PHP syntax check..."
    local php_count
    php_count=$(find "$plugin_dir/w2agent" -name "*.php" 2>/dev/null | wc -l | tr -d ' ')
    if run_php_syntax "$plugin_dir/w2agent"; then
      pass "PHP syntax" "php -l passed on $php_count file(s)"
      r_php="✅"
    else
      fail "PHP syntax" "php -l reported errors"
      r_php="❌"
    fi
  fi

  # 4–7. wp-env checks (requires Docker)
  if [[ $HAS_DOCKER -eq 0 ]]; then
    na "wp-env start" "docker not available"
    na "Theme + plugin activate" "docker not available"
    na "/llms.txt" "docker not available"
    na "/.well-known/agent-card.json" "docker not available"
    r_wpenv="—"; r_activate="—"; r_llms="—"; r_card="—"
    ROWS+=("$name|$r_setup|$r_integrate|$r_php|$r_wpenv|$r_activate|$r_llms|$r_card")
    if [[ $SKIP_CLEANUP -eq 0 ]]; then
      rm -rf "$dir" || true
      log "  Cleaned up $dir"
    fi
    return
  fi

  # Write .wp-env.json for this config
  local extra_plugins_json=""
  if [[ -n "$extra_plugins" ]]; then
    for slug in $extra_plugins; do
      extra_plugins_json+="\"$slug\", "
    done
  fi

  cat > "$wp_root/.wp-env.json" << JSON
{
  "core": null,
  "port": $WP_ENV_PORT,
  "themes": ["$theme"],
  "plugins": [${extra_plugins_json}"./wp-content/plugins/w2agent"]
}
JSON

  # 4. wp-env start
  log "  Starting wp-env on :$WP_ENV_PORT..."
  local wpenv_ok=0
  if (cd "$wp_root" && npx --yes @wordpress/env start 2>&1 | tail -5); then
    if wait_for_server "$WP_ENV_PORT" 120; then
      pass "wp-env start" "port $WP_ENV_PORT"
      r_wpenv="✅"
      wpenv_ok=1
    else
      fail "wp-env start" "server did not respond within 120s on port $WP_ENV_PORT"
      r_wpenv="❌"
    fi
  else
    fail "wp-env start" "npx @wordpress/env start failed"
    r_wpenv="❌"
  fi

  if [[ $wpenv_ok -eq 0 ]]; then
    na "Theme + plugin activate" "wp-env failed"
    na "/llms.txt" "wp-env failed"
    na "/.well-known/agent-card.json" "wp-env failed"
    r_activate="—"; r_llms="—"; r_card="—"
    (cd "$wp_root" && npx @wordpress/env stop 2>/dev/null || true)
    ROWS+=("$name|$r_setup|$r_integrate|$r_php|$r_wpenv|$r_activate|$r_llms|$r_card")
    if [[ $SKIP_CLEANUP -eq 0 ]]; then rm -rf "$dir" || true; fi
    return
  fi

  # 5. Activate theme and plugins via wp-cli inside wp-env
  log "  Activating theme ($theme) and w2agent plugin..."
  local activate_ok=1

  if ! (cd "$wp_root" && npx @wordpress/env run cli wp theme activate "$theme" 2>&1 | tail -3); then
    log "  Warning: theme activate may have failed (theme might need download)"
    activate_ok=0
  fi

  if [[ -n "$extra_plugins" ]]; then
    for slug in $extra_plugins; do
      if ! (cd "$wp_root" && npx @wordpress/env run cli wp plugin activate "$slug" 2>&1 | tail -3); then
        log "  Warning: plugin activate failed for $slug"
        activate_ok=0
      fi
    done
  fi

  if ! (cd "$wp_root" && npx @wordpress/env run cli wp plugin activate w2agent 2>&1 | tail -3); then
    log "  Warning: w2agent plugin activate failed"
    activate_ok=0
  fi

  if [[ $activate_ok -eq 1 ]]; then
    local activated_items="theme:$theme + w2agent${extra_plugins:+ + $extra_plugins}"
    pass "Theme + plugin activate" "$activated_items"
    r_activate="✅"
  else
    fail "Theme + plugin activate" "one or more activate commands failed"
    r_activate="❌"
  fi

  # 6–7. Endpoint checks
  local endpoint_fail_before=$FAIL_COUNT
  check_endpoints "$WP_ENV_PORT"
  if [[ $FAIL_COUNT -eq $endpoint_fail_before ]]; then
    r_llms="✅"; r_card="✅"
  else
    # Determine individual column values from what was logged
    r_llms="❌"; r_card="❌"
  fi

  # Stop wp-env
  log "  Stopping wp-env..."
  (cd "$wp_root" && npx @wordpress/env stop 2>&1 | tail -2 || true)

  ROWS+=("$name|$r_setup|$r_integrate|$r_php|$r_wpenv|$r_activate|$r_llms|$r_card")

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
# WordPress Platform Validation Results

Generated: $(date)
CLI: packages/cli/dist/index.js
Platform: wordpress (PHP plugin)
PHP available: $([ $HAS_PHP -eq 1 ] && echo yes || echo no)
Docker available: $([ $HAS_DOCKER -eq 1 ] && echo yes || echo no)
HEADER

log "Starting WordPress platform validation"
log "Results: $RESULTS_FILE"
[[ $HAS_PHP -eq 1 ]] && log "PHP: available" || log "PHP: not found — syntax checks will be N/A"
[[ $HAS_DOCKER -eq 1 ]] && log "Docker: available" || log "Docker: not found — wp-env checks will be N/A"
[[ -n "$SINGLE_CONFIG" ]] && log "Single config mode: $SINGLE_CONFIG"

mkdir -p "$TMP_BASE"

for entry in "${CONFIGS[@]}"; do
  IFS='|' read -r name description theme extra_plugins <<< "$entry"
  [[ -n "$SINGLE_CONFIG" && "$name" != "$SINGLE_CONFIG" ]] && continue
  run_config "$name" "$description" "$theme" "$extra_plugins"
done

# Write summary table
{
  printf '\n---\n\n## Summary Table\n\n'
  printf '| Config | Setup | Integrate | PHP syntax | wp-env | Activate | /llms.txt | /agent-card |\n'
  printf '|--------|-------|-----------|------------|--------|----------|-----------|-------------|\n'
  for row in "${ROWS[@]}"; do
    IFS='|' read -r rname rsetup rinteg rphp rwpenv ract rllms rcard <<< "$row"
    printf '| %-22s | %-5s | %-9s | %-10s | %-6s | %-8s | %-9s | %-11s |\n' \
      "$rname" "$rsetup" "$rinteg" "$rphp" "$rwpenv" "$ract" "$rllms" "$rcard"
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
