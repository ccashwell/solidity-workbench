import * as path from "node:path";
import Mocha from "mocha";
import { glob } from "glob";

/**
 * Mocha suite driver run *inside* the VSCode extension host by
 * `@vscode/test-electron`. Globs every `*.test.js` under this
 * directory and hands them to Mocha.
 *
 * `run()` is the entry point the test runner calls.
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 60_000, // extension activation can be slow on a cold VSCode download
  });

  const testsRoot = path.resolve(__dirname, ".");
  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} tests failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
