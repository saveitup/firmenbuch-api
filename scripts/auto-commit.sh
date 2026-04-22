#!/usr/bin/env bash
# Stop-hook: committet nach jeder abgeschlossenen Claude-Antwort alle
# Änderungen am Working Tree. Idempotent — wenn nichts geändert wurde,
# passiert nichts. Erzeugt eine kurze generische Commit-Message aus
# dem `git diff --stat`-Output, damit die Historie lesbar bleibt.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -z "$repo_root" ] && exit 0
cd "$repo_root"

# Nichts zu tun?
[ -z "$(git status --porcelain)" ] && exit 0

# Grösste geänderte Pfade in die Message aufnehmen — gibt ohne Claude-
# spezifische Synthese immer noch eine sinnvolle Zeile pro Commit.
git add -A

stats=$(git diff --cached --shortstat)
top=$(git diff --cached --name-only | head -3 | paste -sd',' -)
n_files=$(git diff --cached --name-only | wc -l | tr -d ' ')
if [ "$n_files" -gt 3 ]; then
  top="${top}, +$((n_files - 3)) more"
fi

msg="auto: ${top}"
[ -n "$stats" ] && msg="${msg}${stats:+ (${stats# })}"

# Hooks nicht umgehen — wir erzeugen vollwertige Commits.
git commit -m "$msg" --quiet
