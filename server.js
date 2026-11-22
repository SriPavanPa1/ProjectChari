import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mergeRecordsById, normalizeRecordId } from "./src/recordUtils.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const isProduction = process.env.NODE_ENV === "production";
const appPassword = process.env.APP_PASSWORD ?? (isProduction ? "" : "local-dev-password");
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const recordsFile = path.resolve(
  process.env.RECORDS_FILE ?? path.join(projectDirectory, "data", "records.json"),
);
const fields = ["id", "name", "address", "phoneNumber", "comments"];
let writeQueue = Promise.resolve();

class InputError extends Error {}
class RecordsFileError extends Error {}

if (isProduction && appPassword.length < 12) {
  throw new Error("Set APP_PASSWORD to a password with at least 12 characters.");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecord(value) {
  if (!isRecord(value)) {
    throw new InputError("Each record must be a JSON object.");
  }
  const record = Object.fromEntries(
    fields.map((field) => [field, String(value[field] ?? "").trim()]),
  );
  if (!record.id) {
    throw new InputError("Every record must have a non-empty ID.");
  }
  return record;
}

async function readRecords() {
  const content = await fs.readFile(recordsFile, "utf8");
  let records;
  try {
    records = JSON.parse(content);
  } catch {
    throw new RecordsFileError("The records JSON file contains invalid JSON.");
  }
  if (!Array.isArray(records)) {
    throw new RecordsFileError("The records JSON file must contain an array.");
  }
  return records.map((record) => {
    if (!isRecord(record)) {
      throw new RecordsFileError("The records JSON file contains an invalid record.");
    }
    const normalized = Object.fromEntries(
      fields.map((field) => [field, String(record[field] ?? "").trim()]),
    );
    if (!normalized.id) {
      throw new RecordsFileError("The records JSON file contains a record without an ID.");
    }
    return normalized;
  });
}

async function writeRecords(records) {
  const temporaryFile = `${recordsFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await fs.rename(temporaryFile, recordsFile);
}

async function updateRecords(mutator) {
  const operation = writeQueue.then(async () => {
    const records = await readRecords();
    const result = mutator(records);
    if (result.changed) await writeRecords(result.records);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function passwordsMatch(candidate) {
  const expectedBuffer = Buffer.from(appPassword);
  const candidateBuffer = Buffer.from(candidate);
  return (
    expectedBuffer.length === candidateBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

function requireAuthentication(request, response, next) {
  const authorization = request.get("authorization") ?? "";
  const [, candidate = ""] = authorization.match(/^Bearer (.+)$/i) ?? [];
  if (!appPassword || !passwordsMatch(candidate)) {
    response.status(401).json({ error: "Authentication required. Enter the app password." });
    return;
  }
  next();
}

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

app.post("/api/auth", (request, response) => {
  const candidate = typeof request.body?.password === "string" ? request.body.password : "";
  if (!appPassword || !passwordsMatch(candidate)) {
    response.status(401).json({ error: "Incorrect password." });
    return;
  }
  response.json({ authenticated: true });
});

app.use("/api", requireAuthentication);

app.get("/api/records", async (request, response, next) => {
  try {
    response.json({ records: await readRecords() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/records", async (request, response, next) => {
  try {
    const record = normalizeRecord(request.body);
    const result = await updateRecords((records) => {
      if (records.some((existing) => normalizeRecordId(existing.id) === normalizeRecordId(record.id))) {
        return { changed: false, conflict: true };
      }
      return { changed: true, records: [...records, record] };
    });
    if (result.conflict) {
      response.status(409).json({ error: `A record with ID "${record.id}" already exists.` });
      return;
    }
    response.status(201).json({ records: result.records });
  } catch (error) {
    if (error instanceof InputError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/records/import", async (request, response, next) => {
  try {
    if (!Array.isArray(request.body?.records)) {
      response.status(400).json({ error: "Request must include a records array." });
      return;
    }
    const imported = request.body.records.map(normalizeRecord);
    const result = await updateRecords((records) => {
      const { addedRecords, duplicateIds } = mergeRecordsById(records, imported);
      return {
        changed: addedRecords.length > 0,
        records: [...records, ...addedRecords],
        addedRecords,
        duplicateIds,
      };
    });
    response.json({
      addedRecords: result.addedRecords,
      duplicateIds: result.duplicateIds,
      totalRecords: result.records.length,
      records: result.records,
    });
  } catch (error) {
    if (error instanceof InputError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.put("/api/records/:id", async (request, response, next) => {
  try {
    const record = normalizeRecord(request.body);
    const existingId = normalizeRecordId(request.params.id);
    const result = await updateRecords((records) => {
      const index = records.findIndex(
        (existing) => normalizeRecordId(existing.id) === existingId,
      );
      if (index === -1) return { changed: false, notFound: true };
      const duplicate = records.some(
        (existing, recordIndex) =>
          recordIndex !== index &&
          normalizeRecordId(existing.id) === normalizeRecordId(record.id),
      );
      if (duplicate) return { changed: false, conflict: true };
      const updatedRecords = [...records];
      updatedRecords[index] = record;
      return { changed: true, records: updatedRecords };
    });

    if (result.notFound) {
      response.status(404).json({ error: "Record not found." });
      return;
    }
    if (result.conflict) {
      response.status(409).json({ error: `A record with ID "${record.id}" already exists.` });
      return;
    }
    response.json({ records: result.records });
  } catch (error) {
    if (error instanceof InputError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.delete("/api/records/:id", async (request, response, next) => {
  try {
    const id = normalizeRecordId(request.params.id);
    const result = await updateRecords((records) => {
      const updatedRecords = records.filter(
        (record) => normalizeRecordId(record.id) !== id,
      );
      return {
        changed: updatedRecords.length !== records.length,
        notFound: updatedRecords.length === records.length,
        records: updatedRecords,
      };
    });
    if (result.notFound) {
      response.status(404).json({ error: "Record not found." });
      return;
    }
    response.json({ records: result.records });
  } catch (error) {
    next(error);
  }
});

app.use("/api", (request, response) => {
  response.status(404).json({ error: "API endpoint not found." });
});

const distDirectory = path.join(projectDirectory, "dist");
app.use(express.static(distDirectory));
app.get("/{*path}", (request, response, next) => {
  response.sendFile(path.join(distDirectory, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error, request, response, next) => {
  if (error.type === "entity.parse.failed") {
    response.status(400).json({ error: "Request body must contain valid JSON." });
    return;
  }
  if (error.type === "entity.too.large") {
    response.status(413).json({
      error: "Request is too large. Split the import into smaller files.",
    });
    return;
  }
  console.error(error);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).json({ error: "Server error. Check the service logs for details." });
});

async function start() {
  await fs.mkdir(path.dirname(recordsFile), { recursive: true });
  try {
    await fs.access(recordsFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(recordsFile, "[]\n", "utf8");
  }
  await readRecords();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Contact records server listening on port ${port}`);
    console.log(`Records file: ${recordsFile}`);
  });
}

start().catch((error) => {
  console.error("Could not start contact records server:", error);
  process.exitCode = 1;
});
