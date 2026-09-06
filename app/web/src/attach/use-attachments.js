import { useCallback, useEffect, useRef, useState } from 'react';
import { useRpc } from '../rpc/rpc-context.jsx';

function reasonFrom(error) {
  return String(error?.message || error || 'image upload failed');
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function useAttachments() {
  const client = useRpc();
  const [attachments, setAttachments] = useState([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const urls = useRef(new Set());

  useEffect(() => () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
  }, []);

  const addFiles = useCallback(async (files) => {
    setError('');
    setUploading(true);
    try {
      for (const file of Array.from(files || [])) {
        const thumbUrl = URL.createObjectURL(file);
        urls.current.add(thumbUrl);
        try {
          const result = await client.call('upload:image', {
            name: file.name,
            mediaType: file.type,
            bytesBase64: bytesToBase64(await file.arrayBuffer()),
          });
          if (result?.ok !== true || !result.path) {
            throw new Error(result?.reason || 'image upload failed');
          }
          setAttachments((current) => [...current, {
            id: crypto.randomUUID(),
            name: file.name,
            path: result.path,
            thumbUrl,
          }]);
        } catch (uploadError) {
          URL.revokeObjectURL(thumbUrl);
          urls.current.delete(thumbUrl);
          setError(reasonFrom(uploadError));
        }
      }
    } finally {
      setUploading(false);
    }
  }, [client]);

  const remove = useCallback((id) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.thumbUrl);
        urls.current.delete(target.thumbUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clearPaths = useCallback((paths) => {
    const sent = new Set(paths);
    setAttachments((current) => current.filter((item) => {
      if (!sent.has(item.path)) return true;
      URL.revokeObjectURL(item.thumbUrl);
      urls.current.delete(item.thumbUrl);
      return false;
    }));
  }, []);

  return { addFiles, attachments, clearPaths, error, remove, uploading };
}

