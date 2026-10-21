import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import TimeoutFloorReporter, {
  VITEST_HOOK_TIMEOUT,
  VITEST_TEST_TIMEOUT,
  parseTimeoutFloors,
  raiseTimeouts,
  withTimeoutFloorReporter,
} from "./vitest-timeout-floor.ts";

// Run from the repo root, like the sibling suites (see scripts/vite.config.ts).
const WITH_TIMEOUT = "scripts/with-timeout.ts";

/** The `--reporter=` argument naming the floor module, wherever this checkout lives. */
const FLOOR_REPORTER = /^--reporter=.*[/\\]vitest-timeout-floor\.ts$/;

/** Runs `body` with the floor variables set to exactly `values`, restoring them afterwards. */
function withFloorEnv(values: Record<string, string>, body: () => void): void {
  const names = [VITEST_TEST_TIMEOUT, VITEST_HOOK_TIMEOUT];
  const saved = names.map(name => process.env[name]);
  for (const name of names) {
    if (name in values) process.env[name] = values[name];
    else delete process.env[name];
  }
  try {
    body();
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}

/** Runs `with-timeout.ts` over a trivial command with `env` added, and reports how it exited. */
function runWrapper(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [WITH_TIMEOUT, "--idle", "30", "--max", "30", "--", "node", "-e", "process.exit(0)"],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stderr }));
  });
}

describe("parseTimeoutFloors", () => {
  it("leaves both timeouts alone when neither variable is set", () => {
    assert.deepEqual(parseTimeoutFloors({}), { testTimeout: undefined, hookTimeout: undefined });
  });

  it("reads milliseconds", () => {
    assert.deepEqual(
      parseTimeoutFloors({ testTimeout: "60000", hookTimeout: "90000" }),
      { testTimeout: 60_000, hookTimeout: 90_000 });
  });

  it("rejects anything but a positive, finite number", () => {
    for (const value of ["0", "-1", "", " ", "nope", "Infinity", "NaN"]) {
      assert.throws(() => parseTimeoutFloors({ testTimeout: value }),
        new RegExp(`${VITEST_TEST_TIMEOUT} needs a positive number of milliseconds`));
      assert.throws(() => parseTimeoutFloors({ hookTimeout: value }),
        new RegExp(`${VITEST_HOOK_TIMEOUT} needs a positive number of milliseconds`));
    }
  });
});

describe("raiseTimeouts", () => {
  it("raises a timeout below the floor", () => {
    const config = { testTimeout: 5_000, hookTimeout: 10_000 };
    raiseTimeouts(config, { testTimeout: 60_000, hookTimeout: 60_000 });
    assert.deepEqual(config, { testTimeout: 60_000, hookTimeout: 60_000 });
  });

  // The rule the floor exists to keep: integration-tests sets 120 s, and must keep it in CI.
  it("never lowers a timeout a config set higher", () => {
    const config = { testTimeout: 120_000, hookTimeout: 120_000 };
    raiseTimeouts(config, { testTimeout: 60_000, hookTimeout: 60_000 });
    assert.deepEqual(config, { testTimeout: 120_000, hookTimeout: 120_000 });
  });

  it("touches only the timeouts that have a floor", () => {
    const config = { testTimeout: 5_000, hookTimeout: 10_000 };
    raiseTimeouts(config, { testTimeout: 60_000 });
    assert.deepEqual(config, { testTimeout: 60_000, hookTimeout: 10_000 });
  });
});

describe("the reporter", () => {
  it("raises every project, each against its own config", () => {
    const projects = [
      { config: { testTimeout: 5_000, hookTimeout: 10_000 } },
      { config: { testTimeout: 120_000, hookTimeout: 120_000 } },
    ];
    withFloorEnv({ [VITEST_TEST_TIMEOUT]: "60000" }, () => {
      new TimeoutFloorReporter().onInit({ projects });
    });
    assert.deepEqual(projects.map(project => project.config), [
      { testTimeout: 60_000, hookTimeout: 10_000 },
      { testTimeout: 120_000, hookTimeout: 120_000 },
    ]);
  });
});

describe("withTimeoutFloorReporter", () => {
  const floors = { testTimeout: 60_000 };

  it("leaves every command as written when no floor is set", () => {
    const argv = ["vitest", "run", "--reporter=default"];
    assert.equal(withTimeoutFloorReporter(argv, {}), argv);
  });

  it("leaves a command other than vitest as written", () => {
    const argv = ["node", "--test", "scripts/**/*.test.ts"];
    assert.equal(withTimeoutFloorReporter(argv, floors), argv);
  });

  it("adds the floor reporter alongside the reporter a command names", () => {
    for (const named of [["--reporter=default"], ["--reporter", "verbose"], ["--reporters=dot"]]) {
      const result = withTimeoutFloorReporter(["vitest", "run", ...named], floors);
      assert.deepEqual(result.slice(0, -1), ["vitest", "run", ...named]);
      assert.match(result.at(-1)!, FLOOR_REPORTER);
    }
  });

  // Otherwise the floor reporter would be vitest's only one, and it prints nothing.
  it("keeps the default reporter for a command that names none", () => {
    const result = withTimeoutFloorReporter(["vitest", "run"], floors);
    assert.deepEqual(result.slice(0, 3), ["vitest", "run", "--reporter=default"]);
    assert.match(result[3], FLOOR_REPORTER);
    assert.equal(result.length, 4);
  });
});

describe("gadgets-with-timeout", () => {
  it("rejects a malformed floor before starting the command", async () => {
    for (const variable of [VITEST_TEST_TIMEOUT, VITEST_HOOK_TIMEOUT]) {
      const { code, stderr } = await runWrapper({ [variable]: "60s" });
      assert.equal(code, 2, variable);
      assert.ok(stderr.includes(`${variable} needs a positive number of milliseconds`), stderr);
    }
  });
});
