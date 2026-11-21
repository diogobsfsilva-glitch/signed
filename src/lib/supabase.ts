import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
if (!url || !key) throw new Error("Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (.env.local)");

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

export const SUPABASE_URL = url;
export const SUPABASE_ANON_KEY = key;
export const BUCKET = "documents";
