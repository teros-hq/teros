/**
 * Migration: Add Blocked column to existing boards
 *
 * Adds a 'Blocked' column (slug: 'blocked', position: 3) between
 * 'In Progress' (position: 2) and 'Review' (position: 4) on all
 * boards that don't already have it.
 *
 * Updates Review → position 4, Done → position 5.
 *
 * Run with:
 *   docker exec teros-mongodb mongosh teros --quiet /path/to/this/script.js
 *
 * Or inline:
 *   docker exec teros-mongodb mongosh teros --quiet --eval "$(cat scripts/migrate-add-blocked-column.js)"
 */

function randomHex(len) {
  let s = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

let updated = 0;
let skipped = 0;

db.boards.find({}).forEach((board) => {
  // Skip boards that already have a blocked column
  const hasBlocked = board.columns.some((c) => c.slug === 'blocked');
  if (hasBlocked) {
    skipped++;
    return;
  }

  const inProgress = board.columns.find((c) => c.slug === 'in_progress');
  const review = board.columns.find((c) => c.slug === 'review');
  const done = board.columns.find((c) => c.slug === 'done');

  if (!inProgress || !review || !done) {
    print('Skipping board', board._id, '- missing expected columns');
    skipped++;
    return;
  }

  // New Blocked column at position 3
  const blockedCol = {
    columnId: 'col_' + randomHex(16),
    name: 'Blocked',
    slug: 'blocked',
    position: 3,
  };

  // Shift Review → 4, Done → 5
  const updatedColumns = board.columns.map((c) => {
    if (c.slug === 'review') return Object.assign({}, c, { position: 4 });
    if (c.slug === 'done') return Object.assign({}, c, { position: 5 });
    return c;
  });

  updatedColumns.push(blockedCol);
  updatedColumns.sort((a, b) => a.position - b.position);

  db.boards.updateOne({ _id: board._id }, { $set: { columns: updatedColumns, updatedAt: new Date() } });

  print('Updated board', board._id, '- added Blocked column:', blockedCol.columnId);
  updated++;
});

print('\nDone! Updated:', updated, 'Skipped:', skipped);
