import { Database } from 'sql.js';
import { App } from 'obsidian';

export class CustomSQLFunctions {

  static register(db: Database, app: App): void {
    this.registerRegexFunctions(db);
    this.registerDateFunctions(db);
    this.registerLinkFunctions(db);
    this.registerPathFunctions(db);
    this.registerGeoFunctions(db);
    this.registerResolveFunctions(db, app);
  }

  private static registerRegexFunctions(db: Database): void {
    // regexp(pattern, text) - enables the REGEXP operator
    // SQLite translates "X REGEXP Y" to "regexp(Y, X)" (pattern first, text second)
    db.create_function('regexp', (pattern: string, text: string) => {
      if (pattern === null || text === null) return 0;
      try {
        return new RegExp(pattern).test(text) ? 1 : 0;
      }

      catch {
        return 0;
      }
    });

    // regexp_replace(text, pattern, replacement) - find and replace with regex
    // Processes escape sequences in replacement: \n, \t, \r, \\
    db.create_function('regexp_replace', (text: string, pattern: string, replacement: string) => {
      if (text === null) return null;
      if (pattern === null) return text;
      try {
        const processedReplacement = (replacement ?? '')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r')
          .replace(/\\\\/g, '\\');
        return text.replace(new RegExp(pattern, 'g'), processedReplacement);
      }

      catch {
        return text;
      }
    });
  }

  private static registerLinkFunctions(db: Database): void {
    // link(path) - basic link
    db.create_function('link', (path: string) => {
      if (path === null || path === undefined) return null;
      return `[[${path}]]`;
    });

    // link(path, display) - link with display text
    db.create_function('link', (path: string, display: string) => {
      if (path === null || path === undefined) return null;
      if (display !== null && display !== undefined) {
        return `[[${path}|${display}]]`;
      }
      return `[[${path}]]`;
    });

    // link_heading(path, heading) - link to heading
    db.create_function('link_heading', (path: string, heading: string) => {
      if (path === null || path === undefined) return null;
      if (heading === null || heading === undefined) return `[[${path}]]`;
      return `[[${path}#${heading}]]`;
    });

    // link_heading(path, heading, display) - link to heading with display text
    db.create_function('link_heading', (path: string, heading: string, display: string) => {
      if (path === null || path === undefined) return null;
      const anchor = heading !== null && heading !== undefined ? `#${heading}` : '';
      if (display !== null && display !== undefined) {
        return `[[${path}${anchor}|${display}]]`;
      }
      return `[[${path}${anchor}]]`;
    });

    // link_block(path, block_id) - link to block reference
    db.create_function('link_block', (path: string, blockId: string) => {
      if (path === null || path === undefined) return null;
      if (blockId === null || blockId === undefined) return `[[${path}]]`;
      // Block IDs are prefixed with ^ in the link
      const cleanBlockId = blockId.startsWith('^') ? blockId.substring(1) : blockId;
      return `[[${path}#^${cleanBlockId}]]`;
    });

    // link_block(path, block_id, display) - link to block reference with display text
    db.create_function('link_block', (path: string, blockId: string, display: string) => {
      if (path === null || path === undefined) return null;
      let anchor = '';
      if (blockId !== null && blockId !== undefined) {
        const cleanBlockId = blockId.startsWith('^') ? blockId.substring(1) : blockId;
        anchor = `#^${cleanBlockId}`;
      }
      if (display !== null && display !== undefined) {
        return `[[${path}${anchor}|${display}]]`;
      }
      return `[[${path}${anchor}]]`;
    });
  }

  private static registerPathFunctions(db: Database): void {
    // Helper function for extracting filename
    const extractFilename = (path: string): string | null => {
      if (path === null || path === undefined) return null;
      const lastSlash = path.lastIndexOf('/');
      return lastSlash === -1 ? path : path.substring(lastSlash + 1);
    };

    // filename(path) - intuitive alias for path_name
    db.create_function('filename', extractFilename);

    // path_name(path) - extract filename with extension
    db.create_function('path_name', extractFilename);

    // path_basename(path) - extract filename without extension
    db.create_function('path_basename', (path: string) => {
      if (path === null || path === undefined) return null;
      const lastSlash = path.lastIndexOf('/');
      const name = lastSlash === -1 ? path : path.substring(lastSlash + 1);
      const lastDot = name.lastIndexOf('.');
      return lastDot === -1 ? name : name.substring(0, lastDot);
    });

    // path_extension(path) - extract file extension without dot
    db.create_function('path_extension', (path: string) => {
      if (path === null || path === undefined) return null;
      const lastSlash = path.lastIndexOf('/');
      const name = lastSlash === -1 ? path : path.substring(lastSlash + 1);
      const lastDot = name.lastIndexOf('.');
      return lastDot === -1 ? '' : name.substring(lastDot + 1);
    });

    // path_parent(path) - extract parent folder path
    db.create_function('path_parent', (path: string) => {
      if (path === null || path === undefined) return null;
      const lastSlash = path.lastIndexOf('/');
      return lastSlash === -1 ? '' : path.substring(0, lastSlash);
    });
  }

  private static registerDateFunctions(db: Database): void {
    // parse_date(text) - extract and normalize date from text
    // Searches for common date patterns anywhere in the text
    // Returns ISO format (YYYY-MM-DD) or null if no date found
    db.create_function('parse_date', (text: string) => {
      return this.parseDate(text);
    });

    // format_date(date, format) - format a date string using format specifiers
    // Input: ISO date (YYYY-MM-DD) or any string parse_date can handle
    // Returns formatted date string or null if input is invalid
    db.create_function('format_date', (dateStr: string, format: string) => {
      return this.formatDate(dateStr, format);
    });
  }

  private static parseDate(text: string): string | null {
    if (text === null || text === undefined) return null;

    const monthNames: Record<string, string> = {
      'january': '01', 'february': '02', 'march': '03', 'april': '04',
      'may': '05', 'june': '06', 'july': '07', 'august': '08',
      'september': '09', 'october': '10', 'november': '11', 'december': '12',
      'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
      'jun': '06', 'jul': '07', 'aug': '08', 'sep': '09',
      'oct': '10', 'nov': '11', 'dec': '12'
    };

    const pad = (n: string | number): string => String(n).padStart(2, '0');

    const patterns: Array<{ regex: RegExp; extract: (m: RegExpMatchArray) => string | null }> = [
      // ISO format: YYYY-MM-DD or YYYY/MM/DD
      {
        regex: /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/,
        extract: (m) => `${m[1]}-${pad(m[2])}-${pad(m[3])}`
      },
      // Compact: YYYYMMDD
      {
        regex: /\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/,
        extract: (m) => `${m[1]}-${m[2]}-${m[3]}`
      },
      // US format: MM/DD/YYYY or MM-DD-YYYY
      {
        regex: /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/,
        extract: (m) => {
          const month = parseInt(m[1], 10);
          const day = parseInt(m[2], 10);
          // Validate month/day ranges for US format
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            return `${m[3]}-${pad(month)}-${pad(day)}`;
          }
          return null;
        }
      },
      // Month name formats: "December 20, 2024" or "Dec 20, 2024"
      {
        regex: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/i,
        extract: (m) => {
          const month = monthNames[m[1].toLowerCase()];
          if (month) {
            return `${m[3]}-${month}-${pad(m[2])}`;
          }
          return null;
        }
      },
      // Day-first month name: "20 December 2024" or "20th December 2024"
      {
        regex: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec),?\s*(\d{4})\b/i,
        extract: (m) => {
          const month = monthNames[m[2].toLowerCase()];
          if (month) {
            return `${m[3]}-${month}-${pad(m[1])}`;
          }
          return null;
        }
      },
      // European format: DD.MM.YYYY
      {
        regex: /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,
        extract: (m) => {
          const day = parseInt(m[1], 10);
          const month = parseInt(m[2], 10);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            return `${m[3]}-${pad(month)}-${pad(day)}`;
          }
          return null;
        }
      }
    ];

    for (const { regex, extract } of patterns) {
      const match = text.match(regex);
      if (match) {
        const result = extract(match);
        if (result) {
          // Validate the date is real
          const [year, month, day] = result.split('-').map(Number);
          const date = new Date(year, month - 1, day);

          if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
            return result;
          }
        }
      }
    }

    return null;
  }

  private static formatDate(dateStr: string, format: string): string | null {
    if (dateStr === null || dateStr === undefined) return null;
    if (format === null || format === undefined) return dateStr;

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthAbbrev = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayAbbrev = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let year: number, month: number, day: number;
    const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      year = parseInt(isoMatch[1], 10);
      month = parseInt(isoMatch[2], 10);
      day = parseInt(isoMatch[3], 10);
    }

    else {
      const compactMatch = dateStr.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compactMatch) {
        year = parseInt(compactMatch[1], 10);
        month = parseInt(compactMatch[2], 10);
        day = parseInt(compactMatch[3], 10);
      }

      else {
        return null;
      }
    }

    // Validate date
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }

    // Calculate day of year
    const startOfYear = new Date(year, 0, 1);
    const diffMs = date.getTime() - startOfYear.getTime();
    const dayOfYear = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;

    // Apply format specifiers
    return format
      .replace(/%%/g, '\x00') // Temporarily replace %%
      .replace(/%Y/g, String(year))
      .replace(/%y/g, String(year).slice(-2))
      .replace(/%B/g, monthNames[month - 1])
      .replace(/%b/g, monthAbbrev[month - 1])
      .replace(/%m/g, String(month).padStart(2, '0'))
      .replace(/%d/g, String(day).padStart(2, '0'))
      .replace(/%e/g, String(day))
      .replace(/%A/g, dayNames[date.getDay()])
      .replace(/%a/g, dayAbbrev[date.getDay()])
      .replace(/%w/g, String(date.getDay()))
      .replace(/%j/g, String(dayOfYear).padStart(3, '0'))
      .replace(/\x00/g, '%'); // Restore literal %
  }

  private static registerGeoFunctions(db: Database): void {
    // geo_lat(text) - extract latitude from "lat, lng" or "lat,lng" format
    db.create_function('geo_lat', (text: string) => {
      if (text === null || text === undefined) return null;
      const coords = this.parseCoordinates(text);
      return coords ? coords.lat : null;
    });

    // geo_lng(text) - extract longitude from "lat, lng" or "lat,lng" format
    db.create_function('geo_lng', (text: string) => {
      if (text === null || text === undefined) return null;
      const coords = this.parseCoordinates(text);
      return coords ? coords.lng : null;
    });

    // geo_distance_mi(lat1, lng1, lat2, lng2) - Haversine distance in miles
    db.create_function('geo_distance_mi', (lat1: number, lng1: number, lat2: number, lng2: number) => {
      if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null;
      const km = this.haversineDistance(lat1, lng1, lat2, lng2);
      return km * 0.621371; // Convert km to miles
    });

    // geo_distance_km(lat1, lng1, lat2, lng2) - Haversine distance in kilometers
    db.create_function('geo_distance_km', (lat1: number, lng1: number, lat2: number, lng2: number) => {
      if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null;
      return this.haversineDistance(lat1, lng1, lat2, lng2);
    });
  }

  private static parseCoordinates(text: string): { lat: number; lng: number } | null {
    if (!text || typeof text !== 'string') return null;

    // Try common formats: "lat, lng", "lat,lng", "lat lng"
    const patterns = [
      /^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/,  // "lat, lng" or "lat,lng"
      /^\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*$/       // "lat lng"
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        // Validate coordinate ranges
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng };
        }
      }
    }

    return null;
  }

  private static haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  private static registerResolveFunctions(db: Database, app: App): void {
    // resolve_link(wikilink) - resolve a wikilink to a full path
    // Accepts: "[[Note Name]]", "Note Name", or "[[Note Name|Display]]"
    // Returns: full path like "folder/Note Name.md" or null if not found
    db.create_function('resolve_link', (wikilink: string) => {
      return this.resolveLink(app, wikilink, '');
    });

    // resolve_link(wikilink, sourcePath) - resolve relative to a source file
    // Useful when the link might be relative to a specific location
    db.create_function('resolve_link', (wikilink: string, sourcePath: string) => {
      return this.resolveLink(app, wikilink, sourcePath);
    });
  }

  private static resolveLink(app: App, wikilink: string, sourcePath: string): string | null {
    if (wikilink === null || wikilink === undefined) return null;

    // Strip [[ and ]] if present
    let linkText = wikilink.trim();
    if (linkText.startsWith('[[') && linkText.endsWith(']]')) {
      linkText = linkText.slice(2, -2);
    }

    // Handle display text: [[Note Name|Display]] -> Note Name
    const pipeIndex = linkText.indexOf('|');
    if (pipeIndex !== -1) {
      linkText = linkText.substring(0, pipeIndex);
    }

    // Handle heading/block references: [[Note#Heading]] -> Note
    const hashIndex = linkText.indexOf('#');
    if (hashIndex !== -1) {
      linkText = linkText.substring(0, hashIndex);
    }

    // Trim whitespace
    linkText = linkText.trim();
    if (!linkText) return null;

    // Use Obsidian's metadata cache to resolve the link
    const resolved = app.metadataCache.getFirstLinkpathDest(linkText, sourcePath || '');
    return resolved?.path ?? null;
  }
}
