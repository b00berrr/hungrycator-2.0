// =====================================================================
//  db.js: połączenie z bazą Supabase
// =====================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// Czy w config.js są już prawdziwe dane?
export const CONFIG_OK = SUPABASE_URL.startsWith('https://') && !SUPABASE_KEY.startsWith('WKLEJ');

// Bierzemy sam adres projektu, nawet jeśli ktoś wkleił go z końcówką /rest/v1/
export const sb = CONFIG_OK ? createClient(new URL(SUPABASE_URL).origin, SUPABASE_KEY.trim()) : null;
