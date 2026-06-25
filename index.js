import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

// Use Service Role key to allow searching through user metadata securely
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());

// --- API Key Validation Middleware ---
const authenticateAPIKey = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const queryKey = req.query.key;
  
  let apiKey = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.split(' ')[1];
  } else if (queryKey) {
    apiKey = queryKey;
  }

  if (!apiKey || !apiKey.startsWith('oc_sk_')) {
    return res.status(401).json({ error: "Unauthorized: Missing or invalid API Key format." });
  }

  try {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;

    const validUser = users.find(u => {
      const keys = u.user_metadata?.api_keys || [];
      return keys.some(k => k.key === apiKey);
    });

    if (!validUser) {
      return res.status(401).json({ error: "Unauthorized: Invalid API Key." });
    }

    req.user = validUser;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "Internal server authentication error" });
  }
};

// Map to store active transport sessions
const sessions = new Map();

// Secure SSE Route (Requires ?key=oc_sk_...)
app.get("/mcp", authenticateAPIKey, async (req, res) => {
  const user = req.user;
  console.log(`[MCP] Authorized connection from: ${user.email}`);

  // 1. Create a personalized Server instance for this user
  const server = new Server(
    { name: `optioncompass-mcp-${user.id}`, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // 2. Register tools with baked-in user context
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_todays_picks",
          description: "Retrieves the active trade picks from the tracked_picks table",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number", default: 10 } }
          }
        },
        {
          name: "get_my_profile",
          description: "Retrieves your own user profile, subscription tier, and available credits. (Does not require an email argument)",
          inputSchema: {
            type: "object",
            properties: {}
          }
        }
      ]
    };
  });

  // 3. Handle personalized tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case "get_todays_picks": {
        const limit = request.params.arguments?.limit || 10;
        const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        if (nyTime.getDay() >= 1 && nyTime.getDay() <= 5 && (nyTime.getHours() < 9 || (nyTime.getHours() === 9 && nyTime.getMinutes() < 45))) {
          return { content: [{ type: "text", text: "Can only show today's picks 15 mins after opening bell." }], isError: true };
        }
        try {
          const { data, error } = await supabase.from("tracked_picks").select("*").order("created_at", { ascending: false }).limit(limit);
          if (error) throw error;
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
      case "get_my_profile": {
        try {
          // Look up profile strictly using the authenticated user's ID
          const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
          if (error) throw error;
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
      default:
        throw new Error("Unknown tool");
    }
  });

  // 4. Initialize Transport and link to session
  const transport = new SSEServerTransport("/mcp/messages", res);
  await server.connect(transport);
  
  // Store the transport with its auto-generated session ID
  sessions.set(transport.sessionId, transport);

  res.on('close', () => {
    sessions.delete(transport.sessionId);
    console.log(`[MCP] Disconnected: ${user.email}`);
  });
});

// Secure Message Route
app.post("/mcp/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);
  
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send("Session not found or expired");
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Secured Multi-User Option Compass MCP server running on port ${PORT}`);
});
