# mca.teros.datetime

Date and time utilities MCA with timezone support.

## Description

Pure luxon-based date/time utilities: current clock, format/parse, timezone conversion, duration arithmetic, and validation. All 8 tools are pure functions — no state, no side effects.

## Architecture

- `src/index.ts` — entrypoint. `McaServer` from `@teros/mca-sdk` auto-detects transport:
  - `MCA_TRANSPORT=http` (container runtime, port from `MCA_HTTP_PORT`/`PORT`)
  - `MCA_TRANSPORT=stdio` (tool discovery via `scripts/generate-mca-tools.ts`)
- `src/tools/*.ts` — one file per tool, each a `ToolConfig` (description, parameters, annotations, handler)
- `src/tools/index.ts` — `TOOL_REGISTRY`, the ordered single source of truth for server registration and tests
- `test/unit/_dispatcher.ts` — test dispatcher mirroring the SDK's error contract

> History (v0.9.1): migrated from a raw `StdioServerTransport` server whose manifest
> declared `transport: http` — the container never got a listening port and the
> health check killed it after 60s.

## Tools (8)

- `get-current` - Get current date/time (timezone-aware)
- `format` - Format date/time strings
- `parse` - Parse date/time strings
- `convert-timezone` - Convert between timezones
- `add` - Add duration to date/time
- `subtract` - Subtract duration from date/time
- `diff` - Calculate difference between dates
- `is-valid` - Validate date/time strings

All 8 tools are annotated `readOnlyHint: true` (pure functions — they never mutate anything).

## Type

System MCA - shared time utilities.

## Configuration

No credentials required. Uses Luxon for date/time operations.
