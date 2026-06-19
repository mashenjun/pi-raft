#!/usr/bin/env bash

script_dir="${0%/*}"
repo_root="$script_dir/.."

fail() {
	printf 'FAIL [run-scenario]: %s\n' "$1" >&2
	exit 1
}

usage() {
	printf 'Usage: %s <scenario>\n' "${0##*/}" >&2
	printf 'Example: %s A-happy-path\n' "${0##*/}" >&2
}

normalize_scenario() {
	case "$1" in
		A | A-happy-path)
			printf 'A-happy-path\n'
			;;
		*)
			printf '%s\n' "$1"
			;;
	esac
}

write_a_happy_path_result() {
	local result_file="$1"

	if ! cat >"$result_file" <<'JSON'; then
{
  "scenario": "A-happy-path",
  "runner": "synthetic",
  "events": [
    {
      "type": "block",
      "tool": "write",
      "reason": "Blocked: must read messages first (raft msg read)"
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft msg read --channel general",
      "blocked": false
    },
    {
      "type": "state",
      "state": "MESSAGES_READ"
    },
    {
      "type": "block",
      "tool": "write",
      "reason": "Blocked: must claim a task first (raft task claim <id>)"
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft task claim 42",
      "blocked": false
    },
    {
      "type": "state",
      "state": "TASK_CLAIMED",
      "taskId": "42"
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft task status in_review 42",
      "blocked": false
    },
    {
      "type": "state",
      "state": "IN_REVIEW",
      "taskId": "42"
    },
    {
      "type": "tool_call",
      "tool": "write",
      "path": "test.ts",
      "blocked": false
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft msg post --channel general --thread ts_abc \"done\"",
      "blocked": false
    },
    {
      "type": "state",
      "state": "DONE",
      "taskId": "42",
      "replyTarget": {
        "channel": "general",
        "threadTs": "ts_abc"
      }
    }
  ]
}
JSON
		fail "could not write $result_file"
	fi
}

if (($# != 1)); then
	usage
	exit 2
fi

scenario=$(normalize_scenario "$1")
scenario_file="$repo_root/test-harness/scenarios/$scenario.txt"
results_dir="${PI_RAFT_RESULTS_DIR:-$repo_root/results}"
run_id="${PI_RAFT_RUN_ID:-1}"
result_file="$results_dir/$scenario-$run_id.json"

if [[ ! -f "$scenario_file" ]]; then
	fail "unknown scenario: $scenario"
fi

if ! mkdir -p "$results_dir"; then
	fail "could not create results directory: $results_dir"
fi

case "$scenario" in
	A-happy-path)
		write_a_happy_path_result "$result_file"
		;;
	*)
		fail "scenario is not implemented in H1: $scenario"
		;;
esac

printf '%s\n' "$result_file"
