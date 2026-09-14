const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { expiresAt, latestActivity } = require("./policy");
initializeApp();
const db = getFirestore();

exports.deleteInactiveQuickSchedules = onSchedule({
  schedule: "0 4 * * *", timeZone: "Asia/Taipei",
  region: "asia-east1", timeoutSeconds: 540, maxInstances: 1, retryCount: 3
}, async () => {
  const started = Date.now();
  let cursor;
  while (Date.now() - started < 420000) {
    let query = db.collection("quickSchedules").orderBy(FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const candidate of page.docs) {
      const ref = candidate.ref;
      const remove = await db.runTransaction(async transaction => {
        const current = await transaction.get(ref);
        if (!current.exists) return false;
        const data = current.data();
        // Continue a previously interrupted cleanup; all client writes are blocked.
        if (data.retentionDeleting === true) return true;
        // No historical read timestamps exist: grant old forms three full months.
        if (!data.retentionStartedAt) {
          transaction.update(ref, { retentionStartedAt: FieldValue.serverTimestamp() });
          return false;
        }
        if (Date.now() < expiresAt(latestActivity(data))) return false;
        // A concurrent visit updates this document and forces this transaction to retry.
        transaction.update(ref, { retentionDeleting: true });
        return true;
      });
      if (remove) {
        // Keep the locked parent until every nested collection is removed.
        for (const collection of await ref.listCollections()) await db.recursiveDelete(collection);
        await ref.delete();
      }
    }
    cursor = page.docs.at(-1);
  }
});
