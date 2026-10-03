#!/bin/bash
# cleanup-mac.sh — cache cleanup that reports its progress to Coucou (the notch pill "cleanup-mac").
#
# Safe by default: without --apply it only measures sizes (dry run).
# With --apply it asks y/N in the terminal before deleting each category.
# Coucou has no approval card for custom agents, so the confirmation is here, in the terminal.
#
# Usage:  ./cleanup-mac.sh            # dry run
#         ./cleanup-mac.sh --apply    # ask, then delete

set -u

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Relay installed by Coucou (GitHub build). App Store build: ~/.claude/coucou/nb-hook
NB_HOOK="${NB_HOOK:-$HOME/Library/Application Support/NotchBuddy/nb-hook}"
AGENT="cleanup-mac"
SESSION="cleanup-$(date +%s)"

# Send one event to the notch. Never fails or blocks: if Coucou is not running, nothing happens.
notify() { # notify <EventName> <json fields without braces>
  [ -f "$NB_HOOK" ] || return 0
  printf '{"hook_event_name":"%s","session_id":"%s","cwd":"%s"%s}' \
    "$1" "$SESSION" "$HOME" "${2:+,$2}" \
    | /bin/sh "$NB_HOOK" --agent "$AGENT" "$1" >/dev/null 2>&1 || true
}

step() { # step <label>  -> shows "Clean <label>" in the ticker
  notify PreToolUse "\"tool_name\":\"Clean\",\"tool_input\":{\"command\":\"$1\"}"
}
done_step() { notify PostToolUse "\"tool_name\":\"Clean\""; }

# category name | path (only folders that are safe to regenerate)
CATEGORIES=(
  "User caches|$HOME/Library/Caches"
  "Xcode DerivedData|$HOME/Library/Developer/Xcode/DerivedData"
  "Homebrew cache|$HOME/Library/Caches/Homebrew"
  "npm cache|$HOME/.npm/_cacache"
  "App logs|$HOME/Library/Logs"
)

size_kb() { du -sk "$1" 2>/dev/null | awk '{print $1}'; }
human() { awk -v k="$1" 'BEGIN{ if(k>=1048576) printf "%.1f GB",k/1048576; else printf "%.0f MB",k/1024 }'; }

notify SessionStart
notify UserPromptSubmit "\"prompt\":\"Mac cleanup ($([ $APPLY = 1 ] && echo apply || echo dry run))\""

TOTAL_KB=0
for entry in "${CATEGORIES[@]}"; do
  name="${entry%%|*}"; path="${entry#*|}"
  [ -d "$path" ] || continue

  step "Scan $name"
  kb=$(size_kb "$path"); kb=${kb:-0}
  done_step
  echo "• $name: $(human "$kb")  ($path)"

  [ "$APPLY" = 1 ] || continue
  [ "$kb" -gt 0 ] || continue

  read -r -p "  Delete the contents of '$name'? [y/N] " ans
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    step "Delete $name"
    # Contents only, never the folder itself; -x stays on the same volume.
    find "$path" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
    done_step
    TOTAL_KB=$((TOTAL_KB + kb))
  else
    echo "  skipped"
  fi
done

if [ "$APPLY" = 1 ]; then
  echo "Freed about $(human "$TOTAL_KB")."
  notify Stop "\"last_assistant_message\":\"Freed about $(human "$TOTAL_KB")\""
else
  echo "Dry run only. Re-run with --apply to delete."
  notify Stop "\"last_assistant_message\":\"Scan complete (dry run)\""
fi
notify SessionEnd
