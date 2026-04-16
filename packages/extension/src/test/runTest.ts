import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

/**
 * Entry point for `@vscode/test-electron`.
 *
 * Downloads a VSCode binary (cached in `.vscode-test/`), launches it
 * with our extension pre-loaded, and tells the runner where to find
 * the compiled Mocha suite (`./suite/index.js`). The sample Foundry
 * project at `test/fixtures/sample-project/` is opened as the
 * workspace so the extension's activation events fire.
 */
async function main(): Promise<void> {
  try {
    // The extension's `package.json` / `dist/` live two levels up
    // from `dist/test/runTest.js`.
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");

    // Suite index lives next to this file after compilation.
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Sample Foundry project at repo root.
    const workspacePath = path.resolve(
      extensionDevelopmentPath,
      "..",
      "..",
      "test",
      "fixtures",
      "sample-project",
    );

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        // Disable other workspace extensions to keep the test deterministic.
        "--disable-extensions",
      ],
    });
  } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();
