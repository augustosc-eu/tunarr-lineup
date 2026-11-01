import { jsPDF } from 'jspdf';

export type ProgramLogPdfRow = {
  start: string;
  end: string;
  duration: string;
  type: string;
  title: string;
  detail: string;
  position: string;
};

export type ProgramLogPdfReport = {
  channelNumber: string | number;
  channelName: string;
  date: string;
  unsaved: boolean;
  rows: ProgramLogPdfRow[];
  generatedAt?: number;
};

type TextLine = { text: string; x: number; y: number; bold?: boolean; size?: number; color?: string };
type Page = { rows: Array<{ row: ProgramLogPdfRow; height: number; title: string[]; detail: string[] }> };

const PAGE_WIDTH = 1122;
const PAGE_HEIGHT = 794;
const SCALE = 2;
const MARGIN = 42;
const TABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const COLUMNS = [105, 95, 300, 350, 105, 83] as const;
const ROW_FONT = '12px Arial, sans-serif';
const ROW_LINE = 16;

const COLORS = {
  ink: '#162231',
  muted: '#667085',
  navy: '#19375f',
  blue: '#2f6fab',
  pale: '#eaf1f8',
  line: '#cbd5e1',
  alternate: '#f7f9fc',
  warning: '#9a3412',
  warningFill: '#ffedd5',
};

function displayDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function totalDuration(rows: ProgramLogPdfRow[]) {
  const milliseconds = rows.reduce((total, row) => {
    const parts = row.duration.split(':').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return total;
    return total + ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  }, 0);
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function fitLine(context: CanvasRenderingContext2D, value: string, width: number, ellipsis = false) {
  if (!ellipsis && context.measureText(value).width <= width) return value;
  const suffix = '...';
  let fitted = value;
  while (fitted.length > 1 && context.measureText(`${fitted}${suffix}`).width > width) fitted = fitted.slice(0, -1);
  return `${fitted.trimEnd()}${suffix}`;
}

function wrapText(context: CanvasRenderingContext2D, value: string, width: number, maxLines = 2) {
  const normalized = value.trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= width || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const used = lines.join(' ').length;
  return lines.map((text, index) => fitLine(context, text, width, context.measureText(text).width > width || (index === lines.length - 1 && used < normalized.length)));
}

function measureRows(context: CanvasRenderingContext2D, rows: ProgramLogPdfRow[]) {
  context.font = ROW_FONT;
  return rows.map((row) => {
    const title = wrapText(context, row.title, COLUMNS[2] - 18);
    const detail = wrapText(context, row.detail, COLUMNS[3] - 18);
    return { row, title, detail, height: Math.max(32, Math.max(title.length, detail.length) * ROW_LINE + 12) };
  });
}

function paginate(measured: ReturnType<typeof measureRows>) {
  const pages: Page[] = [];
  let page: Page = { rows: [] };
  let used = 0;
  for (const measuredRow of measured) {
    const available = PAGE_HEIGHT - (pages.length ? 112 : 214) - 46;
    if (page.rows.length && used + measuredRow.height > available) {
      pages.push(page);
      page = { rows: [] };
      used = 0;
    }
    page.rows.push(measuredRow);
    used += measuredRow.height;
  }
  if (page.rows.length || !pages.length) pages.push(page);
  return pages;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: string) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fillStyle = fill;
  context.fill();
}

function drawText(context: CanvasRenderingContext2D, line: TextLine) {
  context.font = `${line.bold ? '700' : '400'} ${line.size ?? 12}px Arial, sans-serif`;
  context.fillStyle = line.color ?? COLORS.ink;
  context.fillText(line.text, line.x, line.y);
}

function drawPage(context: CanvasRenderingContext2D, report: ProgramLogPdfReport, page: Page, pageNumber: number, pageCount: number) {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  const first = pageNumber === 1;
  let tableTop: number;

  if (first) {
    context.fillStyle = COLORS.navy;
    context.fillRect(0, 0, PAGE_WIDTH, 96);
    drawText(context, { text: 'PROGRAM LOG', x: MARGIN, y: 42, bold: true, size: 25, color: '#ffffff' });
    drawText(context, { text: `CH ${report.channelNumber}  ${report.channelName}`, x: MARGIN, y: 72, bold: true, size: 16, color: '#ffffff' });
    context.textAlign = 'right';
    drawText(context, { text: displayDate(report.date), x: PAGE_WIDTH - MARGIN, y: 45, bold: true, size: 16, color: '#ffffff' });
    context.textAlign = 'left';

    roundedRect(context, MARGIN, 116, 164, 48, 6, COLORS.pale);
    roundedRect(context, MARGIN + 176, 116, 164, 48, 6, COLORS.pale);
    roundedRect(context, MARGIN + 352, 116, report.unsaved ? 260 : 230, 48, 6, report.unsaved ? COLORS.warningFill : COLORS.pale);
    drawText(context, { text: 'ENTRIES', x: MARGIN + 14, y: 136, bold: true, size: 10, color: COLORS.muted });
    drawText(context, { text: String(report.rows.length), x: MARGIN + 14, y: 155, bold: true, size: 16 });
    drawText(context, { text: 'SCHEDULED AIRTIME', x: MARGIN + 190, y: 136, bold: true, size: 10, color: COLORS.muted });
    drawText(context, { text: totalDuration(report.rows), x: MARGIN + 190, y: 155, bold: true, size: 16 });
    drawText(context, { text: report.unsaved ? 'UNSAVED LINEUP' : 'SAVED LINEUP', x: MARGIN + 366, y: 136, bold: true, size: 10, color: report.unsaved ? COLORS.warning : COLORS.muted });
    drawText(context, { text: report.unsaved ? 'Includes desk changes' : 'Current loaded programming', x: MARGIN + 366, y: 155, bold: true, size: 14, color: report.unsaved ? COLORS.warning : COLORS.ink });
    tableTop = 184;
  } else {
    context.fillStyle = COLORS.navy;
    context.fillRect(0, 0, PAGE_WIDTH, 62);
    drawText(context, { text: `CH ${report.channelNumber}  ${report.channelName}`, x: MARGIN, y: 38, bold: true, size: 16, color: '#ffffff' });
    context.textAlign = 'right';
    drawText(context, { text: displayDate(report.date), x: PAGE_WIDTH - MARGIN, y: 38, bold: true, size: 14, color: '#ffffff' });
    context.textAlign = 'left';
    tableTop = 82;
  }

  const headers = ['TIME', 'TYPE', 'PROGRAM', 'DETAIL', 'LENGTH', 'POS.'];
  context.fillStyle = COLORS.blue;
  context.fillRect(MARGIN, tableTop, TABLE_WIDTH, 30);
  let x = MARGIN;
  for (let i = 0; i < headers.length; i += 1) {
    drawText(context, { text: headers[i], x: x + 9, y: tableTop + 20, bold: true, size: 10, color: '#ffffff' });
    x += COLUMNS[i];
  }

  let y = tableTop + 30;
  page.rows.forEach((measured, index) => {
    if (index % 2) {
      context.fillStyle = COLORS.alternate;
      context.fillRect(MARGIN, y, TABLE_WIDTH, measured.height);
    }
    context.strokeStyle = COLORS.line;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(MARGIN, y + measured.height);
    context.lineTo(MARGIN + TABLE_WIDTH, y + measured.height);
    context.stroke();

    let cellX = MARGIN;
    drawText(context, { text: `${measured.row.start.slice(0, 5)}-${measured.row.end.slice(0, 5)}`, x: cellX + 9, y: y + 20, bold: true });
    cellX += COLUMNS[0];
    drawText(context, { text: measured.row.type, x: cellX + 9, y: y + 20, bold: true, size: 10, color: COLORS.blue });
    cellX += COLUMNS[1];
    measured.title.forEach((line, lineIndex) => drawText(context, { text: line, x: cellX + 9, y: y + 19 + lineIndex * ROW_LINE, bold: lineIndex === 0 }));
    cellX += COLUMNS[2];
    measured.detail.forEach((line, lineIndex) => drawText(context, { text: line, x: cellX + 9, y: y + 19 + lineIndex * ROW_LINE, color: COLORS.muted }));
    cellX += COLUMNS[3];
    drawText(context, { text: measured.row.duration, x: cellX + 9, y: y + 20 });
    cellX += COLUMNS[4];
    drawText(context, { text: measured.row.position, x: cellX + 9, y: y + 20 });
    y += measured.height;
  });

  const generated = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt ?? Date.now()));
  drawText(context, { text: `Generated by Tunarr Lineup - ${generated}`, x: MARGIN, y: PAGE_HEIGHT - 22, size: 9, color: COLORS.muted });
  context.textAlign = 'right';
  drawText(context, { text: `Page ${pageNumber} of ${pageCount}`, x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 22, bold: true, size: 9, color: COLORS.muted });
  context.textAlign = 'left';
}

function canvasContext() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_WIDTH * SCALE;
    canvas.height = PAGE_HEIGHT * SCALE;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.scale(SCALE, SCALE);
    return { canvas, context };
  } catch {
    return null;
  }
}

/** A visual, printable program log. Canvas text keeps titles in the viewer's script intact. */
export function createProgramLogPdf(report: ProgramLogPdfReport) {
  const surface = canvasContext();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  if (!surface) {
    doc.setFontSize(18);
    doc.text(`CH ${report.channelNumber} ${report.channelName}`, 14, 18);
    doc.setFontSize(11);
    doc.text(`${displayDate(report.date)} - ${report.rows.length} entries`, 14, 27);
    report.rows.slice(0, 45).forEach((row, index) => doc.text(`${row.start.slice(0, 5)}  ${row.type}  ${row.title}`, 14, 36 + index * 5));
    return doc.output('blob');
  }

  const measured = measureRows(surface.context, report.rows);
  const pages = paginate(measured);
  pages.forEach((page, index) => {
    if (index) doc.addPage('a4', 'landscape');
    drawPage(surface.context, report, page, index + 1, pages.length);
    doc.addImage(surface.canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 297, 210, undefined, 'FAST');
  });
  return doc.output('blob');
}
