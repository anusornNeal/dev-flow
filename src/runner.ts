import { pathToFileURL } from 'url';

export const LEGACY_RUNNER_RETIRED_MESSAGE =
  'Legacy fresh-process agent execution is retired. Use DevFlow managed execution or external worker synchronization.';

export function main() {
  console.error(`[runner] ${LEGACY_RUNNER_RETIRED_MESSAGE}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
