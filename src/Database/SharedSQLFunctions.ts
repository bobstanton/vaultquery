import { Database } from 'sql.js';

export class SharedSQLFunctions {
  protected static registerRegexFunctions(db: Database): void {
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

    // Processes escape sequences in replacement: \n, \t, \r, \\
    db.create_function('regexp_replace', (text: string, pattern: string, replacement: string) => {
      if (text == null) return null;
      if (pattern == null) return text;
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

  protected static registerLinkFunctions(db: Database): void {
    const makeLink = (path: string, anchor: string, display: string | null): string | null => {
      if (path == null) return null;
      return display != null ? `[[${path}${anchor}|${display}]]` : `[[${path}${anchor}]]`;
    };
    const headingAnchor = (heading: string | null): string => heading != null ? `#${heading}` : '';
    const blockAnchor = (blockId: string | null): string => {
      if (blockId == null) return '';
      const cleanBlockId = blockId.startsWith('^') ? blockId.substring(1) : blockId;
      return `#^${cleanBlockId}`;
    };

    db.create_function('link', (path: string) => makeLink(path, '', null));

    db.create_function('link', (path: string, display: string) => makeLink(path, '', display));

    db.create_function('link_heading', (path: string, heading: string) => makeLink(path, headingAnchor(heading), null));

    db.create_function('link_heading', (path: string, heading: string, display: string) => {
      return makeLink(path, headingAnchor(heading), display);
    });

    db.create_function('link_block', (path: string, blockId: string) => makeLink(path, blockAnchor(blockId), null));

    db.create_function('link_block', (path: string, blockId: string, display: string) => {
      return makeLink(path, blockAnchor(blockId), display);
    });
  }

  protected static registerPathFunctions(db: Database): void {
    const extractFilename = (path: string): string | null => {
      if (path == null) return null;
      const lastSlash = path.lastIndexOf('/');
      return lastSlash === -1 ? path : path.substring(lastSlash + 1);
    };

    db.create_function('filename', extractFilename);

    db.create_function('path_name', extractFilename);

    db.create_function('path_basename', (path: string) => {
      const name = extractFilename(path);
      if (name === null) return null;
      const lastDot = name.lastIndexOf('.');
      return lastDot === -1 ? name : name.substring(0, lastDot);
    });

    db.create_function('path_extension', (path: string) => {
      const name = extractFilename(path);
      if (name === null) return null;
      const lastDot = name.lastIndexOf('.');
      return lastDot === -1 ? '' : name.substring(lastDot + 1);
    });

    db.create_function('path_parent', (path: string) => {
      if (path == null) return null;
      const lastSlash = path.lastIndexOf('/');
      return lastSlash === -1 ? '' : path.substring(0, lastSlash);
    });
  }

  protected static registerDateFunctions(db: Database): void {
    db.create_function('parse_date', (text: string) => {
      return this.parseDate(text);
    });

    db.create_function('format_date', (dateStr: string, format: string) => {
      return this.formatDate(dateStr, format);
    });
  }

  protected static parseDate(text: string): string | null {
    if (text == null) return null;

    const monthNames: Record<string, string> = {
      'january': '01', 'february': '02', 'march': '03', 'april': '04',
      'may': '05', 'june': '06', 'july': '07', 'august': '08',
      'september': '09', 'october': '10', 'november': '11', 'december': '12',
      'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
      'jun': '06', 'jul': '07', 'aug': '08', 'sep': '09',
      'oct': '10', 'nov': '11', 'dec': '12'
    };

    const pad = (n: string | number): string => String(n).padStart(2, '0');
    const formatNumericDate = (year: string, monthValue: string, dayValue: string): string | null => {
      const month = parseInt(monthValue, 10);
      const day = parseInt(dayValue, 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year}-${pad(month)}-${pad(day)}`;
      }
      return null;
    };

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
        extract: (m) => formatNumericDate(m[3], m[1], m[2])
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
        extract: (m) => formatNumericDate(m[3], m[2], m[1])
      }
    ];

    for (const { regex, extract } of patterns) {
      const match = text.match(regex);
      if (match) {
        const result = extract(match);
        if (result) {
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

  protected static formatDate(dateStr: string, format: string): string | null {
    if (dateStr == null) return null;
    if (format == null) return dateStr;

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

    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }

    // Calculate day of year
    const startOfYear = new Date(year, 0, 1);
    const diffMs = date.getTime() - startOfYear.getTime();
    const dayOfYear = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;

    // Escape literal %% to a private-use sentinel so the directive replacements
    // below don't see it, then restore it to a single % at the end. (A
    // private-use code point avoids the control-character regex warning that a
    // NUL sentinel triggers, and cannot occur in real date directive output.)
    const ESCAPED_PERCENT = '\uF8FF';
    return format
      .replace(/%%/g, ESCAPED_PERCENT)
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
      .replace(/\uF8FF/g, '%'); // Restore literal %
  }

  protected static registerGeoFunctions(db: Database): void {
    db.create_function('geo_lat', (text: string) => {
      if (text == null) return null;
      const coords = this.parseCoordinates(text);
      return coords ? coords.lat : null;
    });

    db.create_function('geo_lng', (text: string) => {
      if (text == null) return null;
      const coords = this.parseCoordinates(text);
      return coords ? coords.lng : null;
    });

    db.create_function('geo_distance_mi', (lat1: number, lng1: number, lat2: number, lng2: number) => {
      if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
      const km = this.haversineDistance(lat1, lng1, lat2, lng2);
      return km * 0.621371; // Convert km to miles
    });

    db.create_function('geo_distance_km', (lat1: number, lng1: number, lat2: number, lng2: number) => {
      if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
      return this.haversineDistance(lat1, lng1, lat2, lng2);
    });
  }

  protected static parseCoordinates(text: string): { lat: number; lng: number } | null {
    if (!text || typeof text !== 'string') return null;

    const patterns = [
      /^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/,  // "lat, lng" or "lat,lng"
      /^\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s*$/       // "lat lng"
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng };
        }
      }
    }

    return null;
  }

  protected static haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
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
}
