// Minimal XLSX writer: worksheets with values, formulas (with cached
// results), data tables, styles, column widths and frozen panes, packed into
// an uncompressed zip. Pure ES module without dependencies — runs in the
// browser (model export) and in Node (API route).
//
// Only what the model export needs: no shared strings (inline strings), no
// merged cells, no charts. Formulas are written in Excel's English syntax
// without the leading "=".

const enc = new TextEncoder();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 0-based column index → letters (0 → A, 26 → AA). */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A1 reference for a 1-based row and 0-based column; `abs` pins both. */
export const cellRef = (row, col, abs = false) => (abs ? `$${colName(col)}$${row}` : `${colName(col)}${row}`);
export const sheetRef = (sheet, ref) => `'${sheet.replace(/'/g, "''")}'!${ref}`;

// ─── Styles ───
const BORDERS = {
  top: '<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom/><diagonal/></border>',
  bottom: '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>',
  total: '<border><left/><right/><top style="thin"><color rgb="FF111827"/></top><bottom/><diagonal/></border>',
  box: '<border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>',
};

class StyleSheet {
  constructor() {
    this.fonts = ['<font><sz val="10"/><name val="Arial"/></font>'];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    this.numFmts = [];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.cache = new Map();
  }

  static index(list, xml) {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  }

  /** spec: { bold, italic, size, color, fill, border, numFmt, align, indent, wrap } → xf index */
  get(spec = {}) {
    const key = JSON.stringify(spec);
    if (this.cache.has(key)) return this.cache.get(key);
    const font = `<font>${spec.bold ? '<b/>' : ''}${spec.italic ? '<i/>' : ''}<sz val="${spec.size || 10}"/>`
      + `${spec.color ? `<color rgb="FF${spec.color}"/>` : ''}<name val="Arial"/></font>`;
    const fontId = StyleSheet.index(this.fonts, font);
    const fillId = spec.fill
      ? StyleSheet.index(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${spec.fill}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0;
    const borderId = spec.border ? StyleSheet.index(this.borders, BORDERS[spec.border]) : 0;
    const numFmtId = spec.numFmt ? 164 + StyleSheet.index(this.numFmts, spec.numFmt) : 0;
    const align = spec.align || spec.indent || spec.wrap
      ? `<alignment${spec.align ? ` horizontal="${spec.align}"` : ''}${spec.indent ? ` indent="${spec.indent}"` : ''}${spec.wrap ? ' wrapText="1" vertical="top"' : ''}/>`
      : '';
    const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
      + `${numFmtId ? ' applyNumberFormat="1"' : ''} applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}`
      + (align ? ` applyAlignment="1">${align}</xf>` : '/>');
    const id = StyleSheet.index(this.xfs, xf);
    this.cache.set(key, id);
    return id;
  }

  xml() {
    const numFmts = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>`
      : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + numFmts
      + `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>`
      + `<fills count="${this.fills.length}">${this.fills.join('')}</fills>`
      + `<borders count="${this.borders.length}">${this.borders.join('')}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }
}

// ─── Worksheets ───
export class Worksheet {
  constructor(name, { widths = [], freeze = null, tabColor = null } = {}) {
    this.name = name;
    this.widths = widths;        // column widths in characters, by 0-based index
    this.freeze = freeze;        // { row, col }: first unfrozen cell (1-based row, 0-based col)
    this.tabColor = tabColor;
    this.rows = new Map();       // row → Map(col → cell)
  }

  /**
   * cell: { v, f, s } — v number | string | boolean | null (cached result for
   * formulas), f formula without "=", s style index; or { dataTable, v, s }.
   */
  set(row, col, cell) {
    if (!this.rows.has(row)) this.rows.set(row, new Map());
    this.rows.get(row).set(col, cell);
  }

  xml() {
    const view = this.freeze
      ? (() => {
        const { row, col } = this.freeze;
        const pane = row > 1 && col > 0 ? 'bottomRight' : row > 1 ? 'bottomLeft' : 'topRight';
        return `<pane${col > 0 ? ` xSplit="${col}"` : ''}${row > 1 ? ` ySplit="${row - 1}"` : ''} topLeftCell="${cellRef(row, col)}" activePane="${pane}" state="frozen"/>`
          + `<selection pane="${pane}" activeCell="${cellRef(row, col)}" sqref="${cellRef(row, col)}"/>`;
      })()
      : '';
    const cols = this.widths.length
      ? `<cols>${this.widths.map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : '')).join('')}</cols>`
      : '';
    const rows = [...this.rows.keys()].sort((a, b) => a - b).map((r) => {
      const cells = [...this.rows.get(r).entries()].sort((a, b) => a[0] - b[0]).map(([c, cell]) => cellXml(cellRef(r, c), cell));
      return `<row r="${r}">${cells.join('')}</row>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + (this.tabColor ? `<sheetPr><tabColor rgb="FF${this.tabColor}"/></sheetPr>` : '')
      + `<sheetViews><sheetView showGridLines="0" workbookViewId="0">${view}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="13.2"/>'
      + cols
      + `<sheetData>${rows.join('')}</sheetData>`
      + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
      + '<pageSetup orientation="landscape" fitToHeight="0"/>'
      + '</worksheet>';
  }
}

function cachedValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { t: '', v: String(v) } : null;
  if (typeof v === 'boolean') return { t: ' t="b"', v: v ? '1' : '0' };
  if (typeof v === 'string' && /^#(N\/A|NUM!|DIV\/0!|VALUE!|REF!)$/.test(v)) return { t: ' t="e"', v };
  if (typeof v === 'string') return { t: ' t="str"', v: esc(v) };
  return null;
}

function cellXml(ref, cell) {
  const s = cell.s ? ` s="${cell.s}"` : '';
  if (cell.dataTable) {
    const d = cell.dataTable;
    const cv = cachedValue(cell.v);
    return `<c r="${ref}"${s}${cv?.t || ''}><f t="dataTable" ref="${d.ref}" dt2D="1" dtr="1" r1="${d.r1}" r2="${d.r2}"/>${cv ? `<v>${cv.v}</v>` : ''}</c>`;
  }
  if (cell.f) {
    const cv = cachedValue(cell.v);
    return `<c r="${ref}"${s}${cv?.t || ''}><f>${esc(cell.f)}</f>${cv ? `<v>${cv.v}</v>` : ''}</c>`;
  }
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
  if (typeof cell.v === 'string' && cell.v !== '') return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
  return `<c r="${ref}"${s}/>`;
}

// ─── Workbook ───
export class Workbook {
  /** iterate: enable iterative calculation (models with interest circularity) */
  constructor({ iterate = false, title = '', author = 'Kontur' } = {}) {
    this.sheets = [];
    this.styles = new StyleSheet();
    this.iterate = iterate;
    this.title = title;
    this.author = author;
  }

  addSheet(name, opts) {
    const ws = new Worksheet(name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31), opts);
    this.sheets.push(ws);
    return ws;
  }

  style(spec) { return this.styles.get(spec); }

  toBytes() {
    const sheetFiles = this.sheets.map((ws, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml: ws.xml() }));
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files = [
      { name: '[Content_Types].xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + sheetFiles.map((f) => `<Override PartName="/${f.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '</Types>' },
      { name: '_rels/.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '</Relationships>' },
      { name: 'docProps/core.xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:title>${esc(this.title)}</dc:title><dc:creator>${esc(this.author)}</dc:creator>`
        + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
        + '</cp:coreProperties>' },
      { name: 'xl/workbook.xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<bookViews><workbookView activeTab="0"/></bookViews>'
        + `<sheets>${this.sheets.map((ws, i) => `<sheet name="${esc(ws.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
        + `<calcPr calcId="191029" fullCalcOnLoad="1"${this.iterate ? ' iterate="1" iterateCount="100" iterateDelta="0.001"' : ''}/>`
        + '</workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + this.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${this.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + '</Relationships>' },
      { name: 'xl/styles.xml', xml: this.styles.xml() },
      ...sheetFiles,
    ];
    return zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.xml) })));
  }
}

// ─── Zip (store, no compression) ───
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);      // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}
