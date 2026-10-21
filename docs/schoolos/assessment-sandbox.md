# Assessment CI sandbox

Some checks run student work: a program's unit tests, or a simulator stepping through a lab. Roadmap
§7 makes this optional: executable tests and simulators run through isolated Cloudflare CI with
restricted egress, and SchoolOS must not assume every district's plan includes it.
`@schoolos/assessment-ai` (SCHO-21, roadmap E03) defines the port. It ships no real backend.

## What exists now

- `ExecutionSandbox` is the port. `availability()` reports whether the sandbox can run jobs at all,
  and `run(job)` runs one check's job and reports `completed`, `limit-exceeded` or `unavailable`.
  Results are untrusted. The run engine parses them strictly, and it refuses a result that reports
  more CPU time or cost than the profile allows.
- `unavailableSandbox()` is the default. It runs nothing and gives a reason.
- `FakeExecutionSandbox` is for tests. It enforces every limit below against scripted programs.
- `DistrictAssessmentPlan.sandbox` records whether the district's plan includes the sandbox. A
  sandboxed run fails closed with `sandbox-unavailable` unless the plan says `available` **and**
  the configured sandbox reports itself available. No job is sent in any other case.
- Only a teacher acting directly in SchoolOS configures and starts sandboxed checks. Each check is
  `student-visible` or `teacher-only`. Program output never goes into evidence: a check reports only
  its exit code, its test names and results, and the limit it reached, if any.

## `CiSandboxProfile`

A sandbox execution profile (`kind: "sandbox"`) holds one `CiSandboxProfile`. Every limit is the
sandbox's to enforce. The code under test cannot raise any of them.

| Field | Meaning | Fake enforcement |
| --- | --- | --- |
| `runtime` | `python-3` or `node-22`: the image the job runs in. | Not modelled. Programs are scripted. |
| `cpuMs` | CPU time for the whole job. | `limit-exceeded: cpu` once exceeded. |
| `memoryMb` | Peak memory. | `limit-exceeded: memory` once exceeded. |
| `maxOutputBytes` | stdout and stderr together. | `limit-exceeded: output` once exceeded. |
| `egress` | `none`, or an allowlist of host names. | Any other connection is `limit-exceeded: network`. |
| `maxCostUsdNano` | The most one run may spend, across all its checks, in nanodollars. | Each job gets what is left. It is stopped with `limit-exceeded: cost` before spending more. |

`SandboxExecutionProfile.maxRetries` bounds retries after transient failures, where the sandbox
throws instead of reporting. A retried job keeps its `jobId` (`<runId>:<checkId>`), so a backend
can deduplicate it.

## Mapping to Cloudflare

**Every capability in this table is unverified.** Nobody has built or measured these mappings. They
are the starting point for the spike that chooses a backend, and each needs confirming against the
current Cloudflare documentation and a real account before it is relied on.

| Profile field | Cloudflare Sandbox SDK / Containers (unverified) | Artifacts CI, build on push (unverified) |
| --- | --- | --- |
| Isolation | One sandbox (a container behind a Durable Object) per job. It is destroyed after the job, and no state is shared between submissions. | One build per push to an Artifacts repository holding the submission and the teacher's tests. |
| `runtime` | Choose the container image per runtime. | Choose the build image or toolchain in the build config. |
| `cpuMs` | Choose the instance type, plus a wall-clock timeout on the exec call. CPU time itself may not be metered, so a wall-clock bound may be the only enforceable limit. | Build timeout. Granularity and minimum are unknown. |
| `memoryMb` | Instance type memory. The job is killed above it. | Build machine size, if configurable. |
| `maxOutputBytes` | Truncate the exec stream on the Worker side. | Truncate the build log on retrieval. |
| `egress: none` | Disable outbound networking for the container, if supported. Otherwise route all egress through a Worker that denies it. | Unknown whether build egress can be disabled. |
| `egress: allowlist` | An outbound Worker proxy that allows only the listed hosts. | Unknown. |
| `maxCostUsdNano` | Estimate from instance-seconds before the job, then stop the job when the estimate reaches the remaining budget. Reconcile against the bill later, as AI governance does (G01). | Estimate from build minutes. Reconcile against the bill. |
| Availability | Containers on the district's account and plan. | Artifacts and its CI on the district's account and plan. |

Whichever backend is chosen, these rules from this package still apply:

- Answer keys and hidden tests stay teacher-side. They are never copied into a student's workspace
  or into an Artifacts repository the student can read (threat T8).
- Student work is untrusted code. It never receives district secrets, bindings or tokens, and it
  reaches the network only through the profile's egress rule (threats T7 and T10 bound what its
  results can do: evidence only, never a grade).
- The backend reports the limits it actually enforced. The engine refuses a result beyond them.

## Follow-ups

[spikes/assessment-sandbox-cloudflare.md](spikes/assessment-sandbox-cloudflare.md) (SCHO-102) plans
both, against the Sandbox SDK 1.0 and Containers docs as of 2026-10-21. A flagged-off adapter
(`createCloudflareSandbox`) and `assessmentPlanFromPack` are already in `@schoolos/assessment-ai`.

- A backend spike that verifies one column of the mapping above and implements `ExecutionSandbox`
  against it.
- Read the district plan from the installed capability pack's optional resources (roadmap §4,
  `optionalResources`) rather than from a constructor option.
