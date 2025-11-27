// =================================================================================
//  Project: eye2-2api (Bun Edition)
//  Version: 4.4.0-bun
//  Codename: Chimera Silent - Universal Compatibility
//  Environment: Bun Runtime + ws package
//
//  Changes:
//  - Removed Web UI (Headless).
//  - Replaced Cloudflare WebSocketPair with 'ws' library for Cookie support.
//  - Implemented standard OpenAI Stream format.
// =================================================================================

import { serve } from "bun";
import WebSocket from "ws"; // Requires: bun add ws

// --- [Part 1: Core Configuration] ---
const CONFIG = {
  PROJECT_NAME: "eye2-2api-bun",
  PROJECT_VERSION: "4.4.0",

  // Env Config
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  PORT: process.env.PORT || 3000,

  // Upstream
  API_BASE: "https://sio.eye2.ai",
  ORIGIN: "https://www.eye2.ai",
  
  // Model List
  MODELS: [
    "chat_gpt", "claude", "gemini", "grok_ai", "mistral_ai", 
    "qwen", "deepseek", "llama", "ai21", "amazon_nova", "glm", "moonshot"
  ],
  DEFAULT_MODEL: "chat_gpt",

  // Headers for HTTP Requests
  HEADERS: {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    "Origin": "https://www.eye2.ai",
    "Referer": "https://www.eye2.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  }
};

// --- [Part 2: Server Entry] ---
console.log(`👁️  ${CONFIG.PROJECT_NAME} v${CONFIG.PROJECT_VERSION} is active.`);
console.log(`🔌 Listening on port: ${CONFIG.PORT}`);

serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. Health Check
    if (url.pathname === '/') {
        return new Response(JSON.stringify({
            status: "alive",
            service: CONFIG.PROJECT_NAME,
            models: CONFIG.MODELS
        }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // 3. API Routes
    if (url.pathname.startsWith('/v1/')) return handleApi(request);

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
});

// --- [Part 3: API Routing] ---
async function handleApi(request) {
  const authHeader = request.headers.get('Authorization');
  const apiKey = CONFIG.API_MASTER_KEY;

  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.substring(7) !== apiKey) {
      return createErrorResponse('Unauthorized', 401, 'unauthorized');
    }
  }

  const url = new URL(request.url);
  if (url.pathname === '/v1/models') return handleModelsRequest();
  if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request);
  
  return createErrorResponse('Not Found', 404, 'not_found');
}

function handleModelsRequest() {
  const models = CONFIG.MODELS.map(id => ({
    id: id, object: "model", created: Math.floor(Date.now()/1000), owned_by: "eye2-bun"
  }));
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

// --- [Part 4: Core Logic (Socket.IO Bridge)] ---
async function handleChatCompletions(request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Helper: Send SSE Data
  const sendSSE = async (data) => {
    try { await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch(e) {}
  };

  (async () => {
    let wsClient = null;
    let isFinished = false;

    try {
      const body = await request.json();
      const messages = body.messages || [];
      const model = body.model || CONFIG.DEFAULT_MODEL;
      const requestId = `chatcmpl-${crypto.randomUUID()}`;

      // --- Step 1: Get Share ID ---
      const lastMessage = messages[messages.length - 1]?.content || "Hello";
      
      let shareId;
      try {
          shareId = await getShareId(lastMessage);
      } catch (e) {
          // Retry logic simple
          console.warn(`[Retry] Fetching ShareID...`);
          shareId = await getShareId("Hello");
      }
      
      if (!shareId) throw new Error("Failed to obtain Share ID");

      // --- Step 2: HTTP Handshake (Get SID & Cookie) ---
      const { sid, cookie } = await socketHttpHandshake();
      
      // --- Step 3: WebSocket Connection (Using 'ws' for Header support) ---
      const wsUrl = `${CONFIG.API_BASE}/socket.io/?EIO=4&transport=websocket&sid=${sid}`;
      
      const wsHeaders = {
        "User-Agent": CONFIG.HEADERS["User-Agent"],
        "Origin": CONFIG.ORIGIN,
        "Cookie": cookie || "" // Crucial for session continuity
      };

      // Connect using 'ws' library
      wsClient = new WebSocket(wsUrl, { headers: wsHeaders });

      // --- Step 4: Event Handling ---
      
      wsClient.on('open', () => {
        wsClient.send('2probe'); // Engine.io Probe
      });

      wsClient.on('message', async (data) => {
        try {
            let packet = data.toString();
            
            // Heartbeat
            if (packet === '2') { wsClient.send('3'); return; }

            // Handshake Ack
            if (packet === '3probe') {
                wsClient.send('5'); // Upgrade
                
                // Auth & Request (Delayed slightly to ensure sequence)
                setTimeout(() => { wsClient.send(`40${JSON.stringify({ shareId })}`); }, 50);
                setTimeout(() => {
                    const reqPayload = ["llm:conversation:request", { "shareId": shareId, "llmList": [model] }];
                    wsClient.send(`42${JSON.stringify(reqPayload)}`);
                }, 100);
                return;
            }

            // Business Data
            if (packet.startsWith('42')) {
                const jsonStr = packet.substring(2);
                const [eventName, payload] = JSON.parse(jsonStr);

                if (eventName === 'llm:conversation:response') {
                    if (payload.llm === model && payload.data?.data) {
                        const content = payload.data.data;
                        await sendSSE({
                            id: requestId,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now()/1000),
                            model: model,
                            choices: [{ index: 0, delta: { content }, finish_reason: null }]
                        });
                    }
                } else if (eventName === 'llm:conversation:end') {
                    if (!payload.llm || payload.llm === model) {
                        isFinished = true;
                        await sendSSE({
                            id: requestId,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now()/1000),
                            model: model,
                            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                        });
                        await writer.write(encoder.encode('data: [DONE]\n\n'));
                        wsClient.close();
                        await writer.close();
                    }
                }
            }
        } catch (e) {
            console.error("WS Message Parse Error:", e);
        }
      });

      wsClient.on('error', async (e) => {
         throw new Error(`WS Error: ${e.message}`);
      });

      wsClient.on('close', async () => {
        if (!isFinished) {
            try { await writer.close(); } catch(e) {}
        }
      });

    } catch (e) {
      console.error("[Fatal]", e.message);
      // Send standard error to client
      await sendSSE({
           error: {
               message: e.message || "Internal Server Error",
               type: "internal_error",
               code: 500
           }
      });
      try { await writer.close(); } catch(err) {}
      if (wsClient) try { wsClient.close(); } catch(err) {}
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
  });
}

// --- [Part 5: Helpers] ---

async function getShareId(text) {
  const url = `${CONFIG.API_BASE}/api/v1/conversation/share-id`;
  const res = await fetch(url, {
    method: "POST",
    headers: CONFIG.HEADERS,
    body: JSON.stringify({ text })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ShareID Failed (${res.status})`);
  }
  
  const data = await res.json();
  return data.share_id;
}

async function socketHttpHandshake() {
  const t = Math.random().toString(36).substring(2);
  const url = `${CONFIG.API_BASE}/socket.io/?EIO=4&transport=polling&t=${t}`;
  
  const res = await fetch(url, { method: "GET", headers: CONFIG.HEADERS });
  
  if (!res.ok) throw new Error(`Handshake Failed (${res.status})`);
  
  const cookie = res.headers.get("set-cookie");
  const text = await res.text();
  const jsonStartIndex = text.indexOf('{');
  
  if (jsonStartIndex === -1) throw new Error("Invalid Handshake Response");
  
  const jsonStr = text.substring(jsonStartIndex);
  const data = JSON.parse(jsonStr);
  
  return { sid: data.sid, cookie };
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
