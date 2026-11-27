#!/usr/bin/env bash
# Runs one live evaluation to completion across quota windows.
#
#   bash scripts/eval-batches.sh <report-name> <pause-seconds> <max-batches> -- <eval-rag arguments…>
#
# Each batch resumes from the run's own recording (no completed call is ever
# repeated). Exit code 3 from the runner means "incomplete — quota or budget":
# wait, then go again. Any other exit code ends the loop. The report of the last
# batch is left in eval/reports/<report-name>.txt and its progress in .progress.
set -u
name="$1"; pause="$2"; max="$3"; shift 4
mkdir -p eval/reports
for i in $(seq 1 "$max"); do
  npx tsx scripts/eval-rag.ts "$@" > "eval/reports/$name.txt" 2> "eval/reports/$name.progress"
  rc=$?
  echo "[batch $i] exit $rc $(date +%H:%M:%S)" >> "eval/reports/$name.batches"
  [ "$rc" -ne 3 ] && break
  node -e "setTimeout(()=>{}, $pause * 1000)"
done
head -16 "eval/reports/$name.txt"
