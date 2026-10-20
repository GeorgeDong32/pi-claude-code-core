#!/bin/zsh
# sync-deploy-copies.sh — reset the installed deployment copies of this repo
# to a chosen commit (default: origin/main), on both the desktop copy and the
# MacBook Air. SSH-first (https to github is flaky from either machine);
# record the outcome in DEVIATIONS.md when run for a batch.
#
# Usage: zsh scripts/sync-deploy-copies.sh [commit-ish]   # default origin/main
set -euo pipefail

REV="${1:-origin/main}"
DESKTOP="$HOME/.pi/agent/git/github.com/GeorgeDong32/pi-claude-code-core"
AIR="gd32@100.88.88.3"
AIR_PATH="$HOME/.pi/agent/git/github.com/GeorgeDong32/pi-claude-code-core"

echo "== desktop =="
cd "$DESKTOP"
git fetch git@github.com:GeorgeDong32/pi-claude-code-core.git main -q
git reset --hard "$REV" -q
echo "desktop deploy: $(git rev-parse --short HEAD)"

echo "== air =="
ssh -o BatchMode=yes "$AIR" "cd '$AIR_PATH' && \
	git fetch git@github.com:GeorgeDong32/pi-claude-code-core.git main -q && \
	git reset --hard '$REV' -q && \
	echo 'air deploy: '\$(git rev-parse --short HEAD)"
