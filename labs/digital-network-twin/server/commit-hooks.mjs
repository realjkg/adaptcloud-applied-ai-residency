// These hooks are for the authorized Node-native PAN-OS execution path only.
export function createCommitHooks({ journal, id, targetFingerprint, planDigest }) {
  if (!journal || typeof journal.recordIntent !== 'function' || typeof journal.recordJob !== 'function') {
    throw new TypeError('commit_journal_required');
  }
  let phase = 'new';
  return Object.freeze({
    async beforeCommit() {
      if (phase !== 'new') throw new Error('commit_intent_already_attempted');
      phase = 'recording_intent';
      await journal.recordIntent({ id, targetFingerprint, planDigest });
      phase = 'intent_recorded';
    },
    async onJobQueued(jobId) {
      if (phase !== 'intent_recorded') throw new Error('commit_job_out_of_sequence');
      phase = 'recording_job';
      await journal.recordJob(id, jobId);
      phase = 'job_recorded';
    },
  });
}
