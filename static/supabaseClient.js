import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  "YOUR_PROJECT_URL",
  "YOUR_ANON_KEY"
)
