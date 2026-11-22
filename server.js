import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { normalizeRecordId } from "./src/recordUtils.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const isProduction = process.env.NODE_ENV === "production";
const appPassword = process.env.APP_PASSWORD ?? (isProduction ? "" : "local-dev-password");
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const databaseFields = ["id", "name", "address", "phone_number", "comments"];

class InputError extends Error {}
class DuplicateRecordError extends Error {}
class StorageError extends Error {}

if (isProduction && appPassword.length < 12) {
  throw new Error("Set APP_PASSWORD to a password with at least 12 characters.");
}
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the server.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecord(value) {
  if (!isRecord(value)) {
    throw new InputError("Each record must be a JSON object.");
  }
  const record = {
    id: String(value.id ?? "").trim(),
    name: String(value.name ?? "").trim(),
    address: String(value.address ?? "").trim(),
    phoneNumber: String(value.phoneNumber ?? "").trim(),
    comments: String(value.comments ?? "").trim(),
  };
  if (!record.id) {
    throw new InputError("Every record must have a non-empty ID.");
  }
  return record;
}

function toDatabaseRecord(record) {
  return {
    id: record.id,
    name: record.name,
    address: record.address,
    phone_number: record.phoneNumber,
    comments: record.comments,
  };
}

function fromDatabaseRecord(record) {
  return {
    id: record.id,
    name: record.name,
    address: record.address,
    phoneNumber: record.phone_number,
    comments: record.comments,
  };
}

function throwStorageError(error) {
  if (error.code === "23505") {
    throw new DuplicateRecordError("A record with that ID already exists.");
  }
  if (error.code === "PGRST202" || error.code === "42883") {
    throw new StorageError(
      "The import_contact_records database function is missing. Run supabase/schema.sql in the Supabase SQL Editor.",
    );
  }
  if (error.code === "42P01" || error.code === "PGRST205") {
    throw new StorageError(
      "The contact_records table is missing. Run supabase/schema.sql in the Supabase SQL Editor.",
    );
  }
  console.error("Supabase request failed:", error.message);
  throw new StorageError("Could not access Supabase. Check the service logs and Supabase configuration.");
}

async function readRecords() {
  const pageSize = 1000;
  const records = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("contact_records")
      .select(databaseFields.join(","))
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throwStorageError(error);
    records.push(...data.map(fromDatabaseRecord));
    if (data.length < pageSize) return records;
  }
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
    const { data, error } = await supabase
      .from("contact_records")
      .insert(toDatabaseRecord(record))
      .select(databaseFields.join(","))
      .single();
    if (error) throwStorageError(error);
    response.status(201).json({ records: await readRecords(), record: fromDatabaseRecord(data) });
  } catch (error) {
    if (error instanceof DuplicateRecordError) {
      response.status(409).json({ error: error.message });
      return;
    }
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
    const records = request.body.records.map((record) =>
      toDatabaseRecord(normalizeRecord(record)),
    );
    const { data, error } = await supabase.rpc("import_contact_records", {
      input_records: records,
    });
    if (error) throwStorageError(error);
    const result = data[0] ?? { added_records: [], duplicate_ids: [] };
    const addedRecords = result.added_records ?? [];
    const duplicateIds = result.duplicate_ids ?? [];
    const updatedRecords = await readRecords();
    response.json({
      addedRecords,
      duplicateIds,
      totalRecords: updatedRecords.length,
      records: updatedRecords,
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
    const { data: existing, error: findError } = await supabase
      .from("contact_records")
      .select("id")
      .eq("id", request.params.id)
      .maybeSingle();
    if (findError) throwStorageError(findError);
    if (!existing) {
      response.status(404).json({ error: "Record not found." });
      return;
    }

    const { data, error } = await supabase
      .from("contact_records")
      .update(toDatabaseRecord(record))
      .eq("id", request.params.id)
      .select(databaseFields.join(","))
      .single();
    if (error) throwStorageError(error);
    response.json({ records: await readRecords(), record: fromDatabaseRecord(data) });
  } catch (error) {
    if (error instanceof DuplicateRecordError) {
      response.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof InputError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.delete("/api/records/:id", async (request, response, next) => {
  try {
    const { data, error } = await supabase
      .from("contact_records")
      .delete()
      .eq("id", request.params.id)
      .select("id");
    if (error) throwStorageError(error);
    if (!data.length) {
      response.status(404).json({ error: "Record not found." });
      return;
    }
    response.json({ records: await readRecords() });
  } catch (error) {
    next(error);
  }
});

app.use("/api", (request, response) => {
  response.status(404).json({ error: "API endpoint not found." });
});

const distDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
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
  if (error instanceof StorageError) {
    response.status(502).json({ error: error.message });
    return;
  }
  if (error instanceof InputError) {
    response.status(400).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: "Server error. Check the service logs for details." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Contact records server listening on port ${port}`);
});
