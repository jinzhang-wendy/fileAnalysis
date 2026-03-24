import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist';

// 设置 PDF.js worker（浏览器环境）
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

/**
 * 解析 TXT 文件
 */
export async function parseText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error('TXT 文件读取失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * 解析 PDF 文件
 */
export async function parsePDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => item.str)
      .join(' ');
    text += pageText + '\n';
  }

  return text.trim();
}

/**
 * 解析 Word (.docx) 文件
 */
export async function parseWord(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

/**
 * 解析 Excel 文件
 */
export async function parseExcel(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  let text = '';
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    text += `【工作表: ${sheetName}】\n${csv}\n\n`;
  });

  return text.trim();
}

/**
 * 解析 CSV 文件
 */
export async function parseCSV(file: File): Promise<string> {
  const text = await parseText(file);
  // 简单格式化 CSV
  const lines = text.split('\n');
  return lines.map(line => line.split(',').join(' | ')).join('\n');
}

/**
 * 根据文件类型自动选择解析器
 */
export async function parseDocument(file: File): Promise<{ text: string; format: string }> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  const parsers: Record<string, { parse: (f: File) => Promise<string>; name: string }> = {
    txt: { parse: parseText, name: 'TXT' },
    md: { parse: parseText, name: 'Markdown' },
    pdf: { parse: parsePDF, name: 'PDF' },
    docx: { parse: parseWord, name: 'Word' },
    xlsx: { parse: parseExcel, name: 'Excel' },
    xls: { parse: parseExcel, name: 'Excel' },
    csv: { parse: parseCSV, name: 'CSV' },
  };

  const parser = parsers[extension];

  if (!parser) {
    throw new Error(`不支持的文件格式: .${extension}`);
  }

  const text = await parser.parse(file);
  return { text, format: parser.name };
}

/**
 * 获取支持的文件格式列表
 */
export function getSupportedFormats(): string[] {
  return ['.txt', '.md', '.pdf', '.docx', '.xlsx', '.xls', '.csv'];
}
