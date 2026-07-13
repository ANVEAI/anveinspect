// Thin dev entrypoint — the server itself lives in the collector package so the
// installed CLI can run it too (`anveinspect dash`). `npm run dash` uses this.
import { startDashboard } from '@anveinspect/collector';

startDashboard();
