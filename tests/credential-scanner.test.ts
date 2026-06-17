import { describe, it, expect } from "vitest";
import { scanCredentials } from "../extensions/credential-scanner";

describe("scanCredentials — true positives", () => {
  it("detects key=value credential assignment", () => {
    expect(scanCredentials("token=abc123def456")).toBeTruthy();
    expect(scanCredentials("password: mypass123")).toBeTruthy();
    expect(scanCredentials("API_KEY=dGVzdC1rZXk")).toBeTruthy();
  });

  it("detects slock_secret prefix (F2)", () => {
    expect(scanCredentials("slock_secret_abc123")).toBeTruthy();
    expect(scanCredentials("slock_secret_8a9b0c1d")).toBeTruthy();
  });

  it("detects sk- API keys (F2)", () => {
    expect(scanCredentials("sk-test-deadbeef1234567890abcdef")).toBeTruthy();
    expect(scanCredentials("sk-proj-00000000000000000000000000000000")).toBeTruthy();
  });

  it("detects GitHub tokens", () => {
    expect(scanCredentials("ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0")).toBeTruthy();
  });

  it("detects AWS access keys", () => {
    expect(scanCredentials("AKIAIOSFODNN7EXAMPLE")).toBeTruthy();
  });

  it("detects credentials in raft message post command", () => {
    const cmd = 'raft msg post --channel ops "token: sk-test-deadbeef"';
    expect(scanCredentials(cmd)).toBeTruthy();
  });

  it("detects credentials in heredoc-style message", () => {
    const cmd = `raft message send --target "#pi-raft" <<'MSG'
Here is the key: API_KEY=sk-proj-secret
MSG`;
    expect(scanCredentials(cmd)).toBeTruthy();
  });

  it("detects slock_secret in message content (F2 real-world)", () => {
    const msg = "The deployment config uses slock_secret_abc123 for auth";
    expect(scanCredentials(msg)).toBeTruthy();
  });
});

describe("scanCredentials — false negatives (should NOT match)", () => {
  it("does not flag normal words", () => {
    expect(scanCredentials("hello world")).toBeNull();
  });

  it("does not flag raft commands without credentials", () => {
    expect(scanCredentials("raft msg read --channel general")).toBeNull();
    expect(scanCredentials("raft task claim 42")).toBeNull();
  });

  it("does not flag git commit hashes (40 hex chars)", () => {
    // 40 hex chars — could match base64 pattern, but only if mixed case or +/=
    const hexOnly = "abcdef0123456789abcdef0123456789abcdef01";
    expect(scanCredentials(hexOnly)).toBeNull();
  });

  it("does not flag short random strings", () => {
    expect(scanCredentials("abc123")).toBeNull();
  });

  it("does not flag token in code comments without value", () => {
    expect(scanCredentials("// TODO: pass token here")).toBeNull();
  });
});

describe("scanCredentials — extra patterns", () => {
  it("merges user-provided patterns with defaults", () => {
    const extra = [/\bmy_custom_key_[A-Z0-9]{8,}\b/g];
    expect(scanCredentials("use my_custom_key_ABCD1234", extra)).toBeTruthy();
    expect(scanCredentials("sk-test-abcdefghijklmnopqrstuvwxyz", extra)).toBeTruthy();
  });
});
