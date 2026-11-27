#!/usr/bin/env bash
# Free regression replay: every recorded model answer we have, re-scored on the current code.
# No model calls (turns whose input changed with the code show as "no recording").
#   bash scripts/regress.sh > eval/reports/regress-<label>.txt
set -u
O=groq:openai/gpt-oss-120b; Q=groq:qwen/qwen3.8-27b; G=xai:grok-4.20-0309-non-reasoning
# the original dev slices (b3 = every 3rd conversation, hg1 = every Hindi / Hinglish one), without the c3- cases added later
ids() { node -e "const fs=require('fs');const d='eval/golden/dev/';const all=fs.readdirSync(d).filter(f=>f.endsWith('.jsonl')).sort().flatMap(f=>fs.readFileSync(d+f,'utf8').split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l)));const o=all.filter(c=>!c.id.startsWith('c3-'));console.log(($1).map(c=>c.id).join(','))"; }
B3=$(ids "o.filter((c,i)=>i%3===0)")
HG=$(ids "o.filter(c=>c.lang!=='en')")
C3=$(ids "all.filter(c=>c.id.startsWith('c3-'))")
GM=gemini:gemini-3.5-flash-lite; NV=nvidia:minimaxai/minimax-m3.1-flash
line() { # label, then eval-rag args
  local label=$1; shift
  local out; out=$(npx tsx scripts/eval-rag.ts --fill-catalog "$@" 2>/dev/null)
  local turns comp multi lang
  turns=$(echo "$out" | grep -m1 '^turns ' | sed -E 's/turns ([0-9]+): scored ([0-9]+).*no recording ([0-9]+)/\2 scored, \3 unrec/')
  comp=$(echo "$out" | grep -m1 '^TASK' | sed -E 's/^TASK[^:]*: ([0-9]+\/[0-9]+ \([0-9.]+%\)).*: ([0-9]+\/[0-9]+).*/\1 conv \2/')
  multi=$(echo "$out" | grep -m1 '^multi-turn' | sed -E 's/.*: //')
  lang=$(echo "$out" | grep -m1 '^by language' | sed -E 's/by language: //')
  viol=$(echo "$out" | grep -m1 '^mandatory' | sed -E 's/.*shown cards: ([0-9]+).*/\1/')
  printf '%-22s turns %-8s %-26s | multi %-16s | %s | viol %s\n' "$label" "$comp" "($turns)" "$multi" "$lang" "$viol"
}
line "dev b3 routed"     --set dev --only "$B3" --run b3 --compose --chain $O,$Q --chain-hinglish $Q,$O
line "dev hg1 routed"    --set dev --only "$HG" --run hg1 --compose --chain $O,$Q --chain-hinglish $Q,$O
for m in $O $Q $G gemini:gemini-3.5-flash-lite nvidia:minimaxai/minimax-m3.1-flash; do
  short=${m##*/}; short=${short#*:}
  line "dev b3 $short"  --set dev --only "$B3" --run b3 --model $m
  line "dev hg1 $short" --set dev --only "$HG" --run hg1 --model $m
done
line "reg-h4 r1 (Groq)"  --set reg-h4 --run r1 --chain $O,$Q --chain-hinglish $Q,$O
for r in r1 r2 r3; do line "reg-h3 $r (Grok)" --set reg-h3 --run $r --chain $O,$Q,$G --chain-hinglish $Q,$O,$G; done
line "dev c3 live (fallbacks)" --set dev --only "$C3" --run c3a --chain $O,$Q,$GM,$NV --chain-hinglish $Q,$O,$GM,$NV
