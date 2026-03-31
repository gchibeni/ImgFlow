import Papa from 'papaparse';

export interface SheetData {
  name: string;
  headers: string[];
  rows: string[][];
}

export function parseCSV(content: string): SheetData[] {
  const result = Papa.parse<string[]>(content, {
    header: false,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error(result.errors[0].message);
  }

  const headers = result.data[0] || [];
  const rows = result.data.slice(1);

  return [
    {
      name: 'Sheet1',
      headers: headers.map((h) => h.trim()),
      rows,
    },
  ];
}

export function parseTSV(content: string): SheetData[] {
  const result = Papa.parse<string[]>(content, {
    header: false,
    skipEmptyLines: true,
    delimiter: '\t',
  });

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error(result.errors[0].message);
  }

  const headers = result.data[0] || [];
  const rows = result.data.slice(1);

  return [
    {
      name: 'Sheet1',
      headers: headers.map((h) => h.trim()),
      rows,
    },
  ];
}

export function parseFile(file: File): Promise<SheetData[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const ext = file.name.toLowerCase().split('.').pop();
        if (ext === 'tsv') {
          resolve(parseTSV(content));
        } else {
          resolve(parseCSV(content));
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export function isImageColumn(header: string): boolean {
  const lower = header.toLowerCase();
  return (
    lower.includes('image') ||
    lower.includes('img') ||
    lower.includes('photo') ||
    lower.includes('picture') ||
    lower.includes('thumbnail')
  );
}

export function isUrl(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('www.') ||
    trimmed.includes('dropbox.com') ||
    trimmed.includes('drive.google.com')
  );
}

/**
 * Returns indices of columns that contain image URLs or are image-named.
 * A column is considered an "image column" if its header matches image patterns
 * OR if the majority of its non-empty values are URLs.
 */
export function getImageColumnIndices(headers: string[], rows: string[][]): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < headers.length; i++) {
    if (isImageColumn(headers[i])) {
      indices.add(i);
      continue;
    }
    // Check if most values are URLs
    let urlCount = 0;
    let nonEmpty = 0;
    for (const row of rows) {
      const val = row[i]?.trim();
      if (val) {
        nonEmpty++;
        if (isUrl(val)) urlCount++;
      }
    }
    if (nonEmpty > 0 && urlCount / nonEmpty > 0.5) {
      indices.add(i);
    }
  }
  return indices;
}

/**
 * Returns headers that are NOT image/URL columns (suitable for tag suggestions).
 */
export function getNonImageHeaders(headers: string[], rows: string[][]): string[] {
  const imageIndices = getImageColumnIndices(headers, rows);
  return headers.filter((_, i) => !imageIndices.has(i));
}
