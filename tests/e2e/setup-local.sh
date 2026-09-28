#!/usr/bin/env bash
# Prepares a LOCAL Supabase stack (Docker) for the browser E2E tests.
# NEVER run this against your real project.
#   npx supabase start
#   bash tests/e2e/setup-local.sh
# Uses the standard local-development keys printed by `npx supabase status`.
set -euo pipefail
API=${API:-http://127.0.0.1:54321}
DB=${E2E_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
SR=$(npx supabase status -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])")
ANON=$(npx supabase status -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['ANON_KEY'])")

echo "1) admin user + bootstrap"
curl -sS -X POST "$API/auth/v1/admin/users" -H "apikey: $SR" -H "Authorization: Bearer $SR" -H "Content-Type: application/json" \
  -d '{"email":"coordinator@school.test","password":"AdminPass-2026!","email_confirm":true}' >/dev/null
psql "$DB" -qc "select public.make_admin('coordinator@school.test')"

echo "2) catalogue + sample snacks"
psql "$DB" -q -f supabase/data/bazaar_catalog_from_original_pos.sql
psql "$DB" -q -f supabase/data/sample_snacks.sql

echo "3) cashiers through the admin-users Edge Function"
AT=$(curl -sS -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"coordinator@school.test","password":"AdminPass-2026!"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
for spec in "bazaar1:Bazaar Cashier:BAZAAR:482913" "snacks1:Snacks Cashier:SNACKS:736205"; do
  IFS=: read -r U N S P <<<"$spec"
  curl -sS -X POST "$API/functions/v1/admin-users" -H "apikey: $ANON" -H "Authorization: Bearer $AT" -H "Content-Type: application/json" \
    -d "{\"action\":\"create_user\",\"username\":\"$U\",\"full_name\":\"$N\",\"role\":\"cashier\",\"section\":\"$S\",\"email\":\"$U@cashiers.school-pos.app\",\"pin\":\"$P\"}"
  echo
done
echo "Done. Put the local URL + ANON key in .env.local, run 'npm run dev', then the e2e scripts."
