import { supabase } from './supabase.js';

async function test() {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, user_id, status')
    .eq('id', 'test1')
    .single();

  console.log("Data:", data);
  console.log("Error:", error);
}

test();
