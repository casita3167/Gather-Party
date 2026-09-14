// Calendar months in Asia/Taipei (UTC+8), clamping month-end dates.
function expiresAt(milliseconds) {
  const shifted = new Date(milliseconds + 8 * 3600000);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + 3);
  const end = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, end));
  return shifted.getTime() - 8 * 3600000;
}
function latestActivity(data) {
  return Math.max(...["lastOpenedAt","retentionStartedAt","updatedAt","createdAt"].map(k => data[k]?.toMillis?.() || 0));
}
module.exports = { expiresAt, latestActivity };
