// Keep the original PNG/JPEG bytes. Chromium supplies the decoder for other
// formats that Electron nativeImage cannot read, including WEBP, GIF and SVG.
export async function clipboardImageDataURL(src) {
  if (/^data:image\/(png|jpeg);/i.test(src)) return src;
  // A transcript image served by harbor-image:// keeps its original PNG/JPEG
  // bytes too: fetch them rather than redrawing through a canvas.
  if (/^harbor-image:/i.test(src)) {
    const blob = await (await fetch(src)).blob();
    if (/^image\/(png|jpeg)$/i.test(blob.type)) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}
