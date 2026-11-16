// Replays the synthetic student-led learning pilot (SCHO-432) and prints what happened.
//
//   pnpm educateos:pilot             print the narrative of every scripted journey
//   pnpm educateos:pilot --json      print the normalized transcript
//   pnpm educateos:pilot --check     fail if the transcript differs from goldens/pilot-journeys.json
//   pnpm educateos:pilot --update    rewrite the golden after reviewing the diff
//
// It boots the real district application in memory with invented people. It calls no model and no
// network, and passing it says nothing about whether a child learned.
import { readFile, writeFile } from "node:fs/promises";
import { replayPilot, type PilotStep } from "./pilot/index.ts";

const GOLDEN = new URL("../goldens/pilot-journeys.json", import.meta.url);
const render = (steps: PilotStep[]) => steps.map((s) => `    ${s.actor.padEnd(8)} ${s.action}: ${JSON.stringify(s.result)}`).join("\n");

async function main(): Promise<void> {
  const transcript = await replayPilot();
  const text = `${JSON.stringify(transcript, null, 2)}\n`;
  if (process.argv.includes("--update")) {
    await writeFile(GOLDEN, text);
    console.log("Golden updated. Review the diff before committing.");
  } else if (process.argv.includes("--check")) {
    if ((await readFile(GOLDEN, "utf8")) !== text) throw new Error("The pilot replay no longer matches goldens/pilot-journeys.json. Review the change, then run with --update.");
    console.log("Pilot replay matches its golden.");
  } else if (process.argv.includes("--json")) {
    process.stdout.write(text);
  } else {
    for (const [key, steps] of Object.entries(transcript.personas)) console.log(`\n${key}\n${render(steps)}`);
    console.log(`\nretention (seven days later)\n${render(transcript.retention)}`);
    console.log(`\nfamily (opt-in, source, boundaries)\n${render(transcript.family)}`);
    console.log(`\nteacher coverage (grade 6 class)\n${transcript.coverage.map((row) => `    ${JSON.stringify(row)}`).join("\n")}`);
    console.log("\nThis replay checks the software's routing and evidence rules. It does not measure learning.");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
