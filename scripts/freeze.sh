#!/usr/bin/env bash
# Freezes a release candidate before its held-out run: every file that decides an answer (code, the model
# prompt inside understand.ts, the routing defaults in runtime.ts), the runner, the case-format spec and the
# sealed set are hashed. Re-check with: grep -E '^[0-9a-f]{64} \*' <file> | sha256sum -c -
#   bash scripts/freeze.sh <name> <set> "<description>" "<chain>" "<chain-hinglish>" > eval/reports/<name>-frozen-at.txt
set -eu
name=$1; set=$2; desc=$3; chain=$4; chainhi=$5
echo "# ${name}: frozen $(date -u +%Y-%m-%dT%H:%M:%SZ) ($(date -d "+5 hours 30 minutes" -u +%H:%M) IST)"
echo "# ${desc}"
echo "# set: ${set} ($(node -e "const l=require('fs').readFileSync('eval/golden/${set}/cases.jsonl','utf8').split(/\r?\n/).filter(x=>x.trim());console.log(l.length+' conversations, '+l.reduce((a,x)=>a+JSON.parse(x).turns.length,0)+' turns')")); never opened"
echo "# chain: ${chain}"
echo "# chain-hinglish: ${chainhi}"
echo "# run: bash scripts/eval-batches.sh ${name}-rN 300 400 -- --live --live-catalog --set ${set} --run rN --chain ${chain} --chain-hinglish ${chainhi} --pace 15000"
echo "# gates (unchanged): multi-turn >= 98 %, Hindi / Hinglish >= 95 %, mandatory-filter violations 0, no-match >= 98 %, end-to-end search p95 <= 3.5 s"
sha256sum src/lib/rag/*.ts scripts/eval-rag.ts scripts/eval-batches.sh eval/golden/README.md "eval/golden/${set}/cases.jsonl" | sed 's#  # *#'
