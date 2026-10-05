// Keep the original PNG/JPEG bytes. Chromium supplies the decoder for other
// formats that Electron nativeImage cannot read, including WEBP, GIF and SVG.
export async function clipboardImageDataURL(src) {
  if (/^data:image\/(png|jpeg);/i.test(src)) return src;
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
