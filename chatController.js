import { ChatService } from './chatService.js';
import { supabase } from './supabase.js';

const checkChatQuota = async (userId) => {
  if (!userId) return { allowed: false, limit: 0, currentCount: 0 };

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, role')
    .eq('id', userId)
    .single();

  const tier = profile?.subscription_tier || 'free';
  const role = profile?.role || 'user';

  if (role === 'admin' || role === 'super_admin' || tier === 'platinum') {
    return { allowed: true };
  }

  let limit = 0;
  if (tier === 'gold') limit = 25;
  if (tier === 'silver' || tier === 'fnf') limit = 10;

  if (limit === 0) return { allowed: false, limit: 0, currentCount: 0 };

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: sessions } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('user_id', userId);

  if (!sessions || sessions.length === 0) return { allowed: true, limit, currentCount: 0 };

  const sessionIds = sessions.map(s => s.id);

  const { count, error } = await supabase
    .from('chat_messages')
    .select('*', { count: 'exact', head: true })
    .in('session_id', sessionIds)
    .eq('sender', 'user')
    .gte('created_at', sevenDaysAgo.toISOString());

  if (error) {
    console.error("Quota check error:", error);
    return { allowed: true }; // Fail open
  }

  return { allowed: count < limit, limit, currentCount: count || 0 };
};

export const handleChatMessage = async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    let { userId } = req.body;

    if (!sessionId || !message) {
      res.status(400).json({ error: 'sessionId and message are required' });
      return;
    }

    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('id, user_id, status')
      .eq('id', sessionId)
      .single();

    if (sessionError && sessionError.code !== 'PGRST116') {
      console.error("Session Error Details:", sessionError);
      res.status(500).json({ error: 'Failed to verify session' });
      return;
    }

    if (!session) {
      const { data: newSession, error: createError } = await supabase
        .from('chat_sessions')
        .insert({ id: sessionId, user_id: userId || null })
        .select()
        .single();
        
      if (createError) {
        res.status(500).json({ error: 'Failed to create chat session' });
        return;
      }
    } else {
      if (!session.user_id && userId) {
        await supabase.from('chat_sessions').update({ user_id: userId }).eq('id', sessionId);
      } else {
        userId = session.user_id;
      }
    }

    const quota = await checkChatQuota(userId);
    if (!quota.allowed) {
      const upgradeMsg = quota.limit === 0 
        ? "AI Helpdesk Chat is a premium feature. Please upgrade your Option Compass subscription to chat with me!"
        : `You have reached your limit of ${quota.limit} AI messages per week for your current plan. Please upgrade your subscription to continue chatting!`;
      
      // Save user message to history
      await supabase.from('chat_messages').insert({ session_id: sessionId, sender: 'user', content: message });
      // Save AI warning to history
      await ChatService.saveAiResponse(sessionId, upgradeMsg);
      
      res.json({ response: upgradeMsg, escalated: false, quotaExceeded: true });
      return;
    }

    const response = await ChatService.handleMessage(sessionId, userId, message);
    res.json(response);

  } catch (error) {
    console.error("Chat Controller Error:", error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch chat history' });
      return;
    }

    res.json({ messages });
  } catch (error) {
    console.error("Chat History Error:", error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getUserActiveSession = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const { data: session, error } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error("Fetch User Session Error:", error);
      res.status(500).json({ error: 'Failed to fetch user session' });
      return;
    }

    if (session) {
      const { data: messages, error: messagesError } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('session_id', session.id)
        .order('created_at', { ascending: true });
        
      if (messagesError) {
        console.error("Fetch User Session Messages Error:", messagesError);
        res.status(500).json({ error: 'Failed to fetch session messages' });
        return;
      }
      
      const formattedHistory = messages.map((msg) => ({
        id: msg.id,
        text: msg.content,
        sender: msg.sender
      }));
        
      res.json({ sessionId: session.id, messages: formattedHistory });
    } else {
      res.json({ sessionId: null, messages: [] });
    }
  } catch (error) {
    console.error("getUserActiveSession Error:", error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
