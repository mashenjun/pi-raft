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
	*)
		fail "scenario is not implemented in H1: $scenario"
		;;
esac
