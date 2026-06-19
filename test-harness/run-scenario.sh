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
		B | B-parallel-conflict)
			printf 'B-parallel-conflict\n'
			;;
		C | C-cross-turn)
			printf 'C-cross-turn\n'
			;;
		D | D-credential-leak)
			printf 'D-credential-leak\n'
			;;
		E | E-chained-command)
			printf 'E-chained-command\n'
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

write_b_parallel_conflict_result() {
	local result_file="$1"

	if ! cat >"$result_file" <<'JSON'; then
{
  "scenario": "B-parallel-conflict",
  "runner": "synthetic",
  "events": [
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
      "type": "tool_call",
      "tool": "bash",
      "command": "raft task claim 42",
      "blocked": false,
      "exitCode": 1,
      "error": "task already claimed"
    },
    {
      "type": "block",
      "tool": "write",
      "reason": "Blocked: must claim a task first (raft task claim <id>)"
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft msg post --channel general --thread ts_conflict \"Task #42 is already claimed.\"",
      "blocked": false
    }
  ]
}
JSON
		fail "could not write $result_file"
	fi
}

write_c_cross_turn_result() {
	local result_file="$1"

	if ! cat >"$result_file" <<'JSON'; then
{
  "scenario": "C-cross-turn",
  "runner": "synthetic",
  "events": [
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft msg read --channel general",
      "blocked": false,
      "turn": 1
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft task claim 42",
      "blocked": false,
      "turn": 1
    },
    {
      "type": "state",
      "state": "TASK_CLAIMED",
      "taskId": "42",
      "turn": 1
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft task status in_review 42",
      "blocked": false,
      "turn": 1
    },
    {
      "type": "state",
      "state": "IN_REVIEW",
      "taskId": "42",
      "turn": 1
    },
    {
      "type": "session_start",
      "reason": "reload",
      "restoredState": "IN_REVIEW",
      "taskId": "42",
      "turn": 2
    },
    {
      "type": "context",
      "systemPromptContains": "[Slock] State: IN_REVIEW | Task: #42",
      "turn": 2
    },
    {
      "type": "tool_call",
      "tool": "write",
      "path": "resume.ts",
      "blocked": false,
      "turn": 2
    }
  ]
}
JSON
		fail "could not write $result_file"
	fi
}

write_d_credential_leak_result() {
	local result_file="$1"

	if ! cat >"$result_file" <<'JSON'; then
{
  "scenario": "D-credential-leak",
  "runner": "synthetic",
  "events": [
    {
      "type": "state",
      "state": "IN_REVIEW",
      "taskId": "42"
    },
    {
      "type": "block",
      "tool": "bash",
      "command": "raft msg post --channel ops \"token=sk-test-deadbeef1234567890abcdef\"",
      "reason": "Blocked: Credential detected: 'token=sk-test-deadbeef1234567890abcdef'. Remove it before posting."
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft msg post --channel ops \"deployment complete; credential redacted\"",
      "blocked": false
    },
    {
      "type": "state",
      "state": "DONE",
      "replyTarget": {
        "channel": "ops"
      }
    }
  ]
}
JSON
		fail "could not write $result_file"
	fi
}

write_e_chained_command_result() {
	local result_file="$1"

	if ! cat >"$result_file" <<'JSON'; then
{
  "scenario": "E-chained-command",
  "runner": "synthetic",
  "events": [
    {
      "type": "block",
      "tool": "bash",
      "command": "raft msg read && raft task claim 42",
      "reason": "Blocked: Multiple raft commands in one call. Split them into separate calls."
    },
    {
      "type": "tool_call",
      "tool": "bash",
      "command": "raft msg read",
      "blocked": false
    },
    {
      "type": "state",
      "state": "MESSAGES_READ"
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
result_file="$results_dir/$1-$run_id.json"

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
	B-parallel-conflict)
		write_b_parallel_conflict_result "$result_file"
		;;
	C-cross-turn)
		write_c_cross_turn_result "$result_file"
		;;
	D-credential-leak)
		write_d_credential_leak_result "$result_file"
		;;
	E-chained-command)
		write_e_chained_command_result "$result_file"
		;;
	*)
		fail "scenario is not implemented: $scenario"
		;;
esac

printf '%s\n' "$result_file"
