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

const server = new Server(
  { name: "optioncompass-mcp-remote", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- Tool Registration ---
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
        name: "get_user_profile",
        description: "Looks up a user profile by email",
        inputSchema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"]
        }
      }
    ]
  };
});

// --- Tool Execution ---
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
    case "get_user_profile": {
      const email = request.params.arguments?.email;
      if (!email) throw new Error("Email required");
      try {
        const { data, error } = await supabase.from("profiles").select("*").eq("email", email).single();
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

const app = express();
app.use(cors());

// --- API Key Validation Middleware ---
const authenticateAPIKey = async (req, res, next) => {
  // Extract key from query param (e.g., ?key=oc_sk_123) or Bearer header
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
    // Note: In production, querying all users like this could be slow for massive userbases.
    // However, since api keys are in user_metadata, Supabase doesn't easily allow filtering by JSONB in listUsers.
    // The most efficient way is to query the profiles table if we sync api_keys there, but they are in auth.users.
    // For now, we fetch the subset of users (or rely on a database function).
    
    // As a workaround, we can use an RPC or search. For safety, we'll verify it manually or use a secure postgres function.
    // Since we don't have the custom RPC for key validation, we'll query profiles to get user IDs, then check their auth metadata.
    // To make this scalable, you would eventually move api_keys from user_metadata to a dedicated `api_keys` table.
    
    // Simpler scalable workaround: check if *any* user has this key by checking the entire list (paginated).
    // Let's assume you have under 1000 users for this iteration.
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;

    const validUser = users.find(u => {
      const keys = u.user_metadata?.api_keys || [];
      return keys.some(k => k.key === apiKey);
    });

    if (!validUser) {
      return res.status(401).json({ error: "Unauthorized: Invalid API Key." });
    }

    // Attach user to request
    req.user = validUser;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "Internal server authentication error" });
  }
};

let transport;

// Secure SSE Route (Requires ?key=oc_sk_...)
app.get("/mcp", authenticateAPIKey, async (req, res) => {
  console.log(`[MCP] Authorized connection from: ${req.user.email}`);
  transport = new SSEServerTransport("/mcp/messages", res);
  await server.connect(transport);
});

// Secure Message Route
app.post("/mcp/messages", async (req, res) => {
  // Note: Claude Desktop will post to the URL returned by the SSE connection. 
  // We do not require auth on the postback message endpoint because the SSE connection itself is the authenticated channel.
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(500).send("Transport not initialized");
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Secured Option Compass MCP server running on port ${PORT}`);
});
