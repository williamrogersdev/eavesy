#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'TEXT'
Usage: dictation-scorecard.sh [--days N] [--since TIME] [--dir PATH] [LOG...]

Prints how dictation went, from the Mac app's own logs: where the words
ended up, how long they took after Stop, and how soon the first live words
showed. Reads counts and timings only, never what was said.

  --days N    the newest N daily logs (default 7)
  --since T   only lines at or after T, a UTC time as the logs write it
              (2026-11-09T21:48), to measure one build on its own
  --dir PATH  the log folder (default ~/Library/Logs/com.eavesy.desktop)
  LOG...      specific log files, instead of --days
TEXT
}

days=7
since=""
dir="$HOME/Library/Logs/com.eavesy.desktop"
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --days) days="$2"; shift 2 ;;
    --since) since="$2"; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) files+=("$1"); shift ;;
  esac
done

if [ ${#files[@]} -eq 0 ]; then
  while IFS= read -r file; do files+=("$file"); done < <(ls -1 "$dir"/eavesy.*.log 2>/dev/null | sort | tail -n "$days")
fi
if [ ${#files[@]} -eq 0 ]; then
  echo "No logs found in $dir" >&2
  exit 1
fi

first="$(basename "${files[0]}")"
last="$(basename "${files[${#files[@]}-1]}")"
echo "Dictation scorecard: $first to $last (${#files[@]} files)${since:+, since $since}"

cat "${files[@]}" | LC_ALL=C sort -s -k1,1 | LC_ALL=C awk -v since="$since" '
function field(name,    rest, at, end) {
  at = index($0, " " name "=")
  if (!at) return ""
  rest = substr($0, at + length(name) + 2)
  if (substr(rest, 1, 1) == "\"") { rest = substr(rest, 2); end = index(rest, "\""); return substr(rest, 1, end - 1) }
  end = index(rest, " ")
  return end ? substr(rest, 1, end - 1) : rest
}
function after(marker,    at, rest, end) {
  at = index($0, marker)
  rest = substr($0, at + length(marker))
  end = index(rest, " session_id=")
  if (end) rest = substr(rest, 1, end - 1)
  end = index(rest, " (")
  if (end) rest = substr(rest, 1, end - 1)
  return rest
}
function sorted(values, count,    i, j, held) {
  for (i = 2; i <= count; i++) {
    held = values[i]
    for (j = i - 1; j >= 1 && values[j] > held; j--) values[j + 1] = values[j]
    values[j + 1] = held
  }
}
function at_share(values, count, share,    index_at) {
  if (!count) return "-"
  index_at = int(count * share + 0.999999)
  if (index_at < 1) index_at = 1
  if (index_at > count) index_at = count
  return values[index_at]
}
function over(values, count, limit,    i, total) {
  total = 0
  for (i = 1; i <= count; i++) if (values[i] > limit) total++
  return total
}
function share(part, whole) { return whole ? sprintf("%d%%", part * 100 / whole + 0.5) : "-" }
function timings(title, values, count, limits,    parts, n, i) {
  sorted(values, count)
  printf "\n%s (%d)\n", title, count
  if (!count) return
  printf "  median %s ms, 90th percentile %s ms, slowest %s ms\n", at_share(values, count, 0.5), at_share(values, count, 0.9), values[count]
  n = split(limits, parts, ",")
  for (i = 1; i <= n; i++) printf "  over %s s: %d (%s)\n", parts[i] / 1000, over(values, count, parts[i]), share(over(values, count, parts[i]), count)
}
$1 !~ /^20[0-9][0-9]-/ || (since != "" && $1 < since) { next }
/eavesy started/ { running = field("version") " " field("build") }
/ WARN / { warnings++ }
/ ERROR / { errors++ }
/dictation delivered/ {
  total++
  outcome = field("delivery"); outcomes[outcome]++
  role = field("focused_role")
  if ((outcome == "no_text_box" || outcome == "draft_kept") && role ~ /^AXText/) copied_in_text_field++
  build = running == "" ? "(not logged)" : running
  if (!(build in build_total)) builds[++build_count] = build
  build_total[build]++
  if (outcome == "pasted" || outcome == "pasted_unverified" || outcome == "in_eavesy") { placed++; build_placed[build]++ }
  why = field("reason"); if (why != "") reasons[why]++
  delivered[++delivered_count] = field("delivery_ms") + 0
}
/dictation polished/ { polished[++polished_count] = field("polish_ms") + 0 }
/first live caption after/ { caption[++caption_count] = field("latency_ms") + 0 }
/live-typed words not replaced: / { not_replaced[after("not replaced: ")]++; not_replaced_total++ }
/live typing stopped: / { stopped[after("live typing stopped: ")]++ }
/live typing off for this dictation: / { off[after("for this dictation: ")]++ }
END {
  printf "\nWhere the words ended up (%d dictations)\n", total
  for (outcome in outcomes) printf "  %-20s %5d  %s\n", outcome, outcomes[outcome], share(outcomes[outcome], total)
  printf "  placed in the app: %s    copied while a text field had focus: %d\n", share(placed, total), copied_in_text_field
  if (build_count > 1 || running != "") {
    printf "\nPlaced in the app, by app version\n"
    for (i = 1; i <= build_count; i++) printf "  %-20s %5d of %-5d %s\n", builds[i], build_placed[builds[i]], build_total[builds[i]], share(build_placed[builds[i]], build_total[builds[i]])
  }
  timings("Stop to delivered", delivered, delivered_count, "2000,4000")
  timings("Polish request", polished, polished_count, "2000,4000")
  timings("First live caption", caption, caption_count, "1500,2000")
  printf "\nTyped words not replaced (%d)\n", not_replaced_total
  for (why in not_replaced) printf "  %5d  %s\n", not_replaced[why], why
  for (why in reasons) printf "  %5d  reason=%s\n", reasons[why], why
  printf "\nLive typing stopped early\n"
  for (why in stopped) printf "  %5d  %s\n", stopped[why], why
  printf "\nLive typing off for the dictation\n"
  for (why in off) printf "  %5d  %s\n", off[why], why
  printf "\nLog noise: %d warnings, %d errors\n", warnings, errors
}
'
