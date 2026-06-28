import { GoogleGenAI } from '@google/genai';
import { supabase } from './supabase.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// System Instruction for the Helpdesk AI
const SYSTEM_INSTRUCTION = `You are the Option Compass AI Helpdesk Assistant.
Your goal is to help users with their questions regarding the platform, subscription tiers (Silver, Gold, Platinum), and app usage.
Before taking action to escalate or search the knowledge base, IF the user's request is vague or broad, you MUST ask clarifying questions to fully understand their needs and get a full scope of their issue.
If a user is having trouble logging in or needs a password reset, guide them to the login screen's "Forgot Password" link.
If a user asks for a refund, or is extremely frustrated, or explicitly asks to speak to a human, you MUST use the escalate_to_human tool.
If you cannot answer a user's question or resolve their issue, offer to escalate them to a human agent. If they agree, use the escalate_to_human tool.
Be concise, polite, and helpful.`;

const callGeminiWithRetry = async (params, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e) {
      if (i === retries - 1 || (e.status !== 503 && e.status !== 429)) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i))); // exponential backoff
    }
  }
};

function getMarketHoliday(date) {
  // Simple approximation for this port
  return null;
}

export class ChatService {
  static async handleMessage(sessionId, userId, message) {
    // 1. Fetch previous messages for this session
    const { data: previousMessages, error: fetchError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (fetchError) throw new Error('Failed to fetch chat history: ' + fetchError.message);

    // 2. Build conversation history for Gemini
    const contents = previousMessages.map((msg) => ({
      role: msg.sender === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // Add the new message
    contents.push({
      role: 'user',
      parts: [{ text: message }]
    });

    // 3. Save the new user message to DB
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      sender: 'user',
      content: message
    });

    // 4. Check if we need to escalate based on session status
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();

    let alreadyEscalated = session?.status === 'human_escalated';
    let newlyEscalated = false;

    if (alreadyEscalated) {
      try {
        const slackWebhook = process.env.SLACK_WEBHOOK_URL;
        if (slackWebhook) {
          let userInfo = 'Anonymous User';
          if (userId) {
            const { data: user } = await supabase.auth.admin.getUserById(userId);
            if (user?.user) userInfo = user.user.email || 'Unknown Email';
          }
          await axios.post(slackWebhook, {
            text: `📝 *New Message on Escalated Ticket*\n*User:* ${userInfo}\n*Session ID:* ${sessionId}\n*Message:* "${message}"`
          });
        }
        
        const phoneMatch = message.match(/[0-9\-\(\)\s\+]{10,}/);
        if (phoneMatch) {
          await supabase.from('support_tickets').update({ phone_number_provided: phoneMatch[0].trim() }).eq('session_id', sessionId);
        }
      } catch (e) {
        console.error("Slack notification failed", e);
      }
    }

    // 5. Fetch active picks count and call Gemini
    try {
      const { count: activePicksCount } = await supabase
        .from('option_picks')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active');

      const now = new Date();
      const dateString = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      
      const isWeekend = now.getDay() === 0 || now.getDay() === 6;
      const holiday = getMarketHoliday(now);
      
      let marketStatus = "OPEN (Regular Trading Day)";
      if (isWeekend) marketStatus = "CLOSED (Weekend)";
      else if (holiday) marketStatus = `CLOSED (Holiday: ${holiday})`;
      
      const noPicksContext = (activePicksCount === 0) 
        ? `\n- CRITICAL RULE: If the user asks why there are no picks today, you MUST explain it using the 'Market Status' context below. If it's a weekend or holiday, explicitly state that the market is closed.` 
        : "";

      const escalationContext = alreadyEscalated ? "\n- Escalation Status: This session is ALREADY escalated to a human agent. You MUST still try to answer the user's current question using the knowledge base. Do NOT just say 'a human will respond shortly'. Provide a real answer if possible." : "";

      const dynamicInstruction = `${SYSTEM_INSTRUCTION}
      
Current System Context:
- Today's Date: ${dateString}
- Market Status: ${marketStatus}
- Active Option Picks Currently In System: ${activePicksCount || 0}${noPicksContext}
- User Status: ${userId ? 'Authenticated (Logged in)' : 'Unauthenticated (Guest)'}${escalationContext}

IMPORTANT ESCALATION RULES:
1. If the user is Unauthenticated (Guest), before you call escalate_to_human, you MUST ask them for their email address and/or phone number. Tell them we cannot reach out to them without it. Do NOT call the escalate_to_human tool until they have provided contact info or explicitly refused.
2. If the user is Authenticated, you already have their email, so you can call escalate_to_human immediately.`;

      const response = await callGeminiWithRetry({
        model: 'gemini-2.5-flash',
        contents,
        config: {
          systemInstruction: dynamicInstruction,
          tools: [{
            functionDeclarations: [
              {
                name: 'escalate_to_human',
                description: 'Escalates the chat to a human agent. Use this when the user asks for a refund, is very frustrated, or explicitly asks for a human.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    reason: {
                      type: 'STRING',
                      description: 'The reason for escalation (e.g. "Refund request", "User frustrated")'
                    },
                    phone_number: {
                      type: 'STRING',
                      description: 'The user\'s phone number, if they provided one in the chat.'
                    },
                    email: {
                      type: 'STRING',
                      description: 'The user\'s email address, if they provided one in the chat.'
                    }
                  },
                  required: ['reason']
                }
              },
              {
                name: 'search_knowledge_base',
                description: 'Searches the Option Compass knowledge base for answers regarding tier plans (Silver, Gold, Platinum) or how to use the app.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    query: {
                      type: 'STRING',
                      description: 'The search query'
                    }
                  },
                  required: ['query']
                }
              }
            ]
          }]
        }
      });

      const functionCall = response.functionCalls?.[0];
      
      if (functionCall) {
        if (functionCall.name === 'escalate_to_human') {
          newlyEscalated = true;
          const args = functionCall.args;
          return await this.executeEscalation(sessionId, userId, args.reason, message, args.phone_number, args.email);
        } else if (functionCall.name === 'search_knowledge_base') {
          const args = functionCall.args;
          return await this.executeKnowledgeSearch(sessionId, contents, args.query, newlyEscalated);
        }
      }

      const responseText = response.text || "I'm having trouble understanding right now. Can I help you with anything else?";
      await this.saveAiResponse(sessionId, responseText);
      return { response: responseText, escalated: newlyEscalated };

    } catch (error) {
      console.error("Gemini API Error:", error);
      
      try {
        const slackWebhook = process.env.SLACK_WEBHOOK_URL;
        if (slackWebhook) {
          await axios.post(slackWebhook, {
            text: `⚠️ *Critical AI Error*\n*Session ID:* ${sessionId}\nThe AI Chatbot crashed with an error: \`${error.message}\``
          });
        }
      } catch (e) {
        console.error("Failed to send crash notification to Slack", e);
      }

      const fallback = "I apologize, but my systems are currently running slowly. Could you please provide some more details about your request so I can assist you better when I reconnect?";
      await this.saveAiResponse(sessionId, fallback);
      return { response: fallback, escalated: newlyEscalated };
    }
  }

  static async executeEscalation(sessionId, userId, reason, userMessage, phoneNumber, providedEmail) {
    await supabase
      .from('chat_sessions')
      .update({ status: 'human_escalated' })
      .eq('id', sessionId);

    await supabase
      .from('support_tickets')
      .insert({
        session_id: sessionId,
        user_id: userId || null,
        status: 'open',
        summary: reason,
        phone_number_provided: phoneNumber || null
      });

    try {
      const embedResult = await ai.models.embedContent({
        model: 'text-embedding-004',
        contents: userMessage
      });
      const embedding = embedResult.embeddings?.[0]?.values;
      if (embedding) {
        await supabase.from('unanswered_questions').insert({
          session_id: sessionId,
          question: userMessage,
          embedding: `[${embedding.join(',')}]`
        });
      }
    } catch (e) {
      console.error("Failed to log unanswered question embedding", e);
    }

    try {
      const slackWebhook = process.env.SLACK_WEBHOOK_URL;
      if (slackWebhook) {
        let userInfo = 'Anonymous User';
        if (userId) {
          const { data: user } = await supabase.auth.admin.getUserById(userId);
          if (user?.user) userInfo = user.user.email || 'Unknown Email';
        } else if (providedEmail || phoneNumber) {
          userInfo = `Guest (Email: ${providedEmail || 'None'}, Phone: ${phoneNumber || 'None'})`;
        }

        await axios.post(slackWebhook, {
          text: `🚨 *New Support Escalation*\n*User:* ${userInfo}\n*Reason:* ${reason}\n*Session ID:* ${sessionId}\n*Phone provided:* ${phoneNumber || 'No'}\nPlease review in the dashboard.`
        });
      }
    } catch (e) {
      console.error("Slack notification failed", e);
    }

    const responseText = "I have escalated your request to our support team. We will reach out to you via email shortly. If you prefer a phone call, please let me know your best phone number.";
    await this.saveAiResponse(sessionId, responseText);
    return { response: responseText, escalated: true };
  }

  static async executeKnowledgeSearch(sessionId, contents, query, isEscalated = false) {
    const { data: articles } = await supabase
      .from('knowledge_base_articles')
      .select('title, content')
      .textSearch('content', query.split(' ').join(' | '), { type: 'websearch' })
      .limit(3);

    const contextText = articles && articles.length > 0 
      ? articles.map(a => `Title: ${a.title}\nContent: ${a.content}`).join('\n\n')
      : "No specific articles found in the knowledge base.";

    const contextPrompt = `Based on the user's question, here is relevant information from our knowledge base:\n${contextText}\n\nPlease answer the user's question accurately using ONLY this information. If the answer isn't in the knowledge base, say so gracefully.`;
    
    contents.push({
      role: 'model',
      parts: [{
        functionCall: { name: 'search_knowledge_base', args: { query } }
      }]
    });
    
    contents.push({
      role: 'user',
      parts: [{
        functionResponse: { name: 'search_knowledge_base', response: { result: contextPrompt } }
      }]
    });

    const response = await callGeminiWithRetry({
      model: 'gemini-2.5-flash',
      contents,
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });

    const responseText = response.text || "I couldn't find a good answer in our knowledge base.";
    await this.saveAiResponse(sessionId, responseText);
    return { response: responseText, escalated: isEscalated };
  }

  static async saveAiResponse(sessionId, text) {
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      sender: 'ai',
      content: text
    });
  }
}
