# Spike: a Cloudflare backend for the assessment sandbox

- Status: Planned. The adapter skeleton is merged behind a flag that is off. Nothing has run on a
  real account.
- Issue: SCHO-102 (follow-up of SCHO-21).
- Verifies: the "Cloudflare Sandbox SDK / Containers" column of
  [assessment-sandbox.md](../assessment-sandbox.md).
- Code:
  - `packages/schoolos-assessment-ai/src/cloudflare-sandbox.ts`: `createCloudflareSandbox`, behind
    `SCHOOLOS_ASSESSMENT_SANDBOX_CLOUDFLARE`.
  - `assessmentPlanFromPack` in `src/profiles.ts`.

## What changed since assessment-sandbox.md was written

Research on 2026-10-21 against Cloudflare's docs:

- **Containers and the Sandbox SDK are generally available**, since 2026-04-13, on Workers Paid only.
  <https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/>
- **Sandbox SDK 1.0 is out** (announced 2026-09-30) and changes the model.
  <https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/>
  - You write your own Durable Object class and drive `this.ctx.container` directly.
  - `getSandbox()`, `exec(cmd, { timeout })`, sessions, `runCode` and `keepAlive` are the 0.x API.
    0.x gets fixes only until 2026-12-31.
  - The API map from 0.x to 1.0 is at
    <https://developers.cloudflare.com/sandbox/sdk/migrate/api-map/>.
  - The 1.0 container API is at
    <https://developers.cloudflare.com/containers/api/durable-object-container/>:
    - `start({ image, entrypoint, enableInternet, env, instance })`
    - `exec(cmd: string[], { cwd, env, signal })`, which returns a process whose `output()` gives
      `{ stdout, stderr, exitCode }`
    - `destroy()`, `setInactivityTimeout(ms)`
    - outbound interception: `interceptOutboundHttp`, `interceptAllOutboundHttp` and
      `interceptOutboundHttps`
  - **There is no per-command timeout in 1.0.** It is enforced with an `AbortSignal`, or GNU
    `timeout` in the image.
  - The `durable_object` scheduling policy that 1.0 builds on is still in **public beta**.
- **Isolation.** Each container is "a Firecracker microVM with its own kernel and network", and
  "the sandbox is therefore the smallest unit of trust": one per job.
  <https://developers.cloudflare.com/sandbox/concepts/> and
  <https://developers.cloudflare.com/sandbox/concepts/security/>
- **Egress.** With `enableInternet: false`, only intercepted hosts are reachable. Interception
  covers ports 80 and 443, and other ports are denied.
  <https://developers.cloudflare.com/containers/configuration/outbound-traffic/>
  - The docs disagree about the default. The outbound page says containers allow internet by
    default; the Sandbox security page says `enableInternet: false`.
  - The field is mandatory in `start()`, so the runner always sets it.
- **Instance types**
  (<https://developers.cloudflare.com/containers/platform-details/limits/>):

  | Type | vCPU | Memory |
  | --- | --- | --- |
  | `lite` | 1/16 | 256 MiB |
  | `basic` | 1/4 | 1 GiB |
  | `standard-1` | 1/2 | 4 GiB |
  | `standard-2` | 1 | 6 GiB |
  | `standard-3` | 2 | 8 GiB |
  | `standard-4` | 4 | 12 GiB |

  The account-wide cap is 1,500 concurrent vCPU.
- **Price** (<https://developers.cloudflare.com/containers/pricing/>):
  - $0.000020 per active vCPU-second
  - $0.0000025 per provisioned GiB-second
  - disk and egress are extra
  - billed per 10 ms
- **Cold start.** Cloudflare reports a median of 648 ms and a p99 of 1,129 ms.
  <https://blog.cloudflare.com/faster-agent-sandboxes>
- **Data location.** Region and jurisdiction placement exists
  (<https://developers.cloudflare.com/containers/concepts/placement/>). The docs don't say whether it
  applies under the `durable_object` policy.
- **Not suitable as an alternative.** Dynamic Workers (Worker Loader) run JS, Python and Wasm in an
  isolate, with `globalOutbound: null` to block the network and `limits: { cpuMs }` for real CPU
  limits (<https://developers.cloudflare.com/dynamic-workers/api-reference/>,
  <https://developers.cloudflare.com/dynamic-workers/usage/limits/>). But they have no processes and
  no native modules, so they can't run a Python test runner. They stay out of scope here.

## Design under test

```
AssessmentAi ──ExecutionSandbox──▶ createCloudflareSandbox (adapter, in the district backend)
                                        │  POST RunnerJobRequest (service binding)
                                        ▼
                             sandbox-runner Worker (district account)
                                        │  getByName(jobId)
                                        ▼
                             JobContainer Durable Object ──ctx.container──▶ Firecracker VM
```

**The adapter decides; the runner carries out.** This is already built and tested against a fake
runner in `__tests__/cloudflare-sandbox.test.ts`. For each job, the adapter:

1. Picks the smallest instance type with at least `memoryMb`, and refuses if none has it.
2. **Bounds wall-clock time** at `min(cpuMs / vcpu, remaining cost / price per second)`. Containers
   don't meter CPU per command, but a job can't use more than `vcpu` CPU-seconds per wall-clock
   second. So the wall-clock bound is a sound upper bound on CPU time. It also keeps the job inside
   the run's remaining budget at list prices.
3. **Refuses a job the remaining budget can't cover** without sending it.
4. **Derives the result from what the runner reports:**
   - `cpuMs` and `costCents` come from the reported wall-clock time and are capped at the limits;
   - a runner that reports running past its bound gets a limit result;
   - output over `maxOutputBytes` gets an `output` limit;
   - an answer with unknown fields throws, so the job is retried;
   - none of the runner's text is passed on.
5. **Passes the egress rule through.** The runner applies it with `enableInternet: false`, plus
   `interceptOutboundHttps` for each allowlisted host.

The runner Worker isn't written yet, and writing it is the spike's main work. It:

- authenticates the backend through the service binding, and is never public;
- names the Durable Object by `jobId`, so a retry of the same job reaches the same object and isn't
  run twice;
- writes the files into the container;
- runs the entrypoint with `exec([...])` under an `AbortSignal` at `wallClockMs`;
- counts output bytes as they stream, and aborts past `maxOutputBytes`;
- parses the test report the image's harness writes;
- answers with a `RunnerJobResponse`;
- and calls `destroy()` in `finally`.

## Spike steps

Use one sandbox Cloudflare account on Workers Paid, and never a district's. Each step's result is a
row in the results table below.

1. **The image.** Build `python-3` and `node-22` images. Each is FROM a pinned
   `docker.io/cloudflare/sandbox:<1.0.x>` with the `sandbox-shim` copied in
   (<https://developers.cloudflare.com/sandbox/reference/>), plus a small test harness that writes
   `{ tests: [{ name, passed }] }` to a fixed path. Record the image size and the push time.
2. **The runner.** Write the runner Worker and the `JobContainer` class
   (<https://developers.cloudflare.com/sandbox/get-started/>), with `scheduling_policy:
   "durable_object"`. Deploy it to the sandbox account with `wrangler deploy`.
3. **Isolation.** Run two jobs at once that each write `/tmp/marker` and then read it. Each must see
   only its own. After `destroy()`, a job under the same name must start with an empty filesystem.
4. **Egress, `none`.** A job that calls `https://example.com`, a raw TCP connection on port 22, and
   a DNS lookup must fail all three. Record the docs' default disagreement as observed.
5. **Egress, allowlist.** With `data.example` intercepted, a request to it succeeds and one to any
   other host fails.
6. **Wall clock.** `while True: pass` with `wallClockMs: 2000` must be killed within 2 s plus a
   measured margin. Record the margin and the reported `wallMs`.
7. **Memory.** A job that allocates past the instance's memory is killed. Record how the runner sees
   it: the exit code, and any `monitor()` error. This settles how `limit: memory` is detected.
8. **Output.** A job that writes 10 MiB with `maxOutputBytes: 4096` is aborted with
   `limit: output`, and the runner reads no more than about 4 KiB plus one chunk.
9. **Cost.** Run 100 typical jobs (a 2-second pytest run on `lite`). Compare the adapter's
   `costCents` with the account's Containers billing for the hour. This sets whether
   `CONTAINER_LIST_PRICING` needs a margin for disk and the Durable Object's own cost.
10. **Cold start and throughput.** Measure p50 and p99 from `run()` to the answer, both cold and
    with a snapshot. Record the account's concurrent-instance ceiling as observed.
11. **Placement.** Set `constraints: { jurisdiction: "us" }` and check whether it is honoured under
    the `durable_object` policy.
12. **Read the plan from the pack.** Wire `assessmentPlanFromPack(manifest, provisioned)` into the
    district app. `manifest` is the `assessment-ci` pack's manifest in
    `packages/schoolos-config/src/packs.ts`. `provisioned` comes from the installer's record of the
    optional resources it created. The district app then stops passing `plan` by hand. This is the
    second follow-up in assessment-sandbox.md.

## What the spike changes, depending on the results

| Result | Change |
| --- | --- |
| Steps 3-8 pass | Update the Containers column of assessment-sandbox.md from **unverified** to verified, and enable the flag for the pilot district only. |
| The egress-`none` step fails | The Containers backend can't satisfy `egress: none`. The flag stays off, and the doc says so. Look at the Artifacts CI column instead. |
| Memory isn't detectable | Map an unexplained kill to `limit: memory` only when the exit code is 137. Document the ambiguity. |
| Cost is more than 20% above the estimate | Add a measured multiplier to `ContainerPricing`, and reconcile against the bill as AI governance does (G01). |
| Placement isn't honoured | Record it in the district data-location notes. A district that needs placement doesn't get the sandbox. |

## Results

Fill in during the spike, with the date and the account's plan.

| Step | Observed | Pass |
| --- | --- | --- |
| 1 image | | |
| 2 runner | | |
| 3 isolation | | |
| 4 egress none | | |
| 5 egress allowlist | | |
| 6 wall clock | | |
| 7 memory | | |
| 8 output | | |
| 9 cost | | |
| 10 cold start | | |
| 11 placement | | |
| 12 plan from pack | | |
