#!/bin/bash
# inventory-repos.sh — lista todos los repos git del ecosistema Teros
# Uso: ./scripts/inventory-repos.sh [--csv]

CSV=false
[ "$1" = "--csv" ] && CSV=true

if [ "$CSV" = true ]; then
  echo "path|head|branch|remote|dirty|last_commit"
fi

for base in /opt /data/volumes/workspaces; do
  find "$base" -maxdepth 3 -type d -name '.git' 2>/dev/null | sed 's|/.git$||'
done | sort -u | while read repo; do
  cd "$repo" 2>/dev/null || continue
  head=$(git rev-parse --short HEAD 2>/dev/null || echo 'N/A')
  branch=$(git branch --show-current 2>/dev/null || echo 'detached')
  remote=$(git remote get-url origin 2>/dev/null || echo 'NO REMOTE')
  dirty=$(git status --porcelain 2>/dev/null | wc -l)
  last=$(git log -1 --format='%h %s (%ci)' 2>/dev/null || echo 'no commits')
  
  if [ "$CSV" = true ]; then
    echo "$repo|$head|$branch|$remote|$dirty|$last"
  else
    echo "=== $repo ==="
    echo "  HEAD:   $head"
    echo "  Branch: $branch"
    echo "  Remote: $remote"
    echo "  Dirty:  $dirty files"
    echo "  Last:   $last"
    echo ""
  fi
done
