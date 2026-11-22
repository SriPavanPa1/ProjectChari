export function normalizeRecordId(id) {
  return String(id ?? "")
    .trim()
    .toLocaleLowerCase();
}

export function mergeRecordsById(existingRecords, incomingRecords) {
  const knownIds = new Set(existingRecords.map((record) => normalizeRecordId(record.id)));
  const addedRecords = [];
  const duplicateIds = [];

  for (const record of incomingRecords) {
    const id = normalizeRecordId(record.id);
    if (!id || knownIds.has(id)) {
      if (id) duplicateIds.push(String(record.id).trim());
      continue;
    }

    knownIds.add(id);
    addedRecords.push(record);
  }

  return { addedRecords, duplicateIds };
}
