'use strict';
function folderLabel(folder) {
  const value = String(folder || '').replace(/\\/g, '/');
  if (/^[a-z]:\/+$/i.test(value)) return value.slice(0, 2) + '/';
  const parts = value.split('/').filter(Boolean);
  // A network label needs its server and share, even for a deep folder.
  if (value.startsWith('//')) return '//' + parts.join('/');
  return parts.length ? parts.slice(-2).join('/') : value.startsWith('/') ? '/' : '';
}
module.exports = { folderLabel };
