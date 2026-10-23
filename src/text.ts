import type { TextLine } from './model.ts';

export type MeasureText = (text: string, size: number, bold?: boolean) => number;

export function wrapText(text: string, width: number, size: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && measure(`${line} ${word}`, size) > width) {
        lines.push(line);
        line = '';
      }
      if (measure(word, size) > width) {
        if (line) { lines.push(line); line = ''; }
        for (const character of word) {
          if (line && measure(line + character, size) > width) {
            lines.push(line);
            line = '';
          }
          line += character;
        }
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function nodeLines(label: string, width: number, detail: boolean, measure: MeasureText): TextLine[] {
  const paragraphs = label.split('\n');
  if (!detail) return wrapText(paragraphs[0], width, 12.5, measure).map(text => ({ text, secondary: false }));
  return paragraphs.flatMap((paragraph, index) =>
    wrapText(paragraph, width, 12.5, measure).map(text => ({ text, secondary: index > 0 })));
}

export const approximateMeasure: MeasureText = (text, size) => [...text]
  .reduce((sum, char) => sum + (/[\u2e80-\uffff]/u.test(char) ? size : /[il.,:;!'| ]/.test(char) ? size * 0.3 : size * 0.59), 0);

export function browserMeasure(): MeasureText {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('A 2D canvas context is required to measure diagram text.');
  return (text, size, bold = false) => {
    context.font = `${bold ? 600 : 500} ${size}px Arial, sans-serif`;
    return context.measureText(text).width;
  };
}
