// Test worker for the workerd suite: the runner Worker as it ships, and its job object with a fake
// container in place of `ctx.container`, which workerd cannot provide.

import { SandboxJob, runnerWorker, type JobContainer, type RunnerEnv } from "../../src/index.ts";
import { FakeJobContainer } from "../fake-container.ts";

/** The job object, running jobs in a fake container and counting how many it started. */
export class TestSandboxJob extends SandboxJob {
  /** How many containers this instance started. */
  starts = 0;

  protected override container(): JobContainer {
    const fake = new FakeJobContainer(async (ctx) => {
      // Long enough that a retry arriving at once finds the job still running.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await ctx.write("ok\n");
      ctx.report([{ name: "test_answer", passed: true }]);
      return 0;
    });
    const start = fake.start.bind(fake);
    fake.start = async (options) => {
      this.starts += 1;
      await start(options);
    };
    return fake;
  }
}

export default {
  fetch: (request: Request, env: RunnerEnv) => runnerWorker.fetch(request, env),
};
