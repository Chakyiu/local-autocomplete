import { defineConfig } from '@vscode/test-cli';

// Set VSCODE_EXECUTABLE to run against an installed VS Code instead of downloading one, e.g.
// VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm run test:integration
const executable = process.env.VSCODE_EXECUTABLE;

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  ...(executable ? { useInstallation: { fromPath: executable } } : {}),
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 20000 },
});
