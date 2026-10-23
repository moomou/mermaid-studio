export function exportSvg(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true);
  if (!(copy instanceof SVGSVGElement)) throw new Error('The diagram is not an SVG element.');
  copy.style.removeProperty('transform');
  copy.style.removeProperty('transform-origin');
  copy.style.removeProperty('position');
  copy.style.removeProperty('max-width');
  for (const item of copy.querySelectorAll('.is-selected, .is-dimmed')) {
    item.classList.remove('is-selected', 'is-dimmed');
  }
  for (const item of copy.querySelectorAll('[tabindex]')) item.removeAttribute('tabindex');
  return new XMLSerializer().serializeToString(copy);
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function filename(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'diagram';
}

export async function pngBlob(svg: SVGSVGElement): Promise<Blob> {
  if (svg.querySelector('foreignObject')) throw new Error('PNG export is available for structured diagrams. Use SVG export for native Mermaid.');
  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  if (!(width > 0 && height > 0)) throw new Error('The diagram has no valid export dimensions.');
  const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PNG export requires a 2D canvas context.');
  const data = exportSvg(svg);
  const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not encode this diagram as PNG.')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}
