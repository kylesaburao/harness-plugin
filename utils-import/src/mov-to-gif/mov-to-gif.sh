#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_MAX_BYTES=256000
readonly DEFAULT_SIZE=128
readonly DEFAULT_MIN_FPS=15
readonly DEFAULT_MAX_FPS=24
readonly MAX_SIGNED_INTEGER=9223372036854775807

usage() {
  printf 'Usage: %s INPUT_VIDEO [OUTPUT.gif]\n' "${0##*/}" >&2
  printf 'Environment: MAX_BYTES, GIF_SIZE, MIN_FPS, MAX_FPS, JOBS, KEEP_WORK=1\n' >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
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
  is_positive_integer "$2" || die "$1 must be a positive integer no greater than $MAX_SIGNED_INTEGER"
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

preflight() {
  local -a failures=()
  local -a required_commands=(ffmpeg ffprobe gifsicle awk mktemp wc dirname cp mv rm)
  local -a required_filters=(fps scale format palettegen paletteuse setpts libvmaf)
  local -a required_encoders=(rawvideo ffv1 gif png)
  local -a required_decoders=(rawvideo ffv1 gif png)
  local -a required_muxers=(nut matroska gif image2 null)
  local -a required_demuxers=(nut matroska gif image2)
  local command_name
  local capability
  local listing

  if [[ ${OSTYPE:-} != darwin* ]]; then
    failures[${#failures[@]}]="macOS is required, detected OSTYPE=${OSTYPE:-unknown}"
  fi

  for command_name in "${required_commands[@]}"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      failures[${#failures[@]}]="required command not found: $command_name"
    fi
  done

  if command -v ffmpeg >/dev/null 2>&1; then
    listing=''
    if ! listing=$(ffmpeg -hide_banner -filters 2>&1); then
      failures[${#failures[@]}]='ffmpeg could not report its available filters'
    else
      for capability in "${required_filters[@]}"; do
        if ! capability_list_contains "$listing" "$capability"; then
          failures[${#failures[@]}]="ffmpeg is missing required filter: $capability"
        fi
      done
    fi

    listing=''
    if ! listing=$(ffmpeg -hide_banner -encoders 2>&1); then
      failures[${#failures[@]}]='ffmpeg could not report its available encoders'
    else
      for capability in "${required_encoders[@]}"; do
        if ! capability_list_contains "$listing" "$capability"; then
          failures[${#failures[@]}]="ffmpeg is missing required encoder: $capability"
        fi
      done
    fi

    listing=''
    if ! listing=$(ffmpeg -hide_banner -decoders 2>&1); then
      failures[${#failures[@]}]='ffmpeg could not report its available decoders'
    else
      for capability in "${required_decoders[@]}"; do
        if ! capability_list_contains "$listing" "$capability"; then
          failures[${#failures[@]}]="ffmpeg is missing required decoder: $capability"
        fi
      done
    fi

    listing=''
    if ! listing=$(ffmpeg -hide_banner -muxers 2>&1); then
      failures[${#failures[@]}]='ffmpeg could not report its available muxers'
    else
      for capability in "${required_muxers[@]}"; do
        if ! capability_list_contains "$listing" "$capability"; then
          failures[${#failures[@]}]="ffmpeg is missing required muxer: $capability"
        fi
      done
    fi

    listing=''
    if ! listing=$(ffmpeg -hide_banner -demuxers 2>&1); then
      failures[${#failures[@]}]='ffmpeg could not report its available demuxers'
    else
      for capability in "${required_demuxers[@]}"; do
        if ! capability_list_contains "$listing" "$capability"; then
          failures[${#failures[@]}]="ffmpeg is missing required demuxer: $capability"
        fi
      done
    fi
  fi

  if (( ${#failures[@]} > 0 )); then
    printf 'Preflight failed:\n' >&2
    printf '  - %s\n' "${failures[@]}" >&2
    exit 1
  fi
}

file_bytes() {
  local bytes
  bytes=$(wc -c < "$1")
  bytes=${bytes//[[:space:]]/}
  printf '%s\n' "$bytes"
}

if (( $# < 1 || $# > 2 )); then
  usage
  exit 2
fi

readonly input=$1
requested_output=''
if (( $# == 2 )); then
  requested_output=$2
fi

readonly max_bytes=${MAX_BYTES:-$DEFAULT_MAX_BYTES}
readonly gif_size=${GIF_SIZE:-$DEFAULT_SIZE}
readonly min_fps=${MIN_FPS:-$DEFAULT_MIN_FPS}
readonly max_fps=${MAX_FPS:-$DEFAULT_MAX_FPS}

validate_positive_integer MAX_BYTES "$max_bytes"
validate_positive_integer GIF_SIZE "$gif_size"
validate_positive_integer MIN_FPS "$min_fps"
validate_positive_integer MAX_FPS "$max_fps"
(( min_fps <= max_fps )) || die 'MIN_FPS must not exceed MAX_FPS'

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

[[ -f "$input" ]] || die "input is not a regular file: $input"
if [[ -e "$output" || -L "$output" ]]; then
  [[ ! "$input" -ef "$output" ]] || die 'input and output paths must differ'
fi
[[ ! -d "$output" ]] || die "output path is a directory: $output"

output_dir=$(dirname "$output")
[[ -d "$output_dir" ]] || die "output directory does not exist: $output_dir"
[[ -w "$output_dir" ]] || die "output directory is not writable: $output_dir"
readonly output_dir

video_stream=''
if ! video_stream=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=index -of csv=p=0 "$input"); then
  die "ffprobe could not read input video: $input"
fi
[[ -n "$video_stream" ]] || die "input contains no video stream: $input"
if ! ffmpeg -v error -nostdin -threads 1 -filter_threads 1 \
  -i "$input" -map 0:v:0 -frames:v 1 -an -f null - >/dev/null; then
  die "input video does not have a decodable first frame: $input"
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
        || die "VMAF did not return a numeric score for f${fps}-c${colors}-d${scale}"
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
    die "worker failed: $worker_task (status $status)"
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
  die 'candidate selection failed'
fi
[[ -n "$selection" ]] || die "no candidate fit below $max_bytes bytes"
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
  || die "winner regeneration size mismatch: recorded $best_bytes, regenerated $regenerated_bytes"
regen_log="$work_dir/vmaf-winner-regenerated.log"
regen_score_file="$work_dir/score-winner-regenerated.txt"
score_candidate_parent winner-regenerated "$best_file" "$regen_log" "$regen_score_file"
regenerated_score=$(<"$regen_score_file")
[[ "$regenerated_score" == "$best_score" ]] \
  || die "winner regeneration VMAF mismatch: recorded $best_score, regenerated $regenerated_score"

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
[[ "$(<"$probe_file")" == video ]] || die 'verification failed, output has no readable video stream'

parent_run_stdout final-dimensions "$dimensions_file" ffprobe -v error \
  -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$output_tmp"
dimensions=$(<"$dimensions_file")
[[ "$dimensions" == "${gif_size}x${gif_size}" ]] \
  || die "verification failed, expected ${gif_size}x${gif_size}, got $dimensions"

parent_run_stdout final-frames "$frames_file" ffprobe -v error -count_frames \
  -select_streams v:0 -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$output_tmp"
frame_count=$(<"$frames_file")
[[ "$frame_count" =~ ^[0-9]+$ ]] && (( frame_count > 1 )) \
  || die "verification failed, invalid frame count: ${frame_count:-missing}"

parent_run_stdout final-duration "$duration_file" ffprobe -v error \
  -show_entries format=duration -of default=nw=1:nk=1 "$output_tmp"
duration=$(<"$duration_file")
if ! awk -v value="$duration" 'BEGIN {
  exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0)
}'; then
  die "verification failed, invalid duration: ${duration:-missing}"
fi

final_bytes=$(file_bytes "$output_tmp")
(( final_bytes < max_bytes )) \
  || die "verification failed, output is $final_bytes bytes"
(( final_bytes == best_bytes )) \
  || die "verification failed, expected $best_bytes bytes, got $final_bytes"

score_candidate_parent final "$output_tmp" "$final_vmaf_log" "$final_score_file"
final_score=$(<"$final_score_file")
[[ "$final_score" == "$best_score" ]] \
  || die "verification failed, expected VMAF $best_score, got $final_score"

mv -f -- "$output_tmp" "$output"
output_tmp=''

printf 'Selected: %s FPS, %s colors, dither %s, VMAF %s\n' \
  "$best_fps" "$best_colors" "$best_scale" "$best_score"
printf 'Output: %s\n' "$output"
printf 'Verified: %s, %s frames, %ss, %s bytes\n' \
  "$dimensions" "$frame_count" "$duration" "$final_bytes"
