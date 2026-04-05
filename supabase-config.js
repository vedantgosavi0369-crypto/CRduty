/**
 * @file supabase-config.js
 * @description Supabase project configuration.
 *
 * ─────────────────────────────────────────────────────────
 *  HOW TO FILL THIS IN
 * ─────────────────────────────────────────────────────────
 *  1. Create a project at https://supabase.com
 *  2. Once the project is provisioned, go to Project Settings -> API
 *  3. Copy your "Project URL" and paste it in SUPABASE_URL
 *  4. Copy your "anon" "public" key and paste it in SUPABASE_ANON_KEY
 *  5. Copy the SQL from the `schema.sql` artifact and run it in the
 *     Supabase dashboard (SQL Editor -> New query -> Paste -> Run)
 * ─────────────────────────────────────────────────────────
 */

const SUPABASE_URL = 'https://hsprjxfwbkhwjvujqqnd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzcHJqeGZ3Ymtod2p2dWpxcW5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMDU3NDEsImV4cCI6MjA5MDg4MTc0MX0.-yrms3BarYoS9xAqoG_vhdCSCz6CxxAElmhU6wswGBY';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
