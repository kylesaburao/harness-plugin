#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_MAX_BYTES=256000
readonly DEFAULT_SIZE=128
readonly DEFAULT_MIN_FPS=15
readonly DEFAULT_MAX_FPS=24
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
  printf 'Environment: MAX_BYTES, GIF_SIZE, MIN_FPS, MAX_FPS, JOBS, KEEP_WORK=1\n'
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
      "$(json_escape "$code")" "$(json_escape "$condition")" "$(json_escape "$remedy")" >&2
  else
    printf 'ERROR [%s]: %s\n' "$code" "$condition" >&2
    [[ -z "$remedy" ]] || printf 'Remedy: %s\n' "$remedy" >&2
  fi
}

# Cannot start: the caller has to change an argument or the machine.
fail() {
  report_error "$1" "$2" "${3:-}"
  exit 2
}

# The conversion started and could not finish, so there is nothing to remedy.
die() {
  report_error "$1" "$2" ''
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

# Homebrew ships ffmpeg with libvmaf, which the search depends on.
remedy_for_command() {
  case $1 in
    ffmpeg|ffprobe) printf 'brew install ffmpeg' ;;
    gifsicle) printf 'brew install gifsicle' ;;
    *) printf 'repair PATH so the base system %s is reachable' "$1" ;;
  esac
}

report_preflight_failures() {
  local index=0
  local count=${#failure_codes[@]}

  if (( json_output == 1 )); then
    printf '{"error":{"code":"preflight_failed","condition":"%s preflight ' "$count" >&2
    printf 'check(s) failed","remedy":"brew install ffmpeg gifsicle","failures":[' >&2
    while (( index < count )); do
      (( index == 0 )) || printf ',' >&2
      printf '{"code":"%s","condition":"%s","remedy":"%s"}' \
        "$(json_escape "${failure_codes[$index]}")" \
        "$(json_escape "${failure_conditions[$index]}")" \
        "$(json_escape "${failure_remedies[$index]}")" >&2
      index=$(( index + 1 ))
    done
    printf ']}}\n' >&2
  else
    printf 'ERROR [preflight_failed]: %s preflight check(s) failed\n' "$count" >&2
    while (( index < count )); do
      printf '  [%s] %s\n' "${failure_codes[$index]}" "${failure_conditions[$index]}" >&2
      printf '      Remedy: %s\n' "${failure_remedies[$index]}" >&2
      index=$(( index + 1 ))
    done
  fi
  exit 2
}

report_preflight_ready() {
  local -a reported=(ffmpeg ffprobe gifsicle)
  local index=0
  local command_name
  local resolved

  if (( json_output == 1 )); then
    printf '{"status":"ready","os":"%s","commands":{' "$(json_escape "${OSTYPE:-unknown}")"
    while (( index < ${#reported[@]} )); do
      command_name=${reported[$index]}
      resolved=$(command -v "$command_name")
      (( index == 0 )) || printf ','
      printf '"%s":"%s"' "$(json_escape "$command_name")" "$(json_escape "$resolved")"
      index=$(( index + 1 ))
    done
    printf '}}\n'
  else
    printf 'READY: %s\n' "${OSTYPE:-unknown}"
    while (( index < ${#reported[@]} )); do
      command_name=${reported[$index]}
      printf '%s: %s\n' "$command_name" "$(command -v "$command_name")"
      index=$(( index + 1 ))
    done
  fi
}

# The listing flag is always the plural of the capability kind: -filters, -encoders.
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

preflight() {
  local -a required_commands=(ffmpeg ffprobe gifsicle awk mktemp wc dirname cp mv rm)
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
    check_ffmpeg_capabilities filter fps scale format palettegen paletteuse setpts libvmaf
    check_ffmpeg_capabilities encoder rawvideo ffv1 gif png
    check_ffmpeg_capabilities decoder rawvideo ffv1 gif png
    check_ffmpeg_capabilities muxer nut matroska gif image2 null
    check_ffmpeg_capabilities demuxer nut matroska gif image2
  fi

  (( ${#failure_codes[@]} == 0 )) || report_preflight_failures
}

file_bytes() {
  local bytes
  bytes=$(wc -c < "$1")
  bytes=${bytes//[[:space:]]/}
  printf '%s\n' "$bytes"
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
      fail usage_error "unknown option: $1" 'run with --help to see the accepted options'
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
    'run: mov-to-gif.sh INPUT_VIDEO [OUTPUT.gif]'
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

validate_positive_integer MAX_BYTES "$max_bytes"
validate_positive_integer GIF_SIZE "$gif_size"
validate_positive_integer MIN_FPS "$min_fps"
validate_positive_integer MAX_FPS "$max_fps"
(( min_fps <= max_fps )) || fail config_invalid \
  "MIN_FPS ($min_fps) must not exceed MAX_FPS ($max_fps)" \
  'set MIN_FPS at or below MAX_FPS, or unset both to take the defaults'

readonly default_jobs=$(detect_logical_cpus)
readonly jobs=${JOBS:-$default_jobs}
validate_positive_integer JOBS "$jobs"

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
  -show_entries stream=index -of csv=p=0 "$input"); then
  fail input_unusable "ffprobe could not read input video: $input" \
    'confirm the file is a video ffmpeg can decode'
fi
[[ -n "$video_stream" ]] || fail input_unusable \
  "input contains no video stream: $input" \
  'pass a file that contains video, not audio or still images only'
if ! ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
  -i "$input" -map 0:v:0 -frames:v 1 -an -f null - >/dev/null; then
  fail input_unusable "input video does not have a decodable first frame: $input" \
    'the file is truncated or corrupt, re-export it and try again'
fi

work_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/mov-to-gif.XXXXXX")
output_tmp=''
cleanup_started=0
pending_count=0
pending_pids=()
pending_tasks=()
parent_active_child_pid=''

cleanup() {
  local original_status=$?
  local pid_file
  local child_pid
  local worker_pid

  (( cleanup_started == 0 )) || return "$original_status"
  cleanup_started=1
  trap - EXIT INT TERM
  set +e

  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    for pid_file in "$work_dir"/active-child-*.pid; do
      [[ -f "$pid_file" ]] || continue
      child_pid=$(<"$pid_file")
      if [[ "$child_pid" =~ ^[1-9][0-9]*$ ]]; then
        kill -TERM "$child_pid" >/dev/null 2>&1
      fi
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
  if [[ -n "${parent_active_child_pid:-}" ]]; then
    kill -TERM "$parent_active_child_pid" >/dev/null 2>&1
    wait "$parent_active_child_pid" >/dev/null 2>&1
    parent_active_child_pid=''
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

worker_cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "${active_child_pid:-}" ]]; then
    kill -TERM "$active_child_pid" >/dev/null 2>&1
    wait "$active_child_pid" >/dev/null 2>&1
  fi
  [[ -z "${active_child_file:-}" ]] || rm -f -- "$active_child_file"
  exit "$status"
}

worker_setup() {
  active_child_pid=''
  active_child_file="$work_dir/active-child-$1.pid"
  trap worker_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

worker_wait_for_child() {
  local child_status

  if wait "$active_child_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  active_child_pid=''
  rm -f -- "$active_child_file"
  return "$child_status"
}

worker_run() {
  "$@" &
  active_child_pid=$!
  printf '%s\n' "$active_child_pid" > "$active_child_file"
  worker_wait_for_child
}

worker_run_stderr() {
  local stderr_file=$1
  shift
  "$@" 2> "$stderr_file" &
  active_child_pid=$!
  printf '%s\n' "$active_child_pid" > "$active_child_file"
  worker_wait_for_child
}

worker_run_stdout() {
  local stdout_file=$1
  shift
  "$@" > "$stdout_file" &
  active_child_pid=$!
  printf '%s\n' "$active_child_pid" > "$active_child_file"
  worker_wait_for_child
}

parent_wait_for_child() {
  local child_pid=$1
  local pid_file=$2
  local child_status

  if wait "$child_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  parent_active_child_pid=''
  rm -f -- "$pid_file"
  return "$child_status"
}

parent_run() {
  local task=$1
  local pid_file="$work_dir/active-child-$task.pid"
  local child_pid
  shift
  "$@" &
  child_pid=$!
  parent_active_child_pid=$child_pid
  printf '%s\n' "$child_pid" > "$pid_file"
  parent_wait_for_child "$child_pid" "$pid_file"
}

parent_run_stderr() {
  local task=$1
  local stderr_file=$2
  local pid_file="$work_dir/active-child-$task.pid"
  local child_pid
  shift 2
  "$@" 2> "$stderr_file" &
  child_pid=$!
  parent_active_child_pid=$child_pid
  printf '%s\n' "$child_pid" > "$pid_file"
  parent_wait_for_child "$child_pid" "$pid_file"
}

parent_run_stdout() {
  local task=$1
  local stdout_file=$2
  local pid_file="$work_dir/active-child-$task.pid"
  local child_pid
  shift 2
  "$@" > "$stdout_file" &
  child_pid=$!
  parent_active_child_pid=$child_pid
  printf '%s\n' "$child_pid" > "$pid_file"
  parent_wait_for_child "$child_pid" "$pid_file"
}

prepare_scaled_source() {
  local fps=$1
  local task=$2
  worker_setup "$task"
  worker_run ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$input" \
    -vf "fps=${fps},scale=${gif_size}:${gif_size}:flags=lanczos,format=bgra" \
    -an -c:v rawvideo -pix_fmt bgra -f nut \
    "$work_dir/source-f${fps}.nut"
}

prepare_vmaf_reference() {
  local task=$1
  worker_setup "$task"
  worker_run ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$input" \
    -vf "scale=${gif_size}:${gif_size}:flags=lanczos,fps=24" \
    -an -c:v ffv1 -level 3 -pix_fmt yuv420p -color_range pc \
    -f matroska "$work_dir/vmaf-reference.mkv"
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
    -f null -
  extract_vmaf_worker "$log_file" "$score_file"
}

evaluate_color_task() {
  local fps=$1
  local colors=$2
  local task=$3
  local palette="$work_dir/palette-f${fps}-c${colors}.png"
  local result="$work_dir/result-f${fps}-c${colors}.txt"
  local scale
  local raw
  local candidate
  local log_file
  local score_file
  local bytes
  local score

  worker_setup "$task"
  : > "$result"
  worker_run ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$work_dir/source-f${fps}.nut" \
    -vf "palettegen=max_colors=${colors}:stats_mode=diff" \
    -frames:v 1 -c:v png -f image2 -update 1 -y "$palette"

  scale=2
  while (( scale <= 5 )); do
    raw="$work_dir/raw-f${fps}-c${colors}-d${scale}.gif"
    candidate="$work_dir/f${fps}-c${colors}-d${scale}.gif"
    log_file="$work_dir/vmaf-f${fps}-c${colors}-d${scale}.log"
    score_file="$work_dir/score-f${fps}-c${colors}-d${scale}.txt"

    worker_run ffmpeg -v error -nostdin -threads 1 -filter_complex_threads 1 \
      -i "$work_dir/source-f${fps}.nut" -i "$palette" \
      -filter_complex "[0:v][1:v]paletteuse=dither=bayer:bayer_scale=${scale}:diff_mode=rectangle" \
      -an -loop 0 -c:v gif -f gif -y "$raw"
    worker_run gifsicle -O3 "$raw" -o "$candidate"
    rm -f -- "$raw"

    bytes=$(file_bytes "$candidate")
    if (( bytes < max_bytes )); then
      score_candidate_worker "$candidate" "$log_file" "$score_file"
      score=$(<"$score_file")
      [[ "$score" =~ ^-?[0-9]+([.][0-9]+)?$ ]] \
        || die vmaf_nonnumeric "VMAF did not return a numeric score for f${fps}-c${colors}-d${scale}"
      printf '%s|%s|%s|%s|%s\n' \
        "$score" "$bytes" "$fps" "$colors" "$scale" >> "$result"
    fi

    if [[ ${KEEP_WORK:-0} != 1 ]]; then
      rm -f -- "$log_file" "$score_file"
    fi
    scale=$(( scale + 1 ))
  done

  if [[ ${KEEP_WORK:-0} != 1 ]]; then
    rm -f -- "$palette" "$work_dir"/f"$fps"-c"$colors"-d*.gif
  fi
}

wait_for_oldest() {
  local worker_pid=${pending_pids[0]}
  local worker_task=${pending_tasks[0]}
  local status

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
    die worker_failed "worker failed: $worker_task (status $status)"
  fi
}

track_worker() {
  pending_pids[${#pending_pids[@]}]=$1
  pending_tasks[${#pending_tasks[@]}]=$2
  pending_count=$(( pending_count + 1 ))
  if (( pending_count >= jobs )); then
    wait_for_oldest
  fi
}

wait_for_workers() {
  while (( pending_count > 0 )); do
    wait_for_oldest
  done
}

generate_palette_parent() {
  local fps=$1
  local colors=$2
  local palette=$3
  parent_run winner-palette ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$work_dir/source-f${fps}.nut" \
    -vf "palettegen=max_colors=${colors}:stats_mode=diff" \
    -frames:v 1 -c:v png -f image2 -update 1 -y "$palette"
}

generate_candidate_parent() {
  local fps=$1
  local colors=$2
  local scale=$3
  local palette=$4
  local raw=$5
  local candidate=$6
  parent_run winner-gif ffmpeg -v error -nostdin -threads 1 -filter_complex_threads 1 \
    -i "$work_dir/source-f${fps}.nut" -i "$palette" \
    -filter_complex "[0:v][1:v]paletteuse=dither=bayer:bayer_scale=${scale}:diff_mode=rectangle" \
    -an -loop 0 -c:v gif -f gif -y "$raw"
  parent_run winner-optimize gifsicle -O3 "$raw" -o "$candidate"
  rm -f -- "$raw"
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

printf 'Searching %s-%s FPS, 4-256 colors, dithers 2-5 under %s bytes at %sx%s with %s workers...\n' \
  "$min_fps" "$max_fps" "$max_bytes" "$gif_size" "$gif_size" "$jobs" >&2

prepare_vmaf_reference vmaf-reference &
track_worker "$!" vmaf-reference
fps=$min_fps
while (( fps <= max_fps )); do
  task="source-f${fps}"
  prepare_scaled_source "$fps" "$task" &
  track_worker "$!" "$task"
  (( fps == max_fps )) && break
  fps=$(( fps + 1 ))
done
wait_for_workers

fps=$min_fps
while (( fps <= max_fps )); do
  colors=4
  while (( colors <= 256 )); do
    task="candidate-f${fps}-c${colors}"
    evaluate_color_task "$fps" "$colors" "$task" &
    track_worker "$!" "$task"
    colors=$(( colors + 1 ))
  done
  (( fps == max_fps )) && break
  fps=$(( fps + 1 ))
done
wait_for_workers

all_results="$work_dir/all-results.txt"
: > "$all_results"
fps=$min_fps
while (( fps <= max_fps )); do
  colors=4
  while (( colors <= 256 )); do
    record="$work_dir/result-f${fps}-c${colors}.txt"
    while IFS= read -r result_line; do
      [[ -n "$result_line" ]] && printf '%s\n' "$result_line" >> "$all_results"
    done < "$record"
    colors=$(( colors + 1 ))
  done
  (( fps == max_fps )) && break
  fps=$(( fps + 1 ))
done

selection=''
if ! selection=$(awk -F'|' '
  NF == 5 {
    if (!found || $1 > score ||
        ($1 == score && $3 > fps) ||
        ($1 == score && $3 == fps && $4 > colors) ||
        ($1 == score && $3 == fps && $4 == colors && $5 < dither)) {
      found=1
      score=$1
      bytes=$2
      fps=$3
      colors=$4
      dither=$5
    }
  }
  END { if (found) print score "|" bytes "|" fps "|" colors "|" dither }
' "$all_results"); then
  die selection_failed 'candidate selection failed'
fi
[[ -n "$selection" ]] || die no_candidate "no candidate fit below $max_bytes bytes, raise MAX_BYTES or lower GIF_SIZE"
IFS='|' read -r best_score best_bytes best_fps best_colors best_scale <<< "$selection"

best_palette="$work_dir/palette-f${best_fps}-c${best_colors}.png"
best_file="$work_dir/f${best_fps}-c${best_colors}-d${best_scale}.gif"
best_raw="$work_dir/raw-f${best_fps}-c${best_colors}-d${best_scale}.gif"
[[ -f "$best_palette" ]] || generate_palette_parent "$best_fps" "$best_colors" "$best_palette"
if [[ ! -f "$best_file" ]]; then
  generate_candidate_parent "$best_fps" "$best_colors" "$best_scale" \
    "$best_palette" "$best_raw" "$best_file"
fi

regenerated_bytes=$(file_bytes "$best_file")
(( regenerated_bytes == best_bytes )) \
  || die regeneration_mismatch "winner regeneration size mismatch: recorded $best_bytes, regenerated $regenerated_bytes"
regen_log="$work_dir/vmaf-winner-regenerated.log"
regen_score_file="$work_dir/score-winner-regenerated.txt"
score_candidate_parent winner-regenerated "$best_file" "$regen_log" "$regen_score_file"
regenerated_score=$(<"$regen_score_file")
[[ "$regenerated_score" == "$best_score" ]] \
  || die regeneration_mismatch "winner regeneration VMAF mismatch: recorded $best_score, regenerated $regenerated_score"

output_tmp=$(mktemp "$output_dir/.mov-to-gif-output.XXXXXX")
parent_run publish-copy cp "$best_file" "$output_tmp"

probe_file="$work_dir/final-probe.txt"
dimensions_file="$work_dir/final-dimensions.txt"
frames_file="$work_dir/final-frames.txt"
duration_file="$work_dir/final-duration.txt"
final_vmaf_log="$work_dir/vmaf-final.log"
final_score_file="$work_dir/score-final.txt"

parent_run_stdout final-probe "$probe_file" ffprobe -v error \
  -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "$output_tmp"
[[ "$(<"$probe_file")" == video ]] || die verification_failed 'verification failed, output has no readable video stream'

parent_run_stdout final-dimensions "$dimensions_file" ffprobe -v error \
  -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$output_tmp"
dimensions=$(<"$dimensions_file")
[[ "$dimensions" == "${gif_size}x${gif_size}" ]] \
  || die verification_failed "verification failed, expected ${gif_size}x${gif_size}, got $dimensions"

parent_run_stdout final-frames "$frames_file" ffprobe -v error -count_frames \
  -select_streams v:0 -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$output_tmp"
frame_count=$(<"$frames_file")
[[ "$frame_count" =~ ^[0-9]+$ ]] && (( frame_count > 1 )) \
  || die verification_failed "verification failed, invalid frame count: ${frame_count:-missing}"

parent_run_stdout final-duration "$duration_file" ffprobe -v error \
  -show_entries format=duration -of default=nw=1:nk=1 "$output_tmp"
duration=$(<"$duration_file")
if ! awk -v value="$duration" 'BEGIN {
  exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0)
}'; then
  die verification_failed "verification failed, invalid duration: ${duration:-missing}"
fi

final_bytes=$(file_bytes "$output_tmp")
(( final_bytes < max_bytes )) \
  || die verification_failed "verification failed, output is $final_bytes bytes"
(( final_bytes == best_bytes )) \
  || die verification_failed "verification failed, expected $best_bytes bytes, got $final_bytes"

score_candidate_parent final "$output_tmp" "$final_vmaf_log" "$final_score_file"
final_score=$(<"$final_score_file")
[[ "$final_score" == "$best_score" ]] \
  || die verification_failed "verification failed, expected VMAF $best_score, got $final_score"

mv -f -- "$output_tmp" "$output"
output_tmp=''

printf 'Selected: %s FPS, %s colors, dither %s, VMAF %s\n' \
  "$best_fps" "$best_colors" "$best_scale" "$best_score"
printf 'Output: %s\n' "$output"
printf 'Verified: %s, %s frames, %ss, %s bytes\n' \
  "$dimensions" "$frame_count" "$duration" "$final_bytes"
