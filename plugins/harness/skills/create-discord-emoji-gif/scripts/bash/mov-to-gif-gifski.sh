#!/usr/bin/env bash
#
# Deprecated. Superseded by the Node.js converter at
# ../node/mov-to-gif-gifski.js, which is the default entrypoint documented in
# SKILL.md. This script is kept only for hosts that cannot run Node.js 22 or
# newer, and does not emit that converter's metadata report.

set -euo pipefail

readonly DEFAULT_MAX_BYTES=256000
readonly DEFAULT_SIZE=128
readonly DEFAULT_MIN_FPS=15
readonly DEFAULT_MAX_FPS=24
readonly DEFAULT_MIN_QUALITY=1
readonly DEFAULT_MAX_QUALITY=100
readonly MAX_EXACT_INTEGER=9007199254740991

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
  printf '  --preflight [INPUT_VIDEO]\n'
  printf '                  Check the environment and optional input, convert nothing, then exit\n'
  printf '  --json          Report readiness and errors as JSON\n'
  printf '  --help, -h      Print this message\n'
  printf '  --              Stop option parsing\n'
  printf '\n'
  printf 'Environment:\n'
  printf '  MAX_BYTES       Strict byte ceiling (default: 256000, maximum: %s)\n' "$MAX_EXACT_INTEGER"
  printf '  GIF_SIZE        Square width and height (default: 128, maximum: %s)\n' "$MAX_EXACT_INTEGER"
  printf '  MIN_FPS         Minimum frame rate (default: 15, maximum: %s)\n' "$MAX_EXACT_INTEGER"
  printf '  MAX_FPS         Maximum frame rate (default: 24, maximum: 100)\n'
  printf '  JOBS            Parallel work limit (default: logical CPUs minus 2, minimum 1, maximum: %s)\n' "$MAX_EXACT_INTEGER"
  printf '  MIN_QUALITY    Minimum gifski quality (default: 1, maximum: 100)\n'
  printf '  MAX_QUALITY    Maximum gifski quality (default: 100, maximum: 100)\n'
  printf '  KEEP_WORK       Keep the work directory when set to 1 (default: unset)\n'
  printf '\n'
  printf 'All positive integers have an exact-value ceiling of %s.\n' "$MAX_EXACT_INTEGER"
  printf '\n'
  printf 'Exit status:\n'
  printf '  0    Success or passed preflight\n'
  printf '  1    Conversion work started and failed\n'
  printf '  2    Work did not start\n'
  printf '  129  SIGHUP\n'
  printf '  130  SIGINT\n'
  printf '  143  SIGTERM\n'
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
  (( length < ${#MAX_EXACT_INTEGER} )) && return 0
  (( length > ${#MAX_EXACT_INTEGER} )) && return 1
  [[ "$value" < "$MAX_EXACT_INTEGER" || "$value" == "$MAX_EXACT_INTEGER" ]]
}

validate_positive_integer() {
  is_positive_integer "$2" || fail config_invalid \
    "$1 must be a positive integer no greater than $MAX_EXACT_INTEGER, got '$2'" \
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
warning_codes=()
warning_conditions=()
warning_recommendations=()

record_failure() {
  failure_codes[${#failure_codes[@]}]=$1
  failure_conditions[${#failure_conditions[@]}]=$2
  failure_remedies[${#failure_remedies[@]}]=$3
}

record_warning() {
  warning_codes[${#warning_codes[@]}]=$1
  warning_conditions[${#warning_conditions[@]}]=$2
  warning_recommendations[${#warning_recommendations[@]}]=$3
}

print_warnings_json() {
  local index=0

  printf '['
  while (( index < ${#warning_codes[@]} )); do
    (( index == 0 )) || printf ','
    printf '{"code":"%s","condition":"%s","recommendation":"%s"}' \
      "$(json_escape "${warning_codes[$index]}")" \
      "$(json_escape "${warning_conditions[$index]}")" \
      "$(json_escape "${warning_recommendations[$index]}")"
    index=$(( index + 1))
  done
  printf ']'
}

emit_warnings() {
  (( ${#warning_codes[@]} > 0 )) || return 0
  if (( json_output == 1 )); then
    printf '{"warnings":' >&2
    print_warnings_json >&2
    printf '}\n' >&2
  else
    print_warnings_plain >&2
  fi
}

print_warnings_plain() {
  local index=0

  while (( index < ${#warning_codes[@]} )); do
    printf 'WARNING [%s]: %s\n' "${warning_codes[$index]}" \
      "${warning_conditions[$index]}"
    printf 'Recommendation: %s\n' "${warning_recommendations[$index]}"
    index=$(( index + 1))
  done
}

is_macos() {
  [[ ${OSTYPE:-} == darwin* ]]
}

remedy_for_command() {
  if is_macos; then
    case $1 in
      ffmpeg|ffprobe) printf 'brew install ffmpeg' ;;
      gifski) printf 'brew install gifski' ;;
      *) printf 'repair PATH so the base system %s is reachable' "$1" ;;
    esac
  else
    case $1 in
      ffmpeg|ffprobe) printf 'sudo apt install ffmpeg (or use a build with libvmaf if the VMAF filter check fails)' ;;
      gifski) printf 'cargo install gifski, or install the prebuilt binary from https://gif.ski' ;;
      *) printf 'repair PATH so the base system %s is reachable' "$1" ;;
    esac
  fi
}

digest_command_remedy() {
  if is_macos; then
    printf 'confirm shasum is on PATH (it ships with the system Perl), or brew install coreutils for sha256sum'
  else
    printf 'install coreutils (sha256sum) or perl (shasum)'
  fi
}

install_remedy() {
  if is_macos; then
    printf 'brew install ffmpeg gifski'
  else
    printf 'sudo apt install ffmpeg; cargo install gifski (or install the prebuilt binary from https://gif.ski)'
  fi
}

digest_cmd=()

resolve_digest_command() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest_cmd=(sha256sum)
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    digest_cmd=(shasum -a 256)
    return 0
  fi
  return 1
}

report_preflight_failures() {
  local index=0
  local count=${#failure_codes[@]}

  if (( json_output == 1 )); then
    printf '{"error":{"code":"preflight_failed","condition":"%s preflight ' "$count" >&2
    printf 'check(s) failed","remedy":"%s","failures":[' "$(json_escape "$(install_remedy)")" >&2
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
    printf '},"warnings":'
    print_warnings_json
    printf '}\n'
  else
    printf 'READY: %s\n' "${OSTYPE:-unknown}"
    while (( index < ${#reported[@]} )); do
      command_name=${reported[$index]}
      printf '%s: %s\n' "$command_name" "$(command -v "$command_name")"
      index=$(( index + 1))
    done
    print_warnings_plain
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
      "$(is_macos && printf 'brew reinstall ffmpeg' || printf 'reinstall ffmpeg from your package manager or a static build')"
    return
  fi
  for capability in "$@"; do
    if ! capability_list_contains "$listing" "$capability"; then
      if [[ "$capability" == libvmaf ]]; then
        record_failure ffmpeg_capability_missing \
          "ffmpeg is missing required $kind: $capability" \
          "$(is_macos && printf 'brew reinstall ffmpeg' || printf 'install an ffmpeg build with libvmaf enabled, for example a static build from https://johnvansickle.com/ffmpeg/, jellyfin-ffmpeg, or a source build configured with --enable-libvmaf; the distribution ffmpeg package commonly omits it')"
      else
        record_failure ffmpeg_capability_missing \
          "ffmpeg is missing required $kind: $capability" \
          "$(is_macos && printf 'brew reinstall ffmpeg' || printf 'install an ffmpeg build that includes it')"
      fi
    fi
  done
}

ffprobe_reinstall_remedy() {
  is_macos && printf 'brew reinstall ffmpeg' \
    || printf 'reinstall ffmpeg from your package manager or a static build'
}

ffprobe_upgrade_remedy() {
  is_macos && printf 'brew upgrade ffmpeg' \
    || printf 'install an ffprobe build that includes it'
}

check_ffprobe_capabilities() {
  local version_output=''
  local help_output=''
  local option

  if ! version_output=$(ffprobe -v error -show_program_version -of json 2>&1) \
    || [[ -z "$version_output" ]]; then
    record_failure ffprobe_probe_failed \
      'ffprobe is present but could not report its program version' \
      "$(ffprobe_reinstall_remedy)"
  fi
  if ! help_output=$(ffprobe -hide_banner -h full 2>&1); then
    record_failure ffprobe_probe_failed \
      'ffprobe is present but could not report its options' \
      "$(ffprobe_reinstall_remedy)"
  else
    for option in -of -select_streams -show_entries -count_frames; do
      gifski_help_has_option "$help_output" "$option" || record_failure \
        ffprobe_capability_missing \
        "ffprobe is missing required option: $option" \
        "$(ffprobe_upgrade_remedy)"
    done
  fi
}

check_gifski_capabilities() {
  local version_output=''
  local help_output=''
  local option

  if ! version_output=$(gifski --version 2>&1) || [[ -z "$version_output" ]]; then
    record_failure gifski_probe_failed \
      'gifski is present but could not report its version' \
      "$(is_macos && printf 'brew reinstall gifski' || printf 'reinstall gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski')"
  fi
  if ! help_output=$(gifski --help 2>&1); then
    record_failure gifski_probe_failed \
      'gifski is present but could not report its options' \
      "$(is_macos && printf 'brew reinstall gifski' || printf 'reinstall gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski')"
  else
    for option in --fps --width --height --quality --motion-quality \
      --lossy-quality --repeat --quiet --output; do
      if ! gifski_help_has_option "$help_output" "$option"; then
        record_failure gifski_capability_missing \
          "gifski is missing required option: $option" \
          "$(is_macos && printf 'brew upgrade gifski' || printf 'upgrade gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski')"
      fi
    done
  fi
}

gifski_help_has_option() {
  local help_output=$1
  local wanted=$2
  local line
  local word

  while IFS= read -r line; do
    for word in $line; do
      word=${word%,}
      [[ "$word" == "$wanted" || "$word" == "$wanted="* \
        || "$word" == "$wanted["* ]] && return 0
    done
  done <<< "$help_output"
  return 1
}

preflight() {
  local -a required_commands=(gifski ffmpeg ffprobe awk mktemp wc dirname cp mv rm)
  local command_name

  for command_name in "${required_commands[@]}"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      record_failure command_missing \
        "required command not found: $command_name" \
        "$(remedy_for_command "$command_name")"
    fi
  done

  if ! resolve_digest_command; then
    record_failure command_missing \
      'no SHA-256 digest command found on PATH (checked sha256sum, shasum)' \
      "$(digest_command_remedy)"
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    check_ffmpeg_capabilities filter fps scale format setpts libvmaf
    check_ffmpeg_capabilities encoder rawvideo ffv1
    check_ffmpeg_capabilities decoder rawvideo ffv1 gif
    check_ffmpeg_capabilities muxer yuv4mpegpipe matroska null
    check_ffmpeg_capabilities demuxer yuv4mpegpipe matroska gif
  fi
  if command -v ffprobe >/dev/null 2>&1; then
    check_ffprobe_capabilities
  fi
  if command -v gifski >/dev/null 2>&1; then
    check_gifski_capabilities
  fi

  (( ${#failure_codes[@]} == 0 )) || report_preflight_failures
}

validate_input_path() {
  local input_path=$1

  [[ -f "$input_path" ]] || fail input_unusable \
    "input is not a regular file: $input_path" \
    'pass the path of an existing video file'
}

inspect_input_video() {
  local input_path=$1
  local video_stream=''
  local input_duration=''

  if ! video_stream=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=index -of csv=p=0 "$input_path" 2>/dev/null); then
    fail input_unusable "ffprobe could not read input video: $input_path" \
      'confirm the file is a video ffmpeg can decode'
  fi
  [[ -n "$video_stream" ]] || fail input_unusable \
    "input contains no video stream: $input_path" \
    'pass a file that contains video, not audio or still images only'
  if ! ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
    -i "$input_path" -map 0:v:0 -frames:v 1 -an -sn -dn -f null - \
    >/dev/null 2>&1; then
    fail input_unusable "input video does not have a decodable first frame: $input_path" \
      'the file is truncated or corrupt, re-export it and try again'
  fi
  if ! input_duration=$(ffprobe -v error -show_entries format=duration \
    -of default=nw=1:nk=1 "$input_path" 2>/dev/null) || \
    ! awk -v value="$input_duration" 'BEGIN {
      exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0)
    }'; then
    fail input_unusable "ffprobe could not read a valid input duration: $input_path" \
      'confirm the file is a complete video with a positive duration'
  fi
  if awk -v value="$input_duration" 'BEGIN { exit !(value > 3) }'; then
    record_warning input_duration_long \
      "input duration is ${input_duration}s, which is longer than 3 seconds" \
      'trim the clip to 3 seconds or less for better quality'
  fi
}

file_bytes() {
  local bytes
  bytes=$(wc -c < "$1")
  bytes=${bytes//[[:space:]]/}
  printf '%s\n' "$bytes"
}

file_digest() {
  local digest_line
  digest_line=$("${digest_cmd[@]}" "$1")
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
  if (( ${#positional[@]} > 1 )); then
    fail usage_error '--preflight accepts at most one INPUT_VIDEO' \
      'run --preflight alone or pass one input video'
  fi
  if (( ${#positional[@]} == 1 )); then
    validate_input_path "${positional[0]}"
  fi
  preflight
  if (( ${#positional[@]} == 1 )); then
    inspect_input_video "${positional[0]}"
  fi
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
(( max_fps <= 100 )) || fail config_invalid \
  "MAX_FPS ($max_fps) must not exceed 100, gifski's maximum frame rate" \
  'set MAX_FPS to 100 or lower, or use mov-to-gif.sh for higher frame rates'
(( min_quality <= max_quality )) || fail config_invalid \
  "MIN_QUALITY ($min_quality) must not exceed MAX_QUALITY ($max_quality)" \
  'set MIN_QUALITY at or below MAX_QUALITY, or unset both to take the defaults'

readonly default_jobs=$(detect_logical_cpus)
readonly jobs=${JOBS:-$default_jobs}
validate_positive_integer JOBS "$jobs"
# Gifski 1.34.0 created 33 threads with Rayon unrestricted. Divide available jobs between
# concurrent FPS workers, then bound each encoder's Rayon pool to avoid oversubscription.
readonly fps_count=$(( max_fps - min_fps + 1 ))
encoder_jobs=$(( jobs / 2 ))
(( encoder_jobs < 1 )) && encoder_jobs=1
(( encoder_jobs > fps_count )) && encoder_jobs=$fps_count
readonly encoder_jobs
gifski_threads=$(( jobs / encoder_jobs ))
(( gifski_threads < 2 )) && gifski_threads=2
(( gifski_threads > 8 )) && gifski_threads=8
readonly gifski_threads
export RAYON_NUM_THREADS=$gifski_threads

if [[ -n "$requested_output" ]]; then
  output=$requested_output
else
  output=${input%.*}_${gif_size}x${gif_size}.gif
fi
readonly output

validate_input_path "$input"
preflight

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

inspect_input_video "$input"
emit_warnings

if ! work_dir=$(mktemp -d \
  "${TMPDIR:-/tmp}/mov-to-gif-gifski.XXXXXX" 2>/dev/null); then
  fail work_directory_unusable \
    "could not create a work directory under ${TMPDIR:-/tmp}" \
    'set TMPDIR to a writable local directory and try again'
fi
output_tmp=''
cleanup_started=0
pending_pids=()
pending_tasks=()
active_pid=''
active_file=''

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

  (( cleanup_started == 0 )) || return "$original_status"
  cleanup_started=1
  trap - EXIT HUP INT TERM
  set +e

  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    for pid_file in "$work_dir"/active-child-*.pid; do
      [[ -f "$pid_file" ]] || continue
      terminate_pid_file "$pid_file"
    done
  fi

  if (( ${#pending_pids[@]} > 0 )); then
    for worker_pid in "${pending_pids[@]}"; do
      kill -TERM "$worker_pid" >/dev/null 2>&1
    done
    for worker_pid in "${pending_pids[@]}"; do
      wait "$worker_pid" >/dev/null 2>&1
    done
  fi
  if [[ -n "$active_pid" ]]; then
    kill -TERM "$active_pid" >/dev/null 2>&1
    wait "$active_pid" >/dev/null 2>&1
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
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

worker_task=''
worker_source_cache=''

worker_cleanup() {
  local status=$?

  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$active_pid" ]]; then
    kill -TERM "$active_pid" >/dev/null 2>&1
    wait "$active_pid" >/dev/null 2>&1
  fi
  [[ -z "${active_file:-}" ]] || rm -f -- "$active_file"
  if [[ ${KEEP_WORK:-0} != 1 && -n "${worker_source_cache:-}" \
    && -e "$worker_source_cache" ]]; then
    rm -f -- "$worker_source_cache"
  fi
  exit "$status"
}

worker_setup() {
  worker_task=$1
  active_pid=''
  active_file=''
  worker_source_cache=''
  trap worker_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

clear_child() {
  active_pid=''
  [[ -z "$active_file" ]] || rm -f -- "$active_file"
  active_file=''
}

worker_abort() {
  local code=$1
  local condition=$2
  local remedy=$3
  local log_file=${4:-}
  local captured=''

  if [[ -n "$log_file" && -f "$log_file" ]]; then
    captured=$(tr '\n' ' ' < "$log_file")
    [[ -z "$captured" ]] || condition="$condition: $captured"
  fi
  printf '%s|%s\n' "$code" "$condition" > "$work_dir/failure-$worker_task.txt"
  printf '%s\n' "$remedy" > "$work_dir/failure-$worker_task.remedy.txt"
  exit 1
}

run_child() {
  local task=$1
  local stdout_file=$2
  local stderr_file=$3
  local child_status
  shift 3

  # An asynchronous command otherwise receives /dev/null on stdin in Bash 3.2. Gifski
  # reads its y4m stream from '-', so preserve the caller's explicit input redirection.
  if [[ "$stdout_file" == '-' ]]; then
    "$@" <&0 2> "$stderr_file" &
  else
    "$@" <&0 > "$stdout_file" 2> "$stderr_file" &
  fi
  active_pid=$!
  active_file="$work_dir/active-child-$task.pid"
  printf '%s\n' "$active_pid" > "$active_file"
  if wait "$active_pid"; then
    child_status=0
  else
    child_status=$?
  fi
  clear_child
  return "$child_status"
}

encode_candidate() {
  local task=$1
  local fps=$2
  local quality=$3
  local motion_quality=$4
  local lossy_quality=$5
  local candidate=$6
  local source_cache=$7
  local gifski_log=$8

  rm -f -- "$candidate"
  run_child "$task-gifski" - "$gifski_log" \
    gifski --quiet --fps "$fps" --width "$gif_size" --height "$gif_size" \
    --quality "$quality" --motion-quality "$motion_quality" \
    --lossy-quality "$lossy_quality" --repeat 0 --output "$candidate" - \
    < "$source_cache"
}

extract_vmaf() {
  local task=$1
  local log_file=$2
  local score_file=$3

  run_child "$task-awk" "$score_file" "$score_file.stderr" awk '
    /VMAF score:/ { score=$NF }
    END {
      if (score ~ /^-?[0-9]+([.][0-9]+)?$/) print score
      else exit 1
    }
  ' "$log_file"
}

score_candidate() {
  local task=$1
  local candidate=$2
  local log_file=$3
  local score_file=$4

  run_child "$task-vmaf" - "$log_file" ffmpeg -hide_banner -nostdin \
    -threads 1 -filter_complex_threads 1 \
    -i "$work_dir/vmaf-reference.mkv" -i "$candidate" \
    -lavfi '[0:v]fps=24,setpts=PTS-STARTPTS[ref];[1:v]fps=24,setpts=PTS-STARTPTS[dist];[dist][ref]libvmaf=n_threads=1' \
    -f null - || return 1
  extract_vmaf "$task" "$log_file" "$score_file"
}

prepare_source_cache() {
  local task=$1
  local fps=$2
  local destination=$3
  local log_file=$4

  rm -f -- "$destination"
  run_child "$task" - "$log_file" \
    ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
      -i "$input" -map 0:v:0 \
      -vf "fps=${fps},scale=${gif_size}:${gif_size}:flags=lanczos,format=yuv444p,setpts=PTS-STARTPTS" \
      -an -sn -dn -c:v rawvideo -pix_fmt yuv444p -f yuv4mpegpipe -y "$destination"
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
  local source_cache="$work_dir/source-f${fps}.y4m"
  local gifski_log="$work_dir/${stem}-gifski.log"
  local vmaf_log="$work_dir/${stem}-vmaf.log"
  local score_file="$work_dir/${stem}-score.txt"
  local bytes
  local score
  local digest

  candidate_fit=0
  candidate_seen "$identity" && return 0
  printf '%s\n' "$identity" >> "$seen_file"

  if ! encode_candidate "$stem" "$fps" "$quality" "$motion_quality" \
    "$lossy_quality" "$candidate" "$source_cache" "$gifski_log"; then
    worker_abort candidate_encode_failed \
      "candidate encode failed for $stem" \
      'fix the reported gifski error, then run the same conversion again' "$gifski_log"
  fi
  [[ -f "$candidate" ]] || worker_abort candidate_encode_failed \
    "gifski reported success but did not create $stem" \
    'repair or reinstall gifski, then run the same conversion again'

  bytes=$(file_bytes "$candidate")
  if (( bytes < max_bytes )); then
    if ! score_candidate "$stem" "$candidate" "$vmaf_log" "$score_file"; then
      worker_abort vmaf_failed "VMAF scoring failed for $stem" \
        'fix the reported ffmpeg libvmaf error, then run the same conversion again' "$vmaf_log"
    fi
    score=$(<"$score_file")
    [[ "$score" =~ ^-?[0-9]+([.][0-9]+)?$ ]] || worker_abort vmaf_nonnumeric \
      "VMAF did not return a numeric score for $stem" \
      'reinstall an ffmpeg build with a working libvmaf filter'
    digest=$(file_digest "$candidate")
    printf '%s|%s|%s|%s|%s|%s|%s\n' \
      "$score" "$bytes" "$fps" "$quality" "$motion_quality" \
      "$lossy_quality" "$digest" >> "$result_file"
    candidate_fit=1
  fi

  if [[ ${KEEP_WORK:-0} != 1 ]]; then
    rm -f -- "$candidate" "$gifski_log" "$vmaf_log" "$score_file" \
      "$score_file.stderr"
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
  local source_cache="$work_dir/source-f${fps}.y4m"
  local source_log="$work_dir/source-f${fps}-ffmpeg.log"
  local seen_file="$work_dir/seen-f${fps}.txt"
  local result_file="$work_dir/result-f${fps}.txt"
  worker_source_cache=$source_cache
  if ! prepare_source_cache "source-f${fps}" "$fps" "$source_cache" "$source_log"; then
    worker_abort source_prepare_failed \
      "could not prepare the source cache for ${fps} FPS" \
      'fix the reported ffmpeg decode or filter error, then run the same conversion again' \
      "$source_log"
  fi
  : > "$seen_file"
  : > "$result_file"

  # Test the complete coarse ladder through min_quality. Gifski output size is not monotonic,
  # so an earlier fitting anchor cannot prove that lower levels are worse candidates.
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

  if [[ ${KEEP_WORK:-0} != 1 ]]; then
    rm -f -- "$source_cache"
    worker_source_cache=''
  fi
}

wait_for_oldest() {
  local worker_pid=${pending_pids[0]}
  local worker_task_name=${pending_tasks[0]}
  local status
  local failure_file="$work_dir/failure-$worker_task_name.txt"
  local remedy_file="$work_dir/failure-$worker_task_name.remedy.txt"
  local failure_code='worker_failed'
  local failure_condition="worker failed: $worker_task_name"
  local failure_remedy='run the conversion again and inspect the reported worker failure'

  if wait "$worker_pid"; then
    status=0
  else
    status=$?
  fi

  pending_pids=("${pending_pids[@]:1}")
  pending_tasks=("${pending_tasks[@]:1}")

  if (( status != 0 )); then
    if [[ -f "$failure_file" ]]; then
      IFS='|' read -r failure_code failure_condition < "$failure_file"
    else
      failure_condition="worker failed: $worker_task_name (status $status)"
    fi
    if [[ -f "$remedy_file" ]]; then
      failure_remedy=$(<"$remedy_file")
    fi
    die "$failure_code" "$failure_condition" "$failure_remedy"
  fi
}

track_worker() {
  pending_pids[${#pending_pids[@]}]=$1
  pending_tasks[${#pending_tasks[@]}]=$2
  if (( ${#pending_pids[@]} >= encoder_jobs )); then
    wait_for_oldest
  fi
}

wait_for_workers() {
  while (( ${#pending_pids[@]} > 0 )); do
    wait_for_oldest
  done
}

if (( json_output == 0 )); then
  printf 'Searching %s-%s FPS, gifski quality %s-%s under %s bytes at %sx%s with %s encoder workers and %s gifski threads each...\n' \
    "$min_fps" "$max_fps" "$min_quality" "$max_quality" "$max_bytes" \
    "$gif_size" "$gif_size" "$encoder_jobs" "$gifski_threads" >&2
fi

reference_log="$work_dir/vmaf-reference.log"
if ! run_child vmaf-reference - "$reference_log" ffmpeg -v error -nostdin \
  -threads 1 -filter_threads 1 -i "$input" -map 0:v:0 \
  -vf "scale=${gif_size}:${gif_size}:flags=lanczos,fps=24,setpts=PTS-STARTPTS" \
  -an -sn -dn -c:v ffv1 -level 3 -pix_fmt yuv420p -color_range pc \
  -f matroska "$work_dir/vmaf-reference.mkv"; then
  die reference_failed 'could not prepare the VMAF reference' \
    'fix the ffmpeg decode or filter error in vmaf-reference.log, then run again'
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
  die selection_failed 'candidate selection failed' \
    'repair the system awk command, then run the conversion again'
fi
[[ -n "$selection" ]] || die no_candidate \
  "no candidate fit below $max_bytes bytes" \
  'increase MAX_BYTES, reduce GIF_SIZE or the FPS range, or lower MIN_QUALITY'
IFS='|' read -r best_score best_bytes best_fps best_quality best_motion \
  best_lossy best_digest <<< "$selection"

winner_source="$work_dir/source-f${best_fps}.y4m"
winner_source_log="$work_dir/winner-source-ffmpeg.log"
if ! prepare_source_cache winner-source "$best_fps" "$winner_source" \
  "$winner_source_log"; then
  winner_source_stderr=$(tr '\n' ' ' < "$winner_source_log")
  winner_source_stderr=${winner_source_stderr% }
  die regeneration_failed "winner source preparation failed: $winner_source_stderr" \
    'fix the reported ffmpeg decode or filter error, then run the same conversion again'
fi

regenerated_file="$work_dir/winner-regenerated.gif"
regenerated_log="$work_dir/winner-regenerated-gifski.log"
if ! encode_candidate winner-regenerated "$best_fps" "$best_quality" \
  "$best_motion" "$best_lossy" "$regenerated_file" "$winner_source" \
  "$regenerated_log"; then
  regeneration_stderr=$(tr '\n' ' ' < "$regenerated_log")
  regeneration_stderr=${regeneration_stderr% }
  die regeneration_failed "winner regeneration failed: $regeneration_stderr" \
    'fix the reported gifski error, then run the same conversion again'
fi
[[ -f "$regenerated_file" ]] || die regeneration_failed \
  'gifski reported success but did not create the regenerated winner' \
  'repair or reinstall gifski, then run the same conversion again'
regenerated_digest=$(file_digest "$regenerated_file")
# With gifski 1.34.0, separately regenerated yuv444p caches had identical digests. Sequential
# and concurrent encodes from those caches also matched, and output was independent of
# RAYON_NUM_THREADS. This is observed behavior, not a documented gifski guarantee. A future
# mismatch can indicate a gifski version change or a source-cache mismatch.
[[ "$regenerated_digest" == "$best_digest" ]] || die regeneration_mismatch \
  "winner regeneration digest mismatch: recorded $best_digest, regenerated $regenerated_digest" \
  'reinstall the reviewed gifski version or inspect source-cache determinism before retrying'

if ! output_tmp=$(mktemp "$output_dir/.mov-to-gif-gifski-output.XXXXXX" 2>/dev/null); then
  die publication_failed 'could not create the destination temporary file' \
    'make the output directory writable and ensure it has free space'
fi
if ! run_child publish-copy - "$work_dir/publish-copy.stderr.log" \
  cp "$regenerated_file" "$output_tmp" < /dev/null; then
  publication_stderr=$(<"$work_dir/publish-copy.stderr.log")
  [[ -n "$publication_stderr" ]] || publication_stderr='command failed without stderr'
  die publication_failed \
    "could not prepare the destination temporary file: $publication_stderr" \
    'make the output directory writable and ensure it has free space'
fi

codec_file="$work_dir/final-codec.txt"
dimensions_file="$work_dir/final-dimensions.txt"
frames_file="$work_dir/final-frames.txt"
duration_file="$work_dir/final-duration.txt"
run_child final-codec "$codec_file" "$work_dir/final-codec.stderr.log" ffprobe -v error \
  -select_streams v:0 -show_entries stream=codec_name,codec_type \
  -of csv=s='|':p=0 "$output_tmp" < /dev/null \
  || die verification_failed 'verification failed, ffprobe could not read the output' \
    'reinstall ffmpeg, then run the conversion again'
codec=$(<"$codec_file")
[[ "$codec" == 'gif|video' ]] || die verification_failed \
  "verification failed, expected a GIF video stream, got ${codec:-missing}" \
  'repair or reinstall gifski, then run the conversion again'

if ! run_child final-dimensions "$dimensions_file" \
  "$work_dir/final-dimensions.stderr.log" ffprobe -v error \
  -select_streams v:0 -show_entries stream=width,height \
  -of csv=s=x:p=0 "$output_tmp" < /dev/null; then
  die verification_failed 'verification failed, could not read output dimensions' \
    'reinstall ffmpeg, then run the conversion again'
fi
dimensions=$(<"$dimensions_file")
[[ "$dimensions" == "${gif_size}x${gif_size}" ]] || die verification_failed \
  "verification failed, expected ${gif_size}x${gif_size}, got $dimensions" \
  'repair or reinstall gifski, then run the conversion again'

if ! run_child final-frames "$frames_file" "$work_dir/final-frames.stderr.log" \
  ffprobe -v error -count_frames \
  -select_streams v:0 -show_entries stream=nb_read_frames \
  -of default=nw=1:nk=1 "$output_tmp" < /dev/null; then
  die verification_failed 'verification failed, could not count output frames' \
    'reinstall ffmpeg, then run the conversion again'
fi
frame_count=$(<"$frames_file")
[[ "$frame_count" =~ ^[0-9]+$ ]] && (( frame_count > 1 )) || die verification_failed \
  "verification failed, invalid frame count: ${frame_count:-missing}" \
  'raise the selected FPS or use an input with more than one frame'

if ! run_child final-duration "$duration_file" "$work_dir/final-duration.stderr.log" \
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 \
  "$output_tmp" < /dev/null; then
  die verification_failed 'verification failed, could not read output duration' \
    'reinstall ffmpeg, then run the conversion again'
fi
duration=$(<"$duration_file")
if ! awk -v value="$duration" 'BEGIN {
  exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0)
}'; then
  die verification_failed "verification failed, invalid duration: ${duration:-missing}" \
    'use an input video with a positive duration and run the conversion again'
fi

final_bytes=$(file_bytes "$output_tmp")
(( final_bytes < max_bytes )) || die verification_failed \
  "verification failed, output is $final_bytes bytes, limit is strictly below $max_bytes" \
  'increase MAX_BYTES or reduce GIF_SIZE, then run the conversion again'
final_digest=$(file_digest "$output_tmp")
[[ "$final_digest" == "$best_digest" ]] || die verification_failed \
  "verification failed, output digest does not match the selected winner" \
  'ensure the output directory is on a reliable local filesystem, then run again'

if ! run_child final-publish - "$work_dir/final-publish.stderr.log" \
  mv -f -- "$output_tmp" "$output" < /dev/null; then
  publication_stderr=$(<"$work_dir/final-publish.stderr.log")
  [[ -n "$publication_stderr" ]] || publication_stderr='command failed without stderr'
  die publication_failed \
    "could not atomically publish the verified GIF: $publication_stderr" \
    'make the output directory writable and ensure it has free space'
fi
output_tmp=''

printf 'Selected: %s FPS, quality %s, motion quality %s, lossy quality %s, VMAF %s\n' \
  "$best_fps" "$best_quality" "$best_motion" "$best_lossy" "$best_score"
printf 'Output: %s\n' "$output"
printf 'Verified: %s, %s frames, %ss, %s bytes\n' \
  "$dimensions" "$frame_count" "$duration" "$final_bytes"
