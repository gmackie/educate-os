// The `launch-educate-os` executable: the CLI over this process's streams and environment.
import { main } from "./cli.ts";

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
// The prompter pauses stdin when it is done, so nothing keeps the process alive past here.
