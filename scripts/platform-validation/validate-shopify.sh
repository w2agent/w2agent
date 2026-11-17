#!/usr/bin/env bash
# validate-shopify.sh — Test w2agent integration across 5 Shopify theme configurations
# Run from OSS repo root: bash scripts/platform-validation/validate-shopify.sh [options]
set -euo pipefail

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"
RESULTS_FILE="$SCRIPT_DIR/results-shopify.md"
TMP_BASE="/tmp/w2agent-validate-shopify"

# --- State ---
SINGLE_CONFIG=""
SKIP_CLEANUP=0
PASS_COUNT=0
FAIL_COUNT=0
HAS_SHOPIFY_CLI=0
declare -a ROWS=()

# --- Args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)  SINGLE_CONFIG="$2"; shift 2 ;;
    --keep)    SKIP_CLEANUP=1; shift ;;
    --results) RESULTS_FILE="$2"; shift 2 ;;
    --help)
      echo "Usage: validate-shopify.sh [options]"
      echo "  --config <name>  Run only this config (e.g. --config shopify-mock-fresh)"
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
command -v git  >/dev/null 2>&1 || { echo "ERROR: git required"; exit 1; }

[[ -f "$REPO_ROOT/packages/cli/dist/index.js" ]] || {
  echo "ERROR: CLI not built. Run: cd $REPO_ROOT && pnpm build"
  exit 1
}

# Detect optional Shopify CLI — missing causes graceful N/A, not hard failure
if command -v shopify >/dev/null 2>&1; then
  HAS_SHOPIFY_CLI=1
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

# --- CONFIGS (5 entries) ---
# Format: "name|description|setup_type|clone_url_or_empty"
declare -a CONFIGS=(
  "shopify-dawn|Dawn OS 2.0 theme (official clone)|clone|https://github.com/Shopify/dawn.git"
  "shopify-skeleton|Skeleton theme (minimal scaffold)|clone|https://github.com/Shopify/skeleton-theme.git"
  "shopify-mock-fresh|Mock theme — fresh install|mock-fresh|"
  "shopify-mock-existing-robots|Mock theme — pre-existing robots.txt.liquid|mock-existing-robots|"
  "shopify-non-theme-dir|Empty dir — non-theme warning|non-theme-dir|"
)

# --- Per-config runner ---
run_config() {
  local name="$1"
  local description="$2"
  local setup_type="$3"
  local clone_url="$4"

  local dir="$TMP_BASE/$name"
  local r_setup="—" r_integrate="—" r_head="—" r_robots="—" r_llms="—" r_jsonld="—" r_liquid="—"

  log "=== $name ($description) ==="
  printf '\n---\n\n## %s — %s\n\n' "$name" "$description" >> "$RESULTS_FILE"
  printf '_Setup type: %s_\n\n' "$setup_type" >> "$RESULTS_FILE"

  # 1. Setup
  log "  Setup ($setup_type)..."
  case "$setup_type" in
    clone)
      if git clone --depth=1 "$clone_url" "$dir" 2>&1 | tail -3; then
        if [[ -f "$dir/layout/theme.liquid" || -f "$dir/config/settings_schema.json" ]]; then
          pass "Setup" "cloned $clone_url; layout/theme.liquid present"
          r_setup="✅"
        else
          fail "Setup" "cloned but layout/theme.liquid and config/settings_schema.json both missing"
          r_setup="❌"
          na "Integrate (--install)" "setup failed"
          na "Head snippet" "setup failed"
          na "robots.txt.liquid" "setup failed"
          na "theme-only files" "setup failed"
          na "JSON-LD content" "setup failed"
          na "Liquid syntax" "setup failed"
          ROWS+=("$name|$r_setup|$r_integrate|$r_head|$r_robots|$r_llms|$r_jsonld|$r_liquid")
          return
        fi
      else
        fail "Setup" "git clone failed for $clone_url"
        r_setup="❌"
        na "Integrate (--install)" "setup failed"
        na "Head snippet" "setup failed"
        na "robots.txt.liquid" "setup failed"
        na "theme-only files" "setup failed"
        na "JSON-LD content" "setup failed"
        na "Liquid syntax" "setup failed"
        ROWS+=("$name|$r_setup|$r_integrate|$r_head|$r_robots|$r_llms|$r_jsonld|$r_liquid")
        return
      fi
      ;;
    mock-fresh)
      mkdir -p "$dir/layout" "$dir/config"
      echo '<html>{{ content_for_layout }}</html>' > "$dir/layout/theme.liquid"
      echo '[]' > "$dir/config/settings_schema.json"
      pass "Setup" "created mock theme with layout/theme.liquid + config/settings_schema.json"
      r_setup="✅"
      ;;
    mock-existing-robots)
      mkdir -p "$dir/layout" "$dir/config" "$dir/templates"
      echo '<html>{{ content_for_layout }}</html>' > "$dir/layout/theme.liquid"
      echo '[]' > "$dir/config/settings_schema.json"
      echo '# pre-existing robots.txt.liquid' > "$dir/templates/robots.txt.liquid"
      pass "Setup" "created mock theme with pre-existing templates/robots.txt.liquid"
      r_setup="✅"
      ;;
    non-theme-dir)
      mkdir -p "$dir"
      pass "Setup" "created empty directory (no layout/theme.liquid)"
      r_setup="✅"
      ;;
    *)
      fail "Setup" "unknown setup_type: $setup_type"
      r_setup="❌"
      na "Integrate (--install)" "setup failed"
      na "Head snippet" "setup failed"
      na "robots.txt.liquid" "setup failed"
      na "theme-only files" "setup failed"
      na "JSON-LD content" "setup failed"
      na "Liquid syntax" "setup failed"
      ROWS+=("$name|$r_setup|$r_integrate|$r_head|$r_robots|$r_llms|$r_jsonld|$r_liquid")
      return
      ;;
  esac

  # 2. Integrate
  log "  Integrate (--install)..."
  local integrate_out
  integrate_out=$($CLI integrate http://example.com \
    --platform shopify --install --project-dir "$dir" 2>&1 || true)

  if echo "$integrate_out" | grep -qiE "^error|unhandled|ENOENT|Cannot find"; then
    fail "Integrate (--install)" "${integrate_out:0:120}"
    r_integrate="❌"
    na "Head snippet" "integrate failed"
    na "robots.txt.liquid" "integrate failed"
    na "theme-only files" "integrate failed"
    na "JSON-LD content" "integrate failed"
    na "Liquid syntax" "integrate failed"
    ROWS+=("$name|$r_setup|$r_integrate|$r_head|$r_robots|$r_llms|$r_jsonld|$r_liquid")
    [[ $SKIP_CLEANUP -eq 0 ]] && rm -rf "$dir" || true
    return
  fi

  local installed_count
  installed_count=$(echo "$integrate_out" | grep -c '✓' || echo "0")

  if [[ "$setup_type" == "non-theme-dir" ]]; then
    if echo "$integrate_out" | grep -q "Not a Shopify theme directory"; then
      pass "Integrate (--install)" "non-theme-dir warning present; $installed_count file(s) installed"
      r_integrate="✅"
    else
      fail "Integrate (--install)" "expected non-theme-dir warning in output"
      r_integrate="❌"
    fi
  else
    pass "Integrate (--install)" "$installed_count file(s) installed"
    r_integrate="✅"
  fi

  # 3. Head snippet
  log "  Head snippet..."
  if [[ -f "$dir/snippets/w2agent-head.liquid" ]]; then
    pass "Head snippet" "snippets/w2agent-head.liquid written"
    r_head="✅"
  else
    fail "Head snippet" "snippets/w2agent-head.liquid not found"
    r_head="❌"
  fi

  # 4. robots.txt.liquid
  log "  robots.txt.liquid..."
  if [[ "$setup_type" == "mock-existing-robots" ]]; then
    local orig_content
    orig_content=$(cat "$dir/templates/robots.txt.liquid" 2>/dev/null || echo "")
    if [[ "$orig_content" == "# pre-existing robots.txt.liquid" ]]; then
      pass "robots.txt.liquid" "pre-existing file preserved"
      r_robots="✅"
    else
      fail "robots.txt.liquid" "pre-existing file was changed"
      r_robots="❌"
    fi
  else
    if [[ -f "$dir/templates/robots.txt.liquid" ]]; then
      fail "robots.txt.liquid" "templates/robots.txt.liquid must never be written"
      r_robots="❌"
    else
      pass "robots.txt.liquid" "not written (any groups are a manual step, not an install write)"
      r_robots="✅"
    fi
  fi

  # 5. Only theme files are written (no data/, no markdown, no llms.txt template)
  log "  theme-only files..."
  if [[ -e "$dir/data" || -e "$dir/W2AGENT-MCP-WEBHOOK.md" || -e "$dir/templates/llms.txt.liquid" ]]; then
    fail "theme-only files" "data/, W2AGENT-MCP-WEBHOOK.md or templates/llms.txt.liquid was written into the theme"
    r_llms="❌"
  else
    pass "theme-only files" "only snippets were written into the theme"
    r_llms="✅"
  fi

  # 6. JSON-LD content (only if head snippet exists)
  log "  JSON-LD content..."
  if [[ -f "$dir/snippets/w2agent-head.liquid" ]]; then
    local head="$dir/snippets/w2agent-head.liquid"
    local jsonld_ok=1 jsonld_why=""
    if ! grep -q 'href="/llms.txt"' "$head"; then
      jsonld_ok=0; jsonld_why="missing the /llms.txt link"
    fi
    if grep -qE 'money_without_currency|shop\.currency|template contains' "$head"; then
      jsonld_ok=0; jsonld_why="${jsonld_why:+$jsonld_why; }hand-built JSON-LD still present"
    fi
    if grep -q 'structured_data' "$head" && ! grep -q "request.page_type == 'product'" "$head"; then
      jsonld_ok=0; jsonld_why="${jsonld_why:+$jsonld_why; }structured_data is not gated by request.page_type == 'product'"
    fi
    if [[ $jsonld_ok -eq 1 ]]; then
      pass "JSON-LD content" "/llms.txt link, no hand-built JSON-LD; any structured_data block is gated to product pages"
      r_jsonld="✅"
    else
      fail "JSON-LD content" "$jsonld_why"
      r_jsonld="❌"
    fi
  else
    na "JSON-LD content" "head snippet not written"
    r_jsonld="—"
  fi

  # 7. Liquid syntax (only if head snippet exists)
  log "  Liquid syntax..."
  if [[ -f "$dir/snippets/w2agent-head.liquid" ]]; then
    if [[ $HAS_SHOPIFY_CLI -eq 1 ]]; then
      log "  Running shopify theme check..."
      # Check only the w2agent snippets so the theme's own offenses do not fail this run.
      local check_dir="$dir/.w2agent-check"
      mkdir -p "$check_dir/snippets"
      cp "$dir"/snippets/w2agent-*.liquid "$check_dir/snippets/"
      if shopify theme check --path "$check_dir" >/dev/null 2>&1; then
        pass "Liquid syntax" "shopify theme check passed"
        r_liquid="✅"
      else
        fail "Liquid syntax" "shopify theme check reported errors"
        r_liquid="❌"
      fi
    else
      local liquid_ok=1 if_count endif_count comment_count endcomment_count
      if_count=$(grep -cE '\{%-? *if ' "$dir/snippets/w2agent-head.liquid" || true)
      endif_count=$(grep -cE '\{%-? *endif *-?%\}' "$dir/snippets/w2agent-head.liquid" || true)
      comment_count=$(grep -cE '\{%-? *comment *-?%\}' "$dir/snippets/w2agent-head.liquid" || true)
      endcomment_count=$(grep -cE '\{%-? *endcomment *-?%\}' "$dir/snippets/w2agent-head.liquid" || true)
      [[ "$if_count" -eq "$endif_count" ]] || liquid_ok=0
      [[ "$comment_count" -eq "$endcomment_count" ]] || liquid_ok=0
      grep -q '<link ' "$dir/snippets/w2agent-head.liquid" || liquid_ok=0
      if [[ $liquid_ok -eq 1 ]]; then
        pass "Liquid syntax" "structural: if/endif and comment/endcomment balanced, link tag present (shopify CLI N/A)"
        r_liquid="✅"
      else
        fail "Liquid syntax" "structural check: unbalanced if/endif or comment/endcomment, or no link tag"
        r_liquid="❌"
      fi
    fi
  else
    na "Liquid syntax" "head snippet not written"
    r_liquid="—"
  fi

  ROWS+=("$name|$r_setup|$r_integrate|$r_head|$r_robots|$r_llms|$r_jsonld|$r_liquid")

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
# Shopify Platform Validation Results

Generated: $(date)
CLI: packages/cli/dist/index.js
Platform: shopify (Liquid snippets)
Shopify CLI available: $([ $HAS_SHOPIFY_CLI -eq 1 ] && echo yes || echo no)
Note: Shopify is SaaS — all checks are static (file-based, no local server).
HEADER

log "Starting Shopify platform validation"
log "Results: $RESULTS_FILE"
[[ $HAS_SHOPIFY_CLI -eq 1 ]] && log "Shopify CLI: available" || log "Shopify CLI: not found — Liquid syntax checks will use structural grep"
[[ -n "$SINGLE_CONFIG" ]] && log "Single config mode: $SINGLE_CONFIG"

mkdir -p "$TMP_BASE"

for entry in "${CONFIGS[@]}"; do
  IFS='|' read -r name description setup_type clone_url <<< "$entry"
  [[ -n "$SINGLE_CONFIG" && "$name" != "$SINGLE_CONFIG" ]] && continue
  run_config "$name" "$description" "$setup_type" "$clone_url"
done

# Write summary table
{
  printf '\n---\n\n## Summary Table\n\n'
  printf '| Config | Setup | Integrate | Head Snippet | robots.txt.liquid | Theme-only   | JSON-LD | Liquid |\n'
  printf '|--------|-------|-----------|--------------|-------------------|---------------|---------|--------|\n'
  for row in "${ROWS[@]}"; do
    IFS='|' read -r rname rsetup rinteg rhead rrobots rllms rjsonld rliquid <<< "$row"
    printf '| %-38s | %-5s | %-9s | %-12s | %-17s | %-13s | %-7s | %-6s |\n' \
      "$rname" "$rsetup" "$rinteg" "$rhead" "$rrobots" "$rllms" "$rjsonld" "$rliquid"
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
