#!/usr/bin/env bash

fail() {
	printf 'FAIL [%s]: %s\n' "$scenario" "$1" >&2
	exit 1
}

pass() {
	printf 'PASS [%s]: %s\n' "$scenario" "$1"
}

usage() {
	printf 'Usage: %s <scenario> <result-file>\n' "${0##*/}" >&2
	printf 'Example: %s A-happy-path results/A-happy-path-1.json\n' \
		"${0##*/}" >&2
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

assert_jq() {
	local query="$1"
	local message="$2"

	if ! jq -e "$query" "$result" >/dev/null; then
		fail "$message"
	fi
}

if (($# != 2)); then
	usage
	exit 2
fi

scenario=$(normalize_scenario "$1")
result="$2"

if ! command -v jq >/dev/null 2>&1; then
	fail "jq is required"
fi

if [[ ! -f "$result" ]]; then
	fail "result file not found: $result"
fi

case "$scenario" in
	A-happy-path)
		assert_jq \
			'.events[] | select(.type == "block" and (.reason | contains("msg read")))' \
			"expected write block before msg read"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "MESSAGES_READ")' \
			"expected transition to MESSAGES_READ"
		assert_jq \
			'.events[] | select(.type == "block" and (.reason | contains("task claim")))' \
			"expected write block before task claim"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "TASK_CLAIMED" and .taskId == "42")' \
			"expected transition to TASK_CLAIMED with taskId 42"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "IN_REVIEW")' \
			"expected transition to IN_REVIEW"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "write" and .blocked == false)' \
			"expected write tool call allowed after task claim"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "DONE" and .replyTarget.channel == "general" and .replyTarget.threadTs == "ts_abc")' \
			"expected transition to DONE with reply target"
		pass "all assertions passed"
		;;
	B-parallel-conflict)
		assert_jq \
			'.events[] | select(.type == "state" and .state == "MESSAGES_READ")' \
			"expected transition to MESSAGES_READ"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "bash" and (.command | contains("raft task claim 42")) and .exitCode == 1)' \
			"expected failed claim attempt for task 42"
		assert_jq \
			'.events[] | select(.type == "block" and .tool == "write" and (.reason | contains("task claim")))' \
			"expected write blocked after failed claim"
		assert_jq \
			'([.events[] | select(.type == "tool_call" and .tool == "write" and .blocked == false)] | length) == 0' \
			"expected no allowed write after failed claim"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "bash" and (.command | contains("already claimed")) and .blocked == false)' \
			"expected conflict report without file mutation"
		pass "all assertions passed"
		;;
	C-cross-turn)
		assert_jq \
			'.events[] | select(.type == "state" and .state == "IN_REVIEW" and .taskId == "42" and .turn == 1)' \
			"expected turn 1 to reach IN_REVIEW for task 42"
		assert_jq \
			'.events[] | select(.type == "session_start" and .reason == "reload" and .restoredState == "IN_REVIEW" and .taskId == "42")' \
			"expected reload to restore IN_REVIEW state"
		assert_jq \
			'.events[] | select(.type == "context" and (.systemPromptContains | contains("Task: #42")))' \
			"expected injected context to include task 42"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "write" and .blocked == false and .turn == 2)' \
			"expected turn 2 write allowed from restored state"
		pass "all assertions passed"
		;;
	D-credential-leak)
		assert_jq \
			'.events[] | select(.type == "block" and .tool == "bash" and (.reason | contains("Credential detected")))' \
			"expected credential-bearing post to be blocked"
		assert_jq \
			'([.events[] | select(.type == "tool_call" and .tool == "bash" and .blocked == false and (.command | contains("sk-")))] | length) == 0' \
			"expected no allowed bash call containing credential"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "bash" and .blocked == false and (.command | contains("credential redacted")))' \
			"expected redacted retry to be allowed"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "DONE" and .replyTarget.channel == "ops")' \
			"expected final post to ops"
		pass "all assertions passed"
		;;
	E-chained-command)
		assert_jq \
			'.events[] | select(.type == "block" and .tool == "bash" and (.reason | contains("Multiple raft commands")))' \
			"expected chained raft command to be blocked"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "bash" and .command == "raft msg read" and .blocked == false)' \
			"expected split msg read to be allowed"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "MESSAGES_READ")' \
			"expected transition to MESSAGES_READ"
		assert_jq \
			'.events[] | select(.type == "tool_call" and .tool == "bash" and .command == "raft task claim 42" and .blocked == false)' \
			"expected split task claim to be allowed"
		assert_jq \
			'.events[] | select(.type == "state" and .state == "TASK_CLAIMED" and .taskId == "42")' \
			"expected transition to TASK_CLAIMED"
		pass "all assertions passed"
		;;
	*)
		fail "scenario is not implemented: $scenario"
		;;
esac
