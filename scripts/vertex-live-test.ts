// Live integration test: Vertex adapter against real GCP via gcloud auth.
// Token is read at runtime and never printed or persisted.
import { vertexAdapter } from '../packages/adapters/src/index.js';
import { execFileSync } from 'node:child_process';

const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const project = execFileSync('gcloud', ['config', 'get-value', 'project'], { encoding: 'utf8' }).trim();
for (const location of ['us-central1', 'asia-south1']) {
  try {
    const r = await vertexAdapter(
      { projectId: project, location, accessToken: token },
      { fetch: globalThis.fetch, now: () => new Date() },
    );
    console.log(`vertex ${project}/${location}: ${r.agents.length} reasoning-engine agents ${JSON.stringify(r.agents.map((a) => a.displayName))} ${r.warnings.join(' | ')}`);
  } catch (e) {
    console.log(`vertex ${project}/${location}: ${e instanceof Error ? e.message : e}`);
  }
}
