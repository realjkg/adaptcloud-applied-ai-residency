import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const jobPattern = /^[1-9][0-9]{0,19}$/;
const digestPattern = /^[a-f0-9]{64}$/;

// dir must already exist on a persistent filesystem supporting hard links and fsync.
export function createCommitJournal(dir) {
  const path = (id, kind) => {
    if (typeof id !== 'string' || !/^OP-[A-F0-9]{10}$/.test(id)) throw new Error('invalid_operation_id');
    return join(dir, `${id}.${kind}.json`);
  };
  async function publish(destination, record) {
    const tmp = join(dir, `.commit-${randomUUID()}.tmp`);
    const file = await open(tmp, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      // Publish without replacing an existing intent: a retry cannot win twice.
      await link(tmp, destination);
      const parent = await open(dir, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(tmp).catch(() => {}); }
  }
  async function read(destination) {
    try { return JSON.parse(await readFile(destination, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return {
    async recordIntent({ id, targetFingerprint, planDigest }) {
      if (!digestPattern.test(targetFingerprint) || !digestPattern.test(planDigest)) throw new Error('invalid_commit_binding');
      await publish(path(id, 'intent'), { targetFingerprint, planDigest });
    },
    async recordJob(id, jobId) {
      if (typeof jobId !== 'string' || !jobPattern.test(jobId)) throw new Error('invalid_job_id');
      const intent = await read(path(id, 'intent'));
      if (!intent) throw new Error('missing_commit_intent');
      await publish(path(id, 'job'), { jobId, binding: binding(intent) });
    },
    async recover({ id, targetFingerprint, planDigest }) {
      const intent = await read(path(id, 'intent'));
      if (!intent) return { state: 'no_intent' };
      if (intent.targetFingerprint !== targetFingerprint || intent.planDigest !== planDigest) throw new Error('commit_binding_changed');
      const job = await read(path(id, 'job'));
      if (!job) return { state: 'submission_uncertain' };
      if (job.binding !== binding(intent) || typeof job.jobId !== 'string' || !jobPattern.test(job.jobId)) throw new Error('invalid_commit_job_record');
      return { state: 'job_known', jobId: job.jobId };
    },
  };
}

function binding({ targetFingerprint, planDigest }) {
  return createHash('sha256').update(`${targetFingerprint}:${planDigest}`).digest('hex');
}
