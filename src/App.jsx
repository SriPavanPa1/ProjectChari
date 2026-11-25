
import React, { useEffect, useMemo, useState } from "react";
import { normalizeRecordId } from "./recordUtils.js";
import { supabase, supabaseConfigError } from "./supabase.js";

const FIELD_KEYS = ["id", "name", "address", "phoneNumber", "comments"];
const DATE_KEYS = ["createdAt", "updatedAt"];
const SEARCH_KEYS = [...FIELD_KEYS, ...DATE_KEYS];
const DATABASE_FIELDS =
  "id,name,address,phone_number,comments,created_at,updated_at";
const COLUMNS = [
  ["id", "ID"],
  ["name", "Name"],
  ["address", "Address"],
  ["phoneNumber", "Phone Number"],
  ["comments", "Comments"],
];
const DATE_COLUMNS = [
  ["createdAt", "Created"],
  ["updatedAt", "Last updated"],
];
const HEADER_ALIASES = new Map([
  ["id", "id"],
  ["name", "name"],
  ["address", "address"],
  ["phonenumber", "phoneNumber"],
  ["phone", "phoneNumber"],
  ["comments", "comments"],
  ["comment", "comments"],
]);

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
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function getDatabaseErrorMessage(error, fallback) {
  if (error?.code === "23505") {
    return `A record with ID "${error.details ?? "the entered ID"}" already exists.`;
  }
  if (error?.code === "PGRST202" || error?.code === "42883") {
    return "The import function is missing. Run supabase/schema.sql in the Supabase SQL Editor.";
  }
  return error instanceof Error ? error.message : fallback;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseWorksheet(worksheet, XLSX) {
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });
  if (rows.length === 0) throw new Error("The first worksheet is empty.");

  const mapping = new Map();
  rows[0].forEach((header, index) => {
    const field = HEADER_ALIASES.get(normalizeHeader(header));
    if (field && !mapping.has(field)) mapping.set(field, index);
  });
  if (!mapping.has("id")) {
    throw new Error("The first worksheet must have an ID column.");
  }

  const imported = [];
  let skippedMissingId = 0;
  for (const row of rows.slice(1)) {
    const record = Object.fromEntries(
      FIELD_KEYS.map((field) => {
        const index = mapping.get(field);
        const value = index === undefined ? "" : row[index];
        return [field, value == null ? "" : String(value).trim()];
      }),
    );

    if (!record.id) {
      skippedMissingId += 1;
    } else {
      imported.push(record);
    }
  }

  if (imported.length === 0) {
    throw new Error("No data rows with a valid ID were found.");
  }
  return { imported, skippedMissingId };
}

function formatImportStatus(addedRecords, duplicateIds, skippedMissingId) {
  const uniqueDuplicateIds = [...new Set(duplicateIds)];
  const duplicateList = uniqueDuplicateIds.slice(0, 5).join(", ");
  const moreDuplicates =
    uniqueDuplicateIds.length > 5 ? `, and ${uniqueDuplicateIds.length - 5} more` : "";
  const parts = [
    addedRecords.length
      ? `${addedRecords.length} new record(s) added.`
      : "No new records added.",
  ];

  if (duplicateIds.length) {
    parts.push(
      `${duplicateIds.length} row(s) with existing or repeated ID(s) were skipped: ${duplicateList}${moreDuplicates}.`,
    );
  }
  if (skippedMissingId) {
    parts.push(
      `${skippedMissingId} row(s) without an ID were skipped.`,
    );
  }
  return parts.join(" ");
}

function App() {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState({ message: "", state: "success" });
  const [user, setUser] = useState(null);
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [isLoadingRecords, setIsLoadingRecords] = useState(true);
  const [file, setFile] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [searchField, setSearchField] = useState("all");
  const [activeModule, setActiveModule] = useState("records");
  const [editingRecord, setEditingRecord] = useState(null);
  const [isAddingRecord, setIsAddingRecord] = useState(false);
  const isAuthenticated = Boolean(user);

  useEffect(() => {
    if (!supabase) {
      setStatus({ message: supabaseConfigError, state: "error" });
      setIsLoadingRecords(false);
      return undefined;
    }

    let active = true;
    async function restoreSession() {
      setIsLoadingRecords(true);
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error) {
        setStatus({ message: error.message, state: "error" });
      } else if (data.session?.user) {
        setUser(data.session.user);
        await loadRecords(() => active);
      }
      if (active) setIsLoadingRecords(false);
    }

    restoreSession().catch((error) => {
      if (!active) return;
      setStatus({
        message: getDatabaseErrorMessage(error, "Could not restore your session."),
        state: "error",
      });
      setIsLoadingRecords(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        setRecords([]);
      } else if (session?.user) {
        setUser(session.user);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function loadRecords(isActive = () => true) {
    const pageSize = 1000;
    const allRecords = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase
        .from("contact_records")
        .select(DATABASE_FIELDS)
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;

      allRecords.push(...data.map(fromDatabaseRecord));
      if (data.length < pageSize) break;
    }
    if (isActive()) setRecords(allRecords);
    return allRecords;
  }

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => {
        const fields = searchField === "all" ? SEARCH_KEYS : [searchField];
        return fields.some((key) =>
          String(DATE_KEYS.includes(key) ? formatDate(record[key]) : (record[key] ?? ""))
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        );
      });
  }, [query, records, searchField]);

  async function handleLogin(event) {
    event.preventDefault();
    setIsLoadingRecords(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: emailInput.trim(),
        password: passwordInput,
      });
      if (error) throw error;
      if (!data.user) throw new Error("Supabase did not return a signed-in user.");
      setUser(data.user);
      await loadRecords();
      setEmailInput("");
      setPasswordInput("");
      setStatus({ message: "", state: "success" });
    } catch (error) {
      setStatus({
        message: getDatabaseErrorMessage(error, "Could not sign in."),
        state: "error",
      });
    } finally {
      setIsLoadingRecords(false);
    }
  }

  async function handleImport(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) {
      setStatus({ message: "Choose an Excel file to import.", state: "error" });
      return;
    }

    setIsImporting(true);
    try {
      const XLSX = await import("@e965/xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error("The Excel file does not contain a worksheet.");
      }

      const { imported, skippedMissingId } = parseWorksheet(
        workbook.Sheets[firstSheetName],
        XLSX,
      );
      const { data, error } = await supabase.rpc("import_contact_records", {
        input_records: imported.map(toDatabaseRecord),
      });
      if (error) throw error;
      const result = data?.[0] ?? { added_records: [], duplicate_ids: [] };
      const addedRecords = result.added_records ?? [];
      const duplicateIds = result.duplicate_ids ?? [];
      await loadRecords();

      setStatus({
        message: formatImportStatus(
          addedRecords,
          duplicateIds,
          skippedMissingId,
        ),
        state: duplicateIds.length || skippedMissingId ? "warning" : "success",
      });
      setFile(null);
      form.reset();
    } catch (error) {
      setStatus({
        message: `Import failed: ${getDatabaseErrorMessage(error, "The file could not be read.")}`,
        state: "error",
      });
    } finally {
      setIsImporting(false);
    }
  }

  function handleExport() {
    const blob = new Blob([`${JSON.stringify(records, null, 2)}\n`], {
      type: "application/json",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "contact-records.json";
    link.click();
    URL.revokeObjectURL(downloadUrl);
  }

  async function handleRecordSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const record = Object.fromEntries(
      FIELD_KEYS.map((field) => [field, String(formData.get(field) ?? "").trim()]),
    );

    const conflictingRecord = records.find(
      (existing, index) =>
        index !== editingRecord?.index &&
        normalizeRecordId(existing.id) === normalizeRecordId(record.id),
    );
    if (conflictingRecord) {
      setStatus({
        message: `A record with ID "${record.id}" already exists. Each record must have a unique ID.`,
        state: "error",
      });
      return;
    }

    try {
      const request = supabase.from("contact_records");
      const { error } = editingRecord
        ? await request
            .update(toDatabaseRecord(record))
            .eq("id", editingRecord.record.id)
        : await request.insert({ ...toDatabaseRecord(record), owner_id: user.id });
      if (error) throw error;
      await loadRecords();
      setEditingRecord(null);
      setIsAddingRecord(false);
      setStatus({ message: "", state: "success" });
    } catch (error) {
      setStatus({
        message: getDatabaseErrorMessage(error, "Could not save the record."),
        state: "error",
      });
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this record? This cannot be undone.")) return;
    try {
      const { data, error } = await supabase
        .from("contact_records")
        .delete()
        .eq("id", id)
        .select("id");
      if (error) throw error;
      if (!data.length) {
        throw new Error("Record not found or you do not have permission to delete it.");
      }
      await loadRecords();
      setStatus({ message: "", state: "success" });
    } catch (error) {
      setStatus({
        message: getDatabaseErrorMessage(error, "Could not delete the record."),
        state: "error",
      });
    }
  }

  async function handleSignOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setRecords([]);
      setUser(null);
    } catch (error) {
      setStatus({
        message: getDatabaseErrorMessage(error, "Could not sign out."),
        state: "error",
      });
    }
  }

  if (!isAuthenticated) {
    return (
      <main className="auth-screen">
        <section className="panel auth-panel">
          <p className="eyebrow">PRIVATE WORKSPACE</p>
          <h1>Contact records</h1>
          <p className="intro">Sign in with your Supabase account to access your saved records.</p>
          <form className="auth-form" onSubmit={handleLogin}>
            <label className="form-field" htmlFor="login-email">
              Email
              <input
                autoComplete="username"
                id="login-email"
                type="email"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                required
              />
            </label>
            <label className="form-field" htmlFor="login-password">
              Password
              <input
                autoComplete="current-password"
                id="login-password"
                type="password"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                required
              />
            </label>
            <button
              className="button button-primary"
              type="submit"
              disabled={isLoadingRecords || !supabase}
            >
              {isLoadingRecords ? "Connecting..." : "Sign in"}
            </button>
          </form>
          {status.message && (
            <p className="status" data-state={status.state} role="alert">
              {status.message}
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PRIVATE CONTACT WORKSPACE</p>
          <h1>Contact records</h1>
          <p className="intro">Import an Excel sheet, then find the records you need.</p>
        </div>
        <div className="header-actions">
          <span className="record-count header-record-count">
            {records.length} {records.length === 1 ? "saved record" : "saved records"}
          </span>
          <button
            className="button button-secondary"
            onClick={handleExport}
            type="button"
            disabled={records.length === 0}
          >
            Export JSON
          </button>
          <button
            className="button button-secondary"
            onClick={handleSignOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="module-nav" aria-label="Main navigation">
        <button
          className={`module-nav-button${activeModule === "upload" ? " active" : ""}`}
          type="button"
          aria-current={activeModule === "upload" ? "page" : undefined}
          onClick={() => setActiveModule("upload")}
        >
          <span className="module-nav-number">01</span>
          Upload Excel
        </button>
        <button
          className={`module-nav-button${activeModule === "records" ? " active" : ""}`}
          type="button"
          aria-current={activeModule === "records" ? "page" : undefined}
          onClick={() => setActiveModule("records")}
        >
          <span className="module-nav-number">02</span>
          Manage records
          <span className="nav-count">{records.length}</span>
        </button>
      </nav>

      {activeModule === "upload" ? (
        <section className="panel upload-panel" aria-labelledby="upload-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MODULE 01</p>
              <h2 id="upload-heading">Upload Excel file</h2>
            </div>
            <span className="tag">.xlsx or .xls</span>
          </div>
          <p className="section-description">
            The first worksheet is imported. <strong>ID</strong> is required; Name, Address,
            Phone Number, and Comments can be left blank. New rows are added to your saved records.
          </p>
          <form className="upload-form" onSubmit={handleImport}>
            <label className="file-picker" htmlFor="excel-file">
              <span className="file-picker-icon" aria-hidden="true">
                ↑
              </span>
              <span>
                <strong>{file?.name ?? "Choose an Excel file"}</strong>
                <small>Column headers must include ID</small>
              </span>
              <input
                id="excel-file"
                name="excel-file"
                type="file"
                accept=".xlsx,.xls"
                required
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <button className="button button-primary" type="submit" disabled={isImporting}>
              {isImporting ? "Importing..." : "Import records"}
            </button>
          </form>
          <p className="status" data-state={status.state} role="status" aria-live="polite">
            {status.message}
          </p>
          <div className="upload-note">
            <span aria-hidden="true">i</span>
            <span>
              Imported records are saved to the shared Supabase database.
            </span>
          </div>
        </section>
      ) : (
        <section className="panel records-panel" aria-labelledby="records-heading">
          <div className="section-heading records-heading">
            <div>
              <p className="eyebrow">MODULE 02</p>
              <h2 id="records-heading">Manage records</h2>
            </div>
            <div className="records-actions">
              <span className="record-count">
                {filteredRecords.length} of {records.length} records
              </span>
              <button
                className="button button-primary"
                type="button"
                onClick={() => setIsAddingRecord(true)}
              >
                + Add record
              </button>
            </div>
          </div>

          <div className="search-bar">
            <label className="search-field" htmlFor="search-query">
              <span className="visually-hidden">Search records</span>
              <span aria-hidden="true" className="search-icon">
                ⌕
              </span>
              <input
                id="search-query"
                type="search"
                placeholder="Search records..."
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="filter-field" htmlFor="search-field">
              <span className="visually-hidden">Search in</span>
              <select
                id="search-field"
                value={searchField}
                onChange={(event) => setSearchField(event.target.value)}
              >
                <option value="all">All fields</option>
                {COLUMNS.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
                {DATE_COLUMNS.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map(([key, label]) => (
                    <th key={key} scope="col">
                      {label}
                    </th>
                  ))}
                  {DATE_COLUMNS.map(([key, label]) => (
                    <th key={key} scope="col">
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="actions-heading">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map(({ record, index }) => (
                  <tr key={`${record.id}-${index}`}>
                    {FIELD_KEYS.map((key) => (
                      <td key={key}>{record[key] ?? ""}</td>
                    ))}
                    {DATE_COLUMNS.map(([key]) => (
                      <td key={key}>{formatDate(record[key])}</td>
                    ))}
                    <td className="row-actions">
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setEditingRecord({ record, index })}
                        aria-label={`Edit record ${record.id}`}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button text-button-danger"
                        type="button"
                        onClick={() => handleDelete(record.id)}
                        aria-label={`Delete record ${record.id}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRecords.length === 0 && (
              <div className="empty-state">
                <span className="empty-icon" aria-hidden="true">
                  ⌕
                </span>
                <strong>{records.length === 0 ? "No records yet" : "No matching records"}</strong>
                <span>
                  {records.length === 0
                    ? "Add a record or upload an Excel file."
                    : "Try another search term or field."}
                </span>
              </div>
            )}
          </div>
          <p className="storage-note">
            Records are stored in your Supabase database and shared across your devices.
          </p>
          {status.message && (
            <p className="status" data-state={status.state} role="status" aria-live="polite">
              {status.message}
            </p>
          )}
        </section>
      )}

      {(isAddingRecord || editingRecord) && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsAddingRecord(false);
              setEditingRecord(null);
            }
          }}
        >
          <section
            className="record-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-dialog-title"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">MODULE 02</p>
                <h2 id="record-dialog-title">
                  {editingRecord ? "Edit record" : "Add record"}
                </h2>
              </div>
              <button
                className="dialog-close"
                type="button"
                onClick={() => {
                  setIsAddingRecord(false);
                  setEditingRecord(null);
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <form className="record-form" onSubmit={handleRecordSubmit}>
              {COLUMNS.map(([key, label]) => (
                <label key={key} className="form-field" htmlFor={`record-${key}`}>
                  <span>
                    {label}
                    {key === "id" && <span className="required-mark"> *</span>}
                  </span>
                  {key === "comments" || key === "address" ? (
                    <textarea
                      id={`record-${key}`}
                      name={key}
                      rows={key === "comments" ? 3 : 2}
                      defaultValue={editingRecord?.record[key] ?? ""}
                      required={key === "id"}
                    />
                  ) : (
                    <input
                      id={`record-${key}`}
                      name={key}
                      type="text"
                      defaultValue={editingRecord?.record[key] ?? ""}
                      required={key === "id"}
                    />
                  )}
                </label>
              ))}
              <div className="dialog-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    setIsAddingRecord(false);
                    setEditingRecord(null);
                  }}
                >
                  Cancel
                </button>
                <button className="button button-primary" type="submit">
                  {editingRecord ? "Save changes" : "Add record"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
