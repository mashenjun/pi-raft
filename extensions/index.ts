import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-raft extension entry point.
 *
 * Scaffold — no-op in this phase. Group B/C/D/E tasks will wire
 * raft-parser, state-machine, credential-scanner, and context-builder
 * into the hooks registered here.
 */
export default function (pi: ExtensionAPI): void {
  // Group C: tool_call hook — parse + validate raft commands
  // Group D: session_start hook — recover state from session entries
  // Group E: before_agent_start hook — inject slock context
}
