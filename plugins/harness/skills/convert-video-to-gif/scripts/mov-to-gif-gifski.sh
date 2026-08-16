#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_MAX_BYTES=256000
readonly DEFAULT_SIZE=128
readonly DEFAULT_MIN_FPS=15
readonly DEFAULT_MAX_FPS=24
readonly DEFAULT_MIN_QUALITY=20
readonly DEFAULT_MAX_QUALITY=100
readonly MAX_SIGNED_INTEGER=9223372036854775807

# Exit status contract, shared with the other scripts in this plugin:
#   0  success, or --preflight found a usable environment
#   2  could not start: bad usage, missing dependency, unusable input
#   1  the conversion ran and failed
json_output=0
preflight_only=0

usage() {
  printf 'Usage: %s [OPTIONS] INPUT_VIDEO [OUTPUT.gif]\n' "${0##*/}"
  printf '\n'
  printf 'Options:\n'
  printf '  --preflight   Check the environment, convert nothing, then exit\n'
  printf '  --json        Report readiness and errors as JSON\n'
  printf '  -h, --help    Print this message\n'
  printf '\n'
  printf 'Environment: MAX_BYTES, GIF_SIZE, MIN_FPS, MAX_FPS, JOBS, '\
'MIN_QUALITY, MAX_QUALITY, KEEP_WORK=1\n'
  printf '\n'
  printf 'Exit status: 0 success, 2 cannot start, 1 conversion failed.\n'
}

json_escape() {
  local text=$1

  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\n'/\\n}
  text=${text//$'\r'/\\r}
  text=${text//$'\t'/\\t}
  printf '%s' "$text"
}

report_error() {
  local code=$1
  local condition=$2
  local remedy=$3

  if (( json_output == 1 )); then
    printf '{"error":{"code":"%s","condition":"%s","remedy":"%s"}}\n' \
      "$(json_escape "$code")" "$(json_escape "$condition")" \
      "$(json_escape "$remedy")" >&2
  else
    printf 'ERROR [%s]: %s\n' "$code" "$condition" >&2
    [[ -z "$remedy" ]] || printf 'Remedy: %s\n' "$remedy" >&2
  fi
}

fail() {
  report_error "$1" "$2" "${3:-}"
  exit 2
}

die() {
  report_error "$1" "$2" "${3:-}"
  exit 1
}

is_positive_integer() {
  local value=$1
  local length

  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  length=${#value}
  (( length < 19 )) && return 0
  (( length > 19 )) && return 1
  [[ "$value" < "$MAX_SIGNED_INTEGER" || "$value" == "$MAX_SIGNED_INTEGER" ]]
}

validate_positive_integer() {
  is_positive_integer "$2" || fail config_invalid \
    "$1 must be a positive integer no greater than $MAX_SIGNED_INTEGER, got '$2'" \
    "unset $1 to take the default, or set it to a positive integer"
}

validate_quality() {
  validate_positive_integer "$1" "$2"
  (( $2 <= 100 )) || fail config_invalid \
    "$1 must be between 1 and 100, got '$2'" \
    "set $1 to an integer from 1 through 100"
}

detect_logical_cpus() {
  local detected=''

  if command -v getconf >/dev/null 2>&1; then
    detected=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
  fi
  if ! is_positive_integer "$detected" && [[ -x /usr/sbin/sysctl ]]; then
    detected=$(/usr/sbin/sysctl -n hw.logicalcpu 2>/dev/null || true)
  fi
  if ! is_positive_integer "$detected"; then
    detected=4
  fi

  if (( detected > 2 )); then
    detected=$(( detected - 2 ))
  else
    detected=1
  fi
  printf '%s\n' "$detected"
}

capability_list_contains() {
  local listing=$1
  local wanted=$2
  local flags
  local names
  local remainder
  local name
  local old_ifs

  while read -r flags names remainder; do
    old_ifs=$IFS
    IFS=,
    set -- $names
    IFS=$old_ifs
    for name in "$@"; do
      [[ "$name" == "$wanted" ]] && return 0
    done
  done <<< "$listing"
  return 1
}

failure_codes=()
failure_conditions=()
failure_remedies=()

record_failure() {
  failure_codes[${#failure_codes[@]}]=$1
  failure_conditions[${#failure_conditions[@]}]=$2
  failure_remedies[${#failure_remedies[@]}]=$3
}

remedy_for_command() {
  case $1 in
    ffmpeg|ffprobe) printf 'brew install ffmpeg' ;;
    gifski) printf 'brew install gifski' ;;
    *) printf 'repair PATH so the base system %s is reachable' "$1" ;;
  esac
}

report_preflight_failures() {
  local index=0
  local count=${#failure_codes[@]}

  if (( json_output == 1 )); then
    printf '{"error":{"code":"preflight_failed","condition":"%s preflight ' "$count" >&2
    printf 'check(s) failed","remedy":"brew install ffmpeg gifski","failures":[' >&2
    while (( index < count )); do
      (( index == 0 )) || printf ',' >&2
      printf '{"code":"%s","condition":"%s","remedy":"%s"}' \
        "$(json_escape "${failure_codes[$index]}")" \
        "$(json_escape "${failure_conditions[$index]}")" \
        "$(json_escape "${failure_remedies[$index]}")" >&2
      index=$(( index + 1))
    done
    printf ']}}\n' >&2
  else
    printf 'ERROR [preflight_failed]: %s preflight check(s) failed\n' "$count" >&2
    while (( index < count )); do
      printf '  [%s] %s\n' "${failure_codes[$index]}" \
        "${failure_conditions[$index]}" >&2
      printf '      Remedy: %s\n' "${failure_remedies[$index]}" >&2
      index=$(( index + 1))
    done
  fi
  exit 2
}

report_preflight_ready() {
  local -a reported=(ffmpeg ffprobe gifski)
  local index=0
  local command_name
  local resolved

  if (( json_output == 1 )); then
    printf '{"status":"ready","os":"%s","commands":{' \
      "$(json_escape "${OSTYPE:-unknown}")"
    while (( index < ${#reported[@]} )); do
      command_name=${reported[$index]}
      resolved=$(command -v "$command_name")
      (( index == 0 )) || printf ','
      printf '"%s":"%s"' "$(json_escape "$command_name")" \
        "$(json_escape "$resolved")"
      index=$(( index + 1))
    done
    printf '}}\n'
  else
    printf 'READY: %s\n' "${OSTYPE:-unknown}"
    while (( index < ${#reported[@]} )); do
      command_name=${reported[$index]}
      printf '%s: %s\n' "$command_name" "$(command -v "$command_name")"
      index=$(( index + 1))
    done
  fi
}

check_ffmpeg_capabilities() {
  local kind=$1
  local flag="-${kind}s"
  shift
  local listing=''
  local capability

  if ! listing=$(ffmpeg -hide_banner "$flag" 2>&1); then
    record_failure ffmpeg_probe_failed \
      "ffmpeg could not report its available ${kind}s" \
      'brew reinstall ffmpeg'
    return
  fi
  for capability in "$@"; do
    if ! capability_list_contains "$listing" "$capability"; then
      record_failure ffmpeg_capability_missing \
        "ffmpeg is missing required $kind: $capability" \
        'install an ffmpeg build that includes it, for example brew install ffmpeg'
    fi
  done
}

check_gifski_capabilities() {
  local version_output=''
  local help_output=''
  local option

  if ! version_output=$(gifski --version 2>&1) || [[ -z "$version_output" ]]; then
    record_failure gifski_probe_failed \
      'gifski is present but could not report its version' \
      'brew reinstall gifski'
    return
  fi
  if ! help_output=$(gifski --help 2>&1); then
    record_failure gifski_probe_failed \
      'gifski is present but could not report its options' \
      'brew reinstall gifski'
    return
  fi

  for option in --fps --width --height --quality --motion-quality \
    --lossy-quality --repeat --quiet --output; do
    if ! gifski_help_has_option "$help_output" "$option"; then
      record_failure gifski_capability_missing \
        "gifski is missing required option: $option" \
        'brew upgrade gifski'
    fi
  done
}

gifski_help_has_option() {
  local help_output=$1
  local wanted=$2
  local line
  local word

  while IFS= read -r line; do
    for word in $line; do
      word=${word%,}
      [[ "$word" == "$wanted" ]] && return 0
    done
  done <<< "$help_output"
  return 1
}

preflight() {
  local -a required_commands=(gifski ffmpeg ffprobe awk mkfifo mktemp wc dirname cp mv rm shasum)
  local command_name

  if [[ ${OSTYPE:-} != darwin* ]]; then
    record_failure os_unsupported \
      "macOS is required, detected OSTYPE=${OSTYPE:-unknown}" \
      'run this skill on macOS; the search depends on macOS ffmpeg builds and /private/tmp'
  fi

  for command_name in "${required_commands[@]}"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      record_failure command_missing \
        "required command not found: $command_name" \
        "$(remedy_for_command "$command_name")"
    fi
  done

  if command -v ffmpeg >/dev/null 2>&1; then
    check_ffmpeg_capabilities filter fps scale format setpts libvmaf
    check_ffmpeg_capabilities encoder rawvideo ffv1
    check_ffmpeg_capabilities decoder rawvideo ffv1 gif
    check_ffmpeg_capabilities muxer yuv4mpegpipe matroska null
    check_ffmpeg_capabilities demuxer yuv4mpegpipe matroska gif
  fi
  if command -v gifski >/dev/null 2>&1; then
    check_gifski_capabilities
  fi

  (( ${#failure_codes[@]} == 0 )) || report_preflight_failures
}

file_bytes() {
  local bytes
  bytes=$(wc -c < "$1")
  bytes=${bytes//[[:space:]]/}
  printf '%s\n' "$bytes"
}

file_digest() {
  local digest_line
  digest_line=$(shasum -a 256 "$1")
  printf '%s\n' "${digest_line%% *}"
}

positional=()
while (( $# > 0 )); do
  case $1 in
    --preflight)
      preflight_only=1
      ;;
    --json)
      json_output=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while (( $# > 0 )); do
        positional[${#positional[@]}]=$1
        shift
      done
      break
      ;;
    -*)
      (( json_output == 1 )) || usage >&2
      fail usage_error "unknown option: $1" \
        'run with --help to see the accepted options'
      ;;
    *)
      positional[${#positional[@]}]=$1
      ;;
  esac
  shift
done

if (( preflight_only == 1 )); then
  if (( ${#positional[@]} > 0 )); then
    fail usage_error '--preflight takes no positional arguments' \
      'run --preflight on its own, then run the conversion separately'
  fi
  preflight
  report_preflight_ready
  exit 0
fi

if (( ${#positional[@]} < 1 || ${#positional[@]} > 2 )); then
  (( json_output == 1 )) || usage >&2
  fail usage_error 'expected INPUT_VIDEO and an optional OUTPUT.gif' \
    'run: mov-to-gif-gifski.sh INPUT_VIDEO [OUTPUT.gif]'
fi

readonly input=${positional[0]}
requested_output=''
if (( ${#positional[@]} == 2 )); then
  requested_output=${positional[1]}
fi

readonly max_bytes=${MAX_BYTES:-$DEFAULT_MAX_BYTES}
readonly gif_size=${GIF_SIZE:-$DEFAULT_SIZE}
readonly min_fps=${MIN_FPS:-$DEFAULT_MIN_FPS}
readonly max_fps=${MAX_FPS:-$DEFAULT_MAX_FPS}
readonly min_quality=${MIN_QUALITY:-$DEFAULT_MIN_QUALITY}
readonly max_quality=${MAX_QUALITY:-$DEFAULT_MAX_QUALITY}

validate_positive_integer MAX_BYTES "$max_bytes"
validate_positive_integer GIF_SIZE "$gif_size"
validate_positive_integer MIN_FPS "$min_fps"
validate_positive_integer MAX_FPS "$max_fps"
validate_quality MIN_QUALITY "$min_quality"
validate_quality MAX_QUALITY "$max_quality"
(( min_fps <= max_fps )) || fail config_invalid \
  "MIN_FPS ($min_fps) must not exceed MAX_FPS ($max_fps)" \
  'set MIN_FPS at or below MAX_FPS, or unset both to take the defaults'
(( min_quality <= max_quality )) || fail config_invalid \
  "MIN_QUALITY ($min_quality) must not exceed MAX_QUALITY ($max_quality)" \
  'set MIN_QUALITY at or below MAX_QUALITY, or unset both to take the defaults'

readonly default_jobs=$(detect_logical_cpus)
readonly jobs=${JOBS:-$default_jobs}
validate_positive_integer JOBS "$jobs"
# Gifski uses internal threads. Limit simultaneous encoders to prevent CPU oversubscription.
if (( jobs > 2 )); then
  readonly encoder_jobs=2
else
  readonly encoder_jobs=$jobs
fi

if [[ -n "$requested_output" ]]; then
  output=$requested_output
else
  output=${input%.*}_${gif_size}x${gif_size}.gif
fi
readonly output

preflight

[[ -f "$input" ]] || fail input_unusable "input is not a regular file: $input" \
  'pass the path of an existing video file'
if [[ -e "$output" || -L "$output" ]]; then
  [[ ! "$input" -ef "$output" ]] || fail output_unusable \
    'input and output paths must differ' \
    'pass an output path that is not the input file'
fi
[[ ! -d "$output" ]] || fail output_unusable "output path is a directory: $output" \
  'pass a file path ending in .gif, not a directory'

output_dir=$(dirname "$output")
[[ -d "$output_dir" ]] || fail output_unusable \
  "output directory does not exist: $output_dir" \
  "create it first: mkdir -p '$output_dir'"
[[ -w "$output_dir" ]] || fail output_unusable \
  "output directory is not writable: $output_dir" \
  'choose an output path in a writable directory'
readonly output_dir

video_stream=''
if ! video_stream=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=index -of csv=p=0 "$input" 2>/dev/null); then
  fail input_unusable "ffprobe could not read input video: $input" \
    'confirm the file is a video ffmpeg can decode'
fi
[[ -n "$video_stream" ]] || fail input_unusable \
  "input contains no video stream: $input" \
  'pass a file that contains video, not audio or still images only'
if ! ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
  -i "$input" -map 0:v:0 -frames:v 1 -an -sn -dn -f null - \
  >/dev/null 2>&1; then
  fail input_unusable "input video does not have a decodable first frame: $input" \
    'the file is truncated or corrupt, re-export it and try again'
fi

if ! work_dir=$(mktemp -d \
  "${TMPDIR:-/private/tmp}/mov-to-gif-gifski.XXXXXX" 2>/dev/null); then
  fail work_directory_unusable \
    "could not create a work directory under ${TMPDIR:-/private/tmp}" \
    'set TMPDIR to a writable local directory and try again'
fi
output_tmp=''
cleanup_started=0
pending_count=0
pending_pids=()
pending_tasks=()
parent_active_count=0
parent_active_pids=()
parent_active_file=''

terminate_pid_file() {
  local pid_file=$1
  local child_pid

  [[ -f "$pid_file" ]] || return
  while IFS= read -r child_pid; do
    if [[ "$child_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill -TERM "$child_pid" >/dev/null 2>&1 || true
    fi
  done < "$pid_file"
}

cleanup() {
  local original_status=$?
  local pid_file
  local worker_pid
  local child_pid

  (( cleanup_started == 0 )) || return "$original_status"
  cleanup_started=1
  trap - EXIT INT TERM
  set +e

  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    for pid_file in "$work_dir"/active-child-*.pid; do
      [[ -f "$pid_file" ]] || continue
      terminate_pid_file "$pid_file"
    done
  fi

  if (( pending_count > 0 )); then
    for worker_pid in "${pending_pids[@]}"; do
      kill -TERM "$worker_pid" >/dev/null 2>&1
    done
    for worker_pid in "${pending_pids[@]}"; do
      wait "$worker_pid" >/dev/null 2>&1
    done
  fi
  if (( parent_active_count > 0 )); then
    for child_pid in "${parent_active_pids[@]}"; do
      kill -TERM "$child_pid" >/dev/null 2>&1
    done
    for child_pid in "${parent_active_pids[@]}"; do
      wait "$child_pid" >/dev/null 2>&1
    done
  fi

  if [[ -n "${output_tmp:-}" && -e "$output_tmp" ]]; then
    rm -f -- "$output_tmp"
  fi
  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    if [[ ${KEEP_WORK:-0} == 1 ]]; then
      printf 'Kept work directory: %s\n' "$work_dir" >&2
    else
      rm -rf -- "$work_dir"
    fi
  fi
  return "$original_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

worker_active_count=0
worker_active_pids=()
worker_active_file=''
worker_task=''

write_pid_file() {
  local pid_file=$1
  local pid
  shift
  : > "$pid_file"
  for pid in "$@"; do
    printf '%s\n' "$pid" >> "$pid_file"
  done
}

worker_cleanup() {
  local status=$?
  local child_pid

  trap - EXIT INT TERM
  set +e
  if (( worker_active_count > 0 )); then
    for child_pid in "${worker_active_pids[@]}"; do
      kill -TERM "$child_pid" >/dev/null 2>&1
    done
    for child_pid in "${worker_active_pids[@]}"; do
      wait "$child_pid" >/dev/null 2>&1
    done
  fi
  [[ -z "${worker_active_file:-}" ]] || rm -f -- "$worker_active_file"
  exit "$status"
}

worker_setup() {
  worker_task=$1
  worker_active_count=0
  worker_active_pids=()
  worker_active_file="$work_dir/active-child-$1.pid"
  trap worker_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

worker_clear_children() {
  worker_active_count=0
  worker_active_pids=()
  rm -f -- "$worker_active_file"
}

worker_abort() {
  local code=$1
  local condition=$2
  printf '%s|%s\n' "$code" "$condition" > "$work_dir/failure-$worker_task.txt"
  exit 1
}

worker_run_stderr() {
  local stderr_file=$1
  local child_status
  shift

  "$@" 2> "$stderr_file" &
  worker_active_pids=("$!")
  worker_active_count=1
  write_pid_file "$worker_active_file" "${worker_active_pids[@]}"
  if wait "${worker_active_pids[0]}"; then
    child_status=0
  else
    child_status=$?
  fi
  worker_clear_children
  return "$child_status"
}

worker_run_stdout() {
  local stdout_file=$1
  local child_status
  shift

  "$@" > "$stdout_file" 2> "$stdout_file.stderr" &
  worker_active_pids=("$!")
  worker_active_count=1
  write_pid_file "$worker_active_file" "${worker_active_pids[@]}"
  if wait "${worker_active_pids[0]}"; then
    child_status=0
  else
    child_status=$?
  fi
  worker_clear_children
  return "$child_status"
}

encode_candidate_worker() {
  local fps=$1
  local quality=$2
  local motion_quality=$3
  local lossy_quality=$4
  local candidate=$5
  local fifo=$6
  local ffmpeg_log=$7
  local gifski_log=$8
  local gifski_pid
  local ffmpeg_pid
  local gifski_status
  local ffmpeg_status

  rm -f -- "$candidate" "$fifo"
  mkfifo "$fifo" 2> "$ffmpeg_log.mkfifo" || return 1

  # Record the consumer before the producer starts. Cleanup can then close every FIFO user.
  gifski --quiet --fps "$fps" --width "$gif_size" --height "$gif_size" \
    --quality "$quality" --motion-quality "$motion_quality" \
    --lossy-quality "$lossy_quality" --repeat 0 --output "$candidate" - \
    < "$fifo" 2> "$gifski_log" &
  gifski_pid=$!
  worker_active_pids=("$gifski_pid")
  worker_active_count=1
  write_pid_file "$worker_active_file" "${worker_active_pids[@]}"

  ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$input" -map 0:v:0 \
    -vf "fps=${fps},scale=${gif_size}:${gif_size}:flags=lanczos,format=yuv420p,setpts=PTS-STARTPTS" \
    -an -sn -dn -c:v rawvideo -pix_fmt yuv420p -f yuv4mpegpipe - \
    > "$fifo" 2> "$ffmpeg_log" &
  ffmpeg_pid=$!

  worker_active_pids=("$ffmpeg_pid" "$gifski_pid")
  worker_active_count=2
  write_pid_file "$worker_active_file" "${worker_active_pids[@]}"

  if wait "$gifski_pid"; then
    gifski_status=0
  else
    gifski_status=$?
    kill -TERM "$ffmpeg_pid" >/dev/null 2>&1 || true
  fi
  if wait "$ffmpeg_pid"; then
    ffmpeg_status=0
  else
    ffmpeg_status=$?
  fi
  worker_clear_children

  if [[ ${KEEP_WORK:-0} != 1 ]]; then
    rm -f -- "$fifo"
  fi
  (( gifski_status == 0 && ffmpeg_status == 0 ))
}

extract_vmaf_worker() {
  local log_file=$1
  local score_file=$2

  worker_run_stdout "$score_file" awk '
    /VMAF score:/ { score=$NF }
    END {
      if (score ~ /^-?[0-9]+([.][0-9]+)?$/) print score
      else exit 1
    }
  ' "$log_file"
}

score_candidate_worker() {
  local candidate=$1
  local log_file=$2
  local score_file=$3

  worker_run_stderr "$log_file" ffmpeg -hide_banner -nostdin \
    -threads 1 -filter_complex_threads 1 \
    -i "$work_dir/vmaf-reference.mkv" -i "$candidate" \
    -lavfi '[0:v]fps=24,setpts=PTS-STARTPTS[ref];[1:v]fps=24,setpts=PTS-STARTPTS[dist];[dist][ref]libvmaf=n_threads=1' \
    -f null - || return 1
  extract_vmaf_worker "$log_file" "$score_file"
}

clamp_quality() {
  local value=$1
  if (( value < min_quality )); then
    value=$min_quality
  elif (( value > max_quality )); then
    value=$max_quality
  fi
  printf '%s\n' "$value"
}

candidate_seen() {
  local identity=$1
  local recorded
  while IFS= read -r recorded; do
    [[ "$recorded" == "$identity" ]] && return 0
  done < "$seen_file"
  return 1
}

candidate_fit=0
evaluate_candidate_worker() {
  local fps=$1
  local quality=$2
  local motion_quality=$3
  local lossy_quality=$4
  local identity="${quality}|${motion_quality}|${lossy_quality}"
  local stem="f${fps}-q${quality}-m${motion_quality}-l${lossy_quality}"
  local candidate="$work_dir/${stem}.gif"
  local fifo="$work_dir/${stem}.y4m.pipe"
  local ffmpeg_log="$work_dir/${stem}-ffmpeg.log"
  local gifski_log="$work_dir/${stem}-gifski.log"
  local vmaf_log="$work_dir/${stem}-vmaf.log"
  local score_file="$work_dir/${stem}-score.txt"
  local bytes
  local score
  local digest

  candidate_fit=0
  candidate_seen "$identity" && return 0
  printf '%s\n' "$identity" >> "$seen_file"

  if ! encode_candidate_worker "$fps" "$quality" "$motion_quality" \
    "$lossy_quality" "$candidate" "$fifo" "$ffmpeg_log" "$gifski_log"; then
    worker_abort candidate_encode_failed \
      "candidate encode failed for $stem; inspect the retained work directory with KEEP_WORK=1"
  fi
  [[ -f "$candidate" ]] || worker_abort candidate_encode_failed \
    "gifski reported success but did not create $stem"

  bytes=$(file_bytes "$candidate")
  if (( bytes < max_bytes )); then
    if ! score_candidate_worker "$candidate" "$vmaf_log" "$score_file"; then
      worker_abort vmaf_failed "VMAF scoring failed for $stem"
    fi
    score=$(<"$score_file")
    [[ "$score" =~ ^-?[0-9]+([.][0-9]+)?$ ]] || worker_abort vmaf_nonnumeric \
      "VMAF did not return a numeric score for $stem"
    digest=$(file_digest "$candidate")
    printf '%s|%s|%s|%s|%s|%s|%s\n' \
      "$score" "$bytes" "$fps" "$quality" "$motion_quality" \
      "$lossy_quality" "$digest" >> "$result_file"
    candidate_fit=1
  fi

  if [[ ${KEEP_WORK:-0} != 1 ]]; then
    rm -f -- "$candidate" "$ffmpeg_log" "$gifski_log" "$vmaf_log" "$score_file"
  fi
}

search_fps_worker() {
  local fps=$1
  local level
  local next_level
  local anchor=''
  local offset
  local quality
  local motion_quality
  local lossy_quality

  worker_setup "search-f${fps}"
  seen_file="$work_dir/seen-f${fps}.txt"
  result_file="$work_dir/result-f${fps}.txt"
  : > "$seen_file"
  : > "$result_file"

  # Test the full coarse ladder. Do not assume that output size is monotonic.
  level=$max_quality
  while :; do
    evaluate_candidate_worker "$fps" "$level" "$level" "$level"
    if (( candidate_fit == 1 )) && [[ -z "$anchor" ]]; then
      anchor=$level
    fi
    (( level == min_quality )) && break
    next_level=$(( level - 10 ))
    (( next_level < min_quality )) && next_level=$min_quality
    level=$next_level
  done

  [[ -n "$anchor" ]] || anchor=$min_quality
  # Refine near the best fitting balanced level with three asymmetric quality profiles.
  for offset in -10 -5 0 5 10; do
    level=$(clamp_quality $(( anchor + offset )))

    evaluate_candidate_worker "$fps" "$level" "$level" "$level"

    quality=$(clamp_quality $(( level + 10 )))
    motion_quality=$(clamp_quality $(( level - 5 )))
    lossy_quality=$(clamp_quality $(( level - 5 )))
    evaluate_candidate_worker "$fps" "$quality" "$motion_quality" "$lossy_quality"

    quality=$(clamp_quality $(( level - 5 )))
    motion_quality=$(clamp_quality $(( level + 10 )))
    lossy_quality=$(clamp_quality $(( level - 5 )))
    evaluate_candidate_worker "$fps" "$quality" "$motion_quality" "$lossy_quality"

    quality=$(clamp_quality $(( level - 5 )))
    motion_quality=$(clamp_quality $(( level - 5 )))
    lossy_quality=$(clamp_quality $(( level + 10 )))
    evaluate_candidate_worker "$fps" "$quality" "$motion_quality" "$lossy_quality"
  done
}

wait_for_oldest() {
  local worker_pid=${pending_pids[0]}
  local worker_task_name=${pending_tasks[0]}
  local status
  local failure_file="$work_dir/failure-$worker_task_name.txt"
  local failure_code='worker_failed'
  local failure_condition="worker failed: $worker_task_name"

  if wait "$worker_pid"; then
    status=0
  else
    status=$?
  fi

  unset 'pending_pids[0]' 'pending_tasks[0]'
  if (( pending_count == 1 )); then
    pending_pids=()
    pending_tasks=()
  else
    pending_pids=("${pending_pids[@]}")
    pending_tasks=("${pending_tasks[@]}")
  fi
  pending_count=$(( pending_count - 1 ))

  if (( status != 0 )); then
    if [[ -f "$failure_file" ]]; then
      IFS='|' read -r failure_code failure_condition < "$failure_file"
    else
      failure_condition="worker failed: $worker_task_name (status $status)"
    fi
    die "$failure_code" "$failure_condition"
  fi
}

track_worker() {
  pending_pids[${#pending_pids[@]}]=$1
  pending_tasks[${#pending_tasks[@]}]=$2
  pending_count=$(( pending_count + 1 ))
  if (( pending_count >= encoder_jobs )); then
    wait_for_oldest
  fi
}

wait_for_workers() {
  while (( pending_count > 0 )); do
    wait_for_oldest
  done
}

parent_record_children() {
  local task=$1
  shift
  local child_pid

  parent_active_file="$work_dir/active-child-$task.pid"
  : > "$parent_active_file"
  for child_pid in "$@"; do
    printf '%s\n' "$child_pid" >> "$parent_active_file"
  done
}

parent_clear_children() {
  parent_active_count=0
  parent_active_pids=()
  [[ -z "$parent_active_file" ]] || rm -f -- "$parent_active_file"
  parent_active_file=''
}

parent_run_stderr() {
  local task=$1
  local stderr_file=$2
  local child_status
  local child_pid
  shift 2

  "$@" 2> "$stderr_file" &
  child_pid=$!
  parent_active_pids=("$child_pid")
  parent_active_count=1
  parent_record_children "$task" "$child_pid"
  if wait "$child_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  parent_clear_children
  return "$child_status"
}

parent_run_stdout() {
  local task=$1
  local stdout_file=$2
  local child_status
  local child_pid
  shift 2

  "$@" > "$stdout_file" 2> "$work_dir/${task}.stderr.log" &
  child_pid=$!
  parent_active_pids=("$child_pid")
  parent_active_count=1
  parent_record_children "$task" "$child_pid"
  if wait "$child_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  parent_clear_children
  return "$child_status"
}

parent_run() {
  local task=$1
  local child_status
  local child_pid
  shift

  "$@" 2> "$work_dir/${task}.stderr.log" &
  child_pid=$!
  parent_active_pids=("$child_pid")
  parent_active_count=1
  parent_record_children "$task" "$child_pid"
  if wait "$child_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  parent_clear_children
  return "$child_status"
}

encode_candidate_parent() {
  local task=$1
  local fps=$2
  local quality=$3
  local motion_quality=$4
  local lossy_quality=$5
  local candidate=$6
  local fifo="$work_dir/${task}.y4m.pipe"
  local ffmpeg_log="$work_dir/${task}-ffmpeg.log"
  local gifski_log="$work_dir/${task}-gifski.log"
  local gifski_pid
  local ffmpeg_pid
  local gifski_status
  local ffmpeg_status

  rm -f -- "$candidate" "$fifo"
  mkfifo "$fifo" 2> "$ffmpeg_log.mkfifo" || return 1

  # Use the same tracked two-process path for regeneration as for search candidates.
  gifski --quiet --fps "$fps" --width "$gif_size" --height "$gif_size" \
    --quality "$quality" --motion-quality "$motion_quality" \
    --lossy-quality "$lossy_quality" --repeat 0 --output "$candidate" - \
    < "$fifo" 2> "$gifski_log" &
  gifski_pid=$!
  parent_active_pids=("$gifski_pid")
  parent_active_count=1
  parent_record_children "$task" "${parent_active_pids[@]}"
  ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$input" -map 0:v:0 \
    -vf "fps=${fps},scale=${gif_size}:${gif_size}:flags=lanczos,format=yuv420p,setpts=PTS-STARTPTS" \
    -an -sn -dn -c:v rawvideo -pix_fmt yuv420p -f yuv4mpegpipe - \
    > "$fifo" 2> "$ffmpeg_log" &
  ffmpeg_pid=$!

  parent_active_pids=("$ffmpeg_pid" "$gifski_pid")
  parent_active_count=2
  parent_record_children "$task" "${parent_active_pids[@]}"

  if wait "$gifski_pid"; then
    gifski_status=0
  else
    gifski_status=$?
    kill -TERM "$ffmpeg_pid" >/dev/null 2>&1 || true
  fi
  if wait "$ffmpeg_pid"; then
    ffmpeg_status=0
  else
    ffmpeg_status=$?
  fi
  parent_clear_children

  if [[ ${KEEP_WORK:-0} != 1 ]]; then
    rm -f -- "$fifo"
  fi
  (( gifski_status == 0 && ffmpeg_status == 0 ))
}

extract_vmaf_parent() {
  local task=$1
  local log_file=$2
  local score_file=$3
  parent_run_stdout "$task-awk" "$score_file" awk '
    /VMAF score:/ { score=$NF }
    END {
      if (score ~ /^-?[0-9]+([.][0-9]+)?$/) print score
      else exit 1
    }
  ' "$log_file"
}

score_candidate_parent() {
  local task=$1
  local candidate=$2
  local log_file=$3
  local score_file=$4

  parent_run_stderr "$task-ffmpeg" "$log_file" ffmpeg -hide_banner -nostdin \
    -threads 1 -filter_complex_threads 1 \
    -i "$work_dir/vmaf-reference.mkv" -i "$candidate" \
    -lavfi '[0:v]fps=24,setpts=PTS-STARTPTS[ref];[1:v]fps=24,setpts=PTS-STARTPTS[dist];[dist][ref]libvmaf=n_threads=1' \
    -f null -
  extract_vmaf_parent "$task" "$log_file" "$score_file"
}

if (( json_output == 0 )); then
  printf 'Searching %s-%s FPS, gifski quality %s-%s under %s bytes at %sx%s with %s encoder workers...\n' \
    "$min_fps" "$max_fps" "$min_quality" "$max_quality" "$max_bytes" \
    "$gif_size" "$gif_size" "$encoder_jobs" >&2
fi

reference_log="$work_dir/vmaf-reference.log"
if ! parent_run_stderr vmaf-reference "$reference_log" ffmpeg -v error -nostdin \
  -threads 1 -filter_threads 1 -i "$input" -map 0:v:0 \
  -vf "scale=${gif_size}:${gif_size}:flags=lanczos,fps=24,setpts=PTS-STARTPTS" \
  -an -sn -dn -c:v ffv1 -level 3 -pix_fmt yuv420p -color_range pc \
  -f matroska "$work_dir/vmaf-reference.mkv"; then
  die reference_failed 'could not prepare the VMAF reference'
fi

fps=$min_fps
while (( fps <= max_fps )); do
  task="search-f${fps}"
  search_fps_worker "$fps" &
  track_worker "$!" "$task"
  (( fps == max_fps )) && break
  fps=$(( fps + 1 ))
done
wait_for_workers

all_results="$work_dir/all-results.txt"
: > "$all_results"
fps=$min_fps
while (( fps <= max_fps )); do
  result_file="$work_dir/result-f${fps}.txt"
  while IFS= read -r result_line; do
    [[ -n "$result_line" ]] && printf '%s\n' "$result_line" >> "$all_results"
  done < "$result_file"
  (( fps == max_fps )) && break
  fps=$(( fps + 1 ))
done

selection=''
if ! selection=$(awk -F'|' '
  NF == 7 {
    if (!found || $1 > score ||
        ($1 == score && $3 > fps) ||
        ($1 == score && $3 == fps && $4 > quality) ||
        ($1 == score && $3 == fps && $4 == quality && $5 > motion) ||
        ($1 == score && $3 == fps && $4 == quality && $5 == motion && $6 > lossy) ||
        ($1 == score && $3 == fps && $4 == quality && $5 == motion && $6 == lossy && $2 < bytes)) {
      found=1
      score=$1
      bytes=$2
      fps=$3
      quality=$4
      motion=$5
      lossy=$6
      digest=$7
    }
  }
  END {
    if (found) print score "|" bytes "|" fps "|" quality "|" motion "|" lossy "|" digest
  }
' "$all_results"); then
  die selection_failed 'candidate selection failed'
fi
[[ -n "$selection" ]] || die no_candidate \
  "no candidate fit below $max_bytes bytes" \
  'increase MAX_BYTES, reduce GIF_SIZE or the FPS range, or lower MIN_QUALITY'
IFS='|' read -r best_score best_bytes best_fps best_quality best_motion \
  best_lossy best_digest <<< "$selection"

regenerated_file="$work_dir/winner-regenerated.gif"
if ! encode_candidate_parent winner-regenerated "$best_fps" "$best_quality" \
  "$best_motion" "$best_lossy" "$regenerated_file"; then
  die regeneration_failed 'winner regeneration failed'
fi
regenerated_bytes=$(file_bytes "$regenerated_file")
(( regenerated_bytes == best_bytes )) || die regeneration_mismatch \
  "winner regeneration size mismatch: recorded $best_bytes, regenerated $regenerated_bytes"
regenerated_digest=$(file_digest "$regenerated_file")
# The installed gifski is deterministic for identical input and parameters.
[[ "$regenerated_digest" == "$best_digest" ]] || die regeneration_mismatch \
  "winner regeneration digest mismatch: recorded $best_digest, regenerated $regenerated_digest"

regen_log="$work_dir/vmaf-winner-regenerated.log"
regen_score_file="$work_dir/score-winner-regenerated.txt"
score_candidate_parent winner-regenerated "$regenerated_file" "$regen_log" "$regen_score_file" \
  || die regeneration_failed 'winner regeneration VMAF scoring failed'
regenerated_score=$(<"$regen_score_file")
[[ "$regenerated_score" == "$best_score" ]] || die regeneration_mismatch \
  "winner regeneration VMAF mismatch: recorded $best_score, regenerated $regenerated_score"

if ! output_tmp=$(mktemp "$output_dir/.mov-to-gif-gifski-output.XXXXXX" 2>/dev/null); then
  die publication_failed 'could not create the destination temporary file'
fi
parent_run publish-copy cp "$regenerated_file" "$output_tmp" \
  || die publication_failed 'could not prepare the destination temporary file'

codec_file="$work_dir/final-codec.txt"
dimensions_file="$work_dir/final-dimensions.txt"
frames_file="$work_dir/final-frames.txt"
duration_file="$work_dir/final-duration.txt"
final_vmaf_log="$work_dir/vmaf-final.log"
final_score_file="$work_dir/score-final.txt"

parent_run_stdout final-codec "$codec_file" ffprobe -v error \
  -select_streams v:0 -show_entries stream=codec_name,codec_type \
  -of csv=s='|':p=0 "$output_tmp" \
  || die verification_failed 'verification failed, ffprobe could not read the output'
codec=$(<"$codec_file")
[[ "$codec" == 'gif|video' ]] || die verification_failed \
  "verification failed, expected a GIF video stream, got ${codec:-missing}"

if ! parent_run_stdout final-dimensions "$dimensions_file" ffprobe -v error \
  -select_streams v:0 -show_entries stream=width,height \
  -of csv=s=x:p=0 "$output_tmp"; then
  die verification_failed 'verification failed, could not read output dimensions'
fi
dimensions=$(<"$dimensions_file")
[[ "$dimensions" == "${gif_size}x${gif_size}" ]] || die verification_failed \
  "verification failed, expected ${gif_size}x${gif_size}, got $dimensions"

if ! parent_run_stdout final-frames "$frames_file" ffprobe -v error -count_frames \
  -select_streams v:0 -show_entries stream=nb_read_frames \
  -of default=nw=1:nk=1 "$output_tmp"; then
  die verification_failed 'verification failed, could not count output frames'
fi
frame_count=$(<"$frames_file")
[[ "$frame_count" =~ ^[0-9]+$ ]] && (( frame_count > 1 )) || die verification_failed \
  "verification failed, invalid frame count: ${frame_count:-missing}"

if ! parent_run_stdout final-duration "$duration_file" ffprobe -v error \
  -show_entries format=duration -of default=nw=1:nk=1 "$output_tmp"; then
  die verification_failed 'verification failed, could not read output duration'
fi
duration=$(<"$duration_file")
if ! awk -v value="$duration" 'BEGIN {
  exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0)
}'; then
  die verification_failed "verification failed, invalid duration: ${duration:-missing}"
fi

final_bytes=$(file_bytes "$output_tmp")
(( final_bytes < max_bytes )) || die verification_failed \
  "verification failed, output is $final_bytes bytes, limit is strictly below $max_bytes"
(( final_bytes == best_bytes )) || die verification_failed \
  "verification failed, expected $best_bytes bytes, got $final_bytes"
final_digest=$(file_digest "$output_tmp")
[[ "$final_digest" == "$best_digest" ]] || die verification_failed \
  "verification failed, output digest does not match the selected winner"

score_candidate_parent final "$output_tmp" "$final_vmaf_log" "$final_score_file" \
  || die verification_failed 'verification failed, final VMAF scoring failed'
final_score=$(<"$final_score_file")
[[ "$final_score" == "$best_score" ]] || die verification_failed \
  "verification failed, expected VMAF $best_score, got $final_score"

parent_run final-publish mv -f -- "$output_tmp" "$output" \
  || die publication_failed 'could not atomically publish the verified GIF'
output_tmp=''

printf 'Selected: %s FPS, quality %s, motion quality %s, lossy quality %s, VMAF %s\n' \
  "$best_fps" "$best_quality" "$best_motion" "$best_lossy" "$best_score"
printf 'Output: %s\n' "$output"
printf 'Verified: %s, %s frames, %ss, %s bytes\n' \
  "$dimensions" "$frame_count" "$duration" "$final_bytes"
