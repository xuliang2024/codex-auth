# ADR 0001: Keep the Tauri Registry In Process

- Status: Accepted
- Date: 2026-07-11
- Scope: Tauri desktop 0.2.x

## Context

The CLI, Electron app, and Tauri app currently implement overlapping account
registry behavior in Zig, JavaScript, and Rust. The Tauri implementation is
already integrated with OAuth, token refresh, provider endpoint checks, file
watching, import/export, and the native command mutex.

Replacing the Rust implementation with a Zig sidecar would require a new
structured, non-interactive protocol. Tauri also requires one external binary
for each target triple and explicit process permissions. That would expand the
macOS arm64/x64 and Windows x64/arm64 packaging, signing, and failure matrix
after those release paths have already been validated.

The audit also found concrete compatibility risks that must be controlled
regardless of implementation language: future registry schemas must never be
downgraded, snapshot file names must follow one canonical rule, and provider
defaults and managed TOML behavior can drift when changed independently.

## Decision

Keep registry operations inside the Tauri Rust process for desktop 0.2.x. Do
not bundle or execute the general-purpose Zig CLI as a sidecar.

The implementation ownership is:

- Zig defines the canonical on-disk schema, snapshot naming rules, and CLI
  behavior.
- Rust owns the Tauri command boundary and implements only the behavior needed
  by the desktop app while remaining compatible with Zig-managed data.
- The Electron JavaScript port is maintenance-only until Electron is retired.

Sensitive operations remain behind Rust commands. The renderer does not gain
Shell plugin access or a general process-execution capability.

## Compatibility Requirements

1. A reader must reject a `schema_version` newer than it supports and must not
   write any registry or snapshot data after that rejection.
2. Snapshot paths must use the same safe-key-or-base64url naming rule as Zig.
3. Registry writes remain serialized by the native mutex, atomic, private on
   Unix, and backed up before replacement.
4. Changes to the schema version, snapshot naming, provider defaults, managed
   TOML markers, or import/export format must update every active
   implementation and its tests in the same change.
5. Before the next schema version, add shared fixture-driven compatibility
   tests that are consumed by both Zig and Rust.

This decision adds Rust tests for the first two requirements. Existing tests
cover provider configuration, account switching/removal, and import/export.

## Rejected Alternatives

### Persistent Zig sidecar

This would reduce duplicated rules, but it introduces process lifecycle,
framing, cancellation, crash recovery, and secret-bearing IPC concerns. The
CLI does not currently expose the required protocol.

### One Zig process per operation

This avoids a persistent service but cannot make multi-step desktop operations
transactional and would add process startup and error-mapping complexity to
every command.

### Zig library through FFI

This could share code without a child process, but it requires a stable C ABI,
cross-language ownership rules, panic/error boundaries, and a new four-target
build pipeline. It is not a release-stage change.

## Reconsideration Triggers

Revisit this decision if the Zig implementation exposes a versioned structured
API, registry migrations become too complex to port safely, compatibility
defects recur despite contract tests, or the sidecar build/signing matrix is
fully automated and validated.

## References

- [Tauri: Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)
- [Tauri: macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri: Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/)
