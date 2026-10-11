/**
 * A small, strict-enough CSV reader and a safe CSV writer for the migration engine. Hand-written on purpose: the
 * project carries no spreadsheet/CSV dependency, and the bounds below (size, rows, columns) are part of the security
 * posture (docs/security.md section 22), so they live next to the parser.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 100;
export const MAX_CELL_LENGTH = 5_000;

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export interface ParsedCsv {
  headers: string[];
  /** Each row is exactly `headers.length` cells (short rows padded with "", long rows are an error). */
  rows: string[][];
  delimiter: "," | ";" | "\t";
}

function detectDelimiter(firstLine: string): "," | ";" | "\t" {
  // Count delimiters outside quotes on the header line; the most frequent wins, comma on a tie.
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  if (counts["\t"]! > counts[","]! && counts["\t"]! >= counts[";"]!) return "\t";
  if (counts[";"]! > counts[","]!) return ";";
  return ",";
}

export function parseCsv(input: string): ParsedCsv {
  if (input.length > MAX_FILE_BYTES) throw new CsvError("The file is larger than the 10 MB limit.");
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes("\u0000")) throw new CsvError("This does not look like a CSV text file (it contains binary data).");
  text = text.replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) throw new CsvError("The file is empty.");

  const firstLineEnd = text.indexOf("\n");
  const delimiter = detectDelimiter(firstLineEnd === -1 ? text : text.slice(0, firstLineEnd));

  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > MAX_CELL_LENGTH) throw new CsvError(`A cell is longer than ${MAX_CELL_LENGTH} characters.`);
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.length > MAX_COLUMNS) throw new CsvError(`The file has more than ${MAX_COLUMNS} columns.`);
    // A completely blank line is skipped.
    if (!(row.length === 1 && row[0]!.trim() === "")) records.push(row);
    if (records.length > MAX_ROWS + 1) throw new CsvError(`The file has more than ${MAX_ROWS.toLocaleString("en-AU")} rows. Split it and import it in parts.`);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      pushCell();
      i++;
    } else if (ch === "\n") {
      pushRow();
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  if (inQuotes) throw new CsvError("A quoted cell is never closed. Check the file for a stray quote character.");
  if (cell.length > 0 || row.length > 0) pushRow();

  if (records.length === 0) throw new CsvError("The file is empty.");
  const headers = records[0]!.map((h) => h.trim());
  if (headers.every((h) => h === "")) throw new CsvError("The first row must contain column headings.");
  const seen = new Set<string>();
  for (const h of headers) {
    if (h === "") throw new CsvError("A column heading is blank. Every column in the first row needs a name.");
    const key = h.toLowerCase();
    if (seen.has(key)) throw new CsvError(`The column heading "${h}" appears more than once.`);
    seen.add(key);
  }
  const body = records.slice(1).map((r, idx) => {
    if (r.length > headers.length) {
      if (r.slice(headers.length).some((c) => c.trim() !== "")) {
        throw new CsvError(`Row ${idx + 2} has more cells than there are column headings.`);
      }
      return r.slice(0, headers.length);
    }
    return r.length < headers.length ? [...r, ...Array(headers.length - r.length).fill("")] : r;
  });
  return { headers, rows: body, delimiter };
}

/**
 * Neutralises spreadsheet formula injection: a cell that would be read as a formula by Excel / Sheets / LibreOffice
 * (leading = + - @ tab or carriage return) is prefixed with a single quote. Applied to EVERY cell of every CSV the
 * migration engine writes, because those cells contain user-supplied text from the uploaded file.
 */
export function safeCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // A plain signed number (a negative amount) is data, not a formula, and must stay numeric.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((r) => r.map(safeCsvCell).join(",")).join("\r\n") + "\r\n";
}
