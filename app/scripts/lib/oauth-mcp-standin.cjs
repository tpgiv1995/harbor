'use strict';

// A throwaway MCP server that needs an OAuth sign-in, for proving Harbor's
// Connections sign-in end to end against the REAL Claude CLI without touching
// any connector someone actually uses (scripts/drive-mcp-signin-win.js).
//
// Loopback only. It is its own authorization server: protected-resource and
// authorization-server metadata (RFC 9728 / RFC 8414), dynamic client
// registration (RFC 7591), an /authorize that approves at once by redirecting
// to the client's redirect_uri with a code (the drive plays the browser), a
// PKCE S256 token endpoint, and a Streamable HTTP MCP endpoint that answers 401
// with a resource_metadata pointer until it sees a token it issued. Two tools.
// `revokeAll()` makes every issued token invalid, so a session's next
// reconnect reads "needs authentication" again.

const http = require('node:http');
const crypto = require('node:crypto');

const TOOLS = [
  { name: 'standin_ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } },
  { name: 'standin_echo', description: 'Echoes its text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

function startOAuthMcpStandin({ port = 0 } = {}) {
  const clients = new Map();
  const codes = new Map();
  const tokens = new Set();
  const log = [];
  let base = null;
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    log.push(`${req.method} ${url.pathname}`);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse((await readBody(req)) || '{}');
      const clientId = `standin-${crypto.randomUUID()}`;
      clients.set(clientId, meta);
      return json(res, 201, { ...meta, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: 'none' });
    }
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const code = crypto.randomUUID();
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), clientId: url.searchParams.get('client_id'), redirect });
      const to = new URL(redirect);
      to.searchParams.set('code', code);
      if (url.searchParams.get('state')) to.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'refresh_token') {
        const access = `tok-${crypto.randomUUID()}`;
        tokens.add(access);
        return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: form.get('refresh_token') });
      }
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const verifier = form.get('code_verifier') || '';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!entry || (entry.challenge && entry.challenge !== challenge)) return json(res, 400, { error: 'invalid_grant' });
      const access = `tok-${crypto.randomUUID()}`;
      tokens.add(access);
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: `ref-${crypto.randomUUID()}` });
    }
    if (url.pathname === '/mcp') {
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      if (!auth || !tokens.has(auth)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      if (req.method === 'GET') { res.writeHead(405); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      const body = JSON.parse((await readBody(req)) || 'null');
      const answer = (msg) => {
        if (msg.id === undefined) return null;
        if (msg.method === 'initialize') {
          return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'harbor-oauth-standin', version: '1.0.0' } } };
        }
        if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
        if (msg.method === 'tools/call') return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: msg.params?.name === 'standin_ping' ? 'pong' : String(msg.params?.arguments?.text || '') }] } };
        if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } };
      };
      const replies = (Array.isArray(body) ? body : [body]).map(answer).filter(Boolean);
      if (!replies.length) { res.writeHead(202); return res.end(); }
      return json(res, 200, Array.isArray(body) ? replies : replies[0], { 'mcp-session-id': 'standin-session' });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${base}/mcp`,
        base,
        log,
        toolNames: TOOLS.map((t) => t.name),
        tokensIssued: () => tokens.size,
        revokeAll: () => tokens.clear(),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startOAuthMcpStandin };
