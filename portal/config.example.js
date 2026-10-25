/* Copy to portal/config.js (which is gitignored) and fill in. The anon key is the PUBLIC publishable key;
 * never put the service-role / secret key here.
 *
 * Demo (no server):   window.CLA_PORTAL_CONFIG = { mode: "mock" };
 * Supabase:           window.CLA_PORTAL_CONFIG = { mode: "supabase", url: "https://YOUR-PROJECT-REF.supabase.co", anonKey: "YOUR-ANON-OR-PUBLISHABLE-KEY" };
 */
window.CLA_PORTAL_CONFIG = { mode: "mock" };
