# Steno Edit v1

Steno Edit v1 is DevFlow's repository-agnostic compact transport for anchored source edits. It reduces repeated path, revision, operation-key, and string payload while preserving the existing `safeEditFileService` as the only semantic matching and write engine.

## Goals

- Work across TypeScript, Kotlin, Python, Go, Markdown, and other text repositories without language-specific source-token dictionaries.
- Keep compact requests readable enough to debug.
- Bind every compact edit to the exact file content that was read.
- Prepare once and apply by a short-lived plan id without resending edit intent.
- Fail closed on stale refs, stale plans, ambiguous anchors, unsupported versions, invalid dictionary refs, symlink escapes, or rollback conflicts.

## Workflow

1. Read every target with `read_local_file` and `includeFileRef=true`.
2. Build one `prepare_compact_edit` request with `v=1`.
3. Optionally add request-local string table `s` for strings repeated inside that request.
4. Put each target in `f` as `[fileRef, operations]`.
5. Inspect the prepared result. No file is written during prepare.
6. Apply with `apply_prepared_edit({ editPlanId })` only.
7. If a fileRef or plan is stale/expired/consumed, re-read and re-prepare. Never replay the same stale intent unchanged.

Legacy `safe_edit_local_file`, `edit_local_files_batch`, and `apply_patch` remain supported fallbacks.

## Wire format

```json
{
  "v": 1,
  "s": [
    "const timeout = 30000",
    "const headers ="
  ],
  "f": [
    [
      "file-ref-...",
      [
        ["R", 0, "const timeout = 60000", 1],
        ["IA", 1, "\nconst retryCount = 3;", 1]
      ]
    ]
  ]
}
```

`v` is required and currently must be `1`.

`s` is optional and request-local. Every entry must be a literal UTF-8 string. There are no nested, recursive, global, repository-specific, or language-specific dictionary references.

`f` is a non-empty array of file tuples. A file tuple is exactly:

```text
[fileRef, operations]
```

A string position inside an operation accepts either a literal UTF-8 string or a non-negative integer index into `s`.

## Operation tuples

| Opcode | Shape | Safe edit mapping |
| --- | --- | --- |
| `R` | `["R", find, replacement, occurrence?]` | `replace` |
| `IB` | `["IB", find, text, occurrence?]` | `insert_before` |
| `IA` | `["IA", find, text, occurrence?]` | `insert_after` |
| `DB` | `["DB", start, end, occurrence?]` | `delete_between` |

`occurrence` is optional. When supplied it is a positive, 1-based integer. Anchor matching, ambiguity handling, newline normalization, payload limits, file-size limits, atomic writes, and revision guards are delegated to the existing safe-edit engine.

## fileRef security model

`fileRef` is an opaque unguessable UUID-backed capability issued only when a caller opts in during `read_local_file`.

Each ref is bound to:

- one DevFlow project identity,
- the canonical real project root,
- the canonical real target path,
- the exact SHA-256 content revision observed at read time,
- a bounded short lifetime.

The registry is in-memory and bounded. Restarting DevFlow invalidates outstanding refs. DevFlow resolves real paths and rejects targets that escape the canonical project root, including symlink escapes. Cross-project reuse is rejected even when a relative path looks identical.

Current ref lifetime defaults to 10 minutes and is capped at 15 minutes. Prepared plans are intentionally shorter lived.

## Prepared-plan lifecycle

Prepared plans have these states:

```text
prepared -> applying -> consumed
```

The default plan TTL is 180 seconds and the maximum is 300 seconds.

Apply behavior:

1. Validate that the plan exists, has not expired, and is still `prepared`.
2. Mark the attempt `applying` so the plan cannot be replayed concurrently.
3. Globally recheck all target revisions before the first write.
4. Immediately before each file write, the existing safe-edit engine rechecks that file revision again.
5. Consume the plan after success or any failed apply attempt.

A failed stale apply is not reusable. Re-read and re-prepare instead.

## Multi-file failure and rollback

If an early file is written and a later file fails:

- rollback proceeds in reverse write order,
- a file is restored only if its current content still exactly equals the content written by this plan,
- a third-party post-write change is preserved and reported as a rollback conflict,
- rollback write exceptions are caught and returned as structured failures,
- successful restores invalidate repository read caches/change-journal state.

Rollback never overwrites content that no longer matches the plan-written value.

## Errors

Important compact-flow errors include:

| Code | Meaning | Caller action |
| --- | --- | --- |
| `EDIT_PROTOCOL_VERSION_UNSUPPORTED` | `v` is not supported | Send `v=1` or use a legacy edit tool |
| `EDIT_DICT_REF_INVALID` | Invalid/negative/out-of-range/non-string `s` reference | Fix the request or send a literal string |
| `EDIT_REF_NOT_FOUND` | Ref was never known, pruned, or lost after restart | Re-read with `includeFileRef=true` |
| `EDIT_REF_EXPIRED` | Ref lifetime elapsed | Re-read and re-prepare |
| `EDIT_REF_PROJECT_MISMATCH` | Ref belongs to another project/root | Re-read in the intended project |
| `EDIT_REF_STALE` | Target path/content changed after read | Re-read and re-prepare |
| `EDIT_PLAN_NOT_FOUND` | Plan does not exist or was lost after restart | Prepare again |
| `EDIT_PLAN_EXPIRED` | Plan TTL elapsed | Re-read/re-prepare |
| `EDIT_PLAN_CONSUMED` | Plan was already attempted | Prepare a new plan |
| `EDIT_PLAN_STALE` | A global pre-apply revision guard failed | Re-read/re-prepare |
| `EDIT_PLAN_APPLY_FAILED` | Per-file apply failed; rollback diagnostics may be present | Inspect result, re-read affected files, prepare again |

Underlying safe-edit errors such as `NO_MATCH`, `AMBIGUOUS_MATCH`, file-size, or payload-limit errors are preserved during prepare instead of being collapsed into a generic compact-protocol error.

## Telemetry and privacy

DevFlow records serialized UTF-8 MCP input byte counts per tool so transport savings can be measured. Aggregates expose count, total input bytes, average input bytes, and maximum input bytes.

The in-memory tool-call telemetry record retains the input hash and numeric metrics, not raw arguments. This means source anchors/replacements are not copied into the telemetry record.

The measurement boundary is the DevFlow MCP entry point. DevFlow cannot measure prompt tokens, ChatGPT-side tool serialization, transport overhead before a request reaches DevFlow, or requests rejected before DevFlow receives them.

## Payload benchmark

Canonical benchmark fixture: five files representing TypeScript, Kotlin, Python, Go, and Markdown, with three repeated anchored replacements per file.

Measured serialized UTF-8 JSON bytes:

| Transport | Prepare | Apply | Total | Relative to Steno + table |
| --- | ---: | ---: | ---: | ---: |
| Unified patch preview + apply | 1,203 | 1,204 | 2,407 | 3.44x |
| Verbose safe-edit resend | 2,192 | 2,207 | 4,399 | 6.28x |
| Existing verbose prepare + plan id | 2,192 | 108 | 2,300 | 3.29x |
| Steno v1, no string table + plan id | 1,103 | 63 | 1,166 | 1.67x |
| Steno v1, request-local string table + plan id | 637 | 63 | 700 | 1.00x |

The benchmark is executable in `tests/server/stenoEditPayloadBenchmark.test.ts`; it calculates both legacy and Steno payloads from the same fixture rather than hard-coding the measured totals.

## Choosing Steno vs legacy tools

Prefer Steno when:

- multiple anchored edits repeat structural JSON fields,
- the same anchors/replacements repeat within one request,
- preview/prepare will be followed by an unchanged apply,
- an agent already has exact target reads and can use file refs.

Prefer legacy tools when:

- it is a tiny one-off edit where compact encoding adds no practical value,
- the caller cannot obtain a fileRef,
- a unified diff is already available and stable,
- an error requires a simpler diagnostic payload.

Do not introduce a global source-code abbreviation dictionary to improve ratios. Steno v1 intentionally compresses universal edit structure and request-local repetition only.
