import { describe, it, beforeAll, afterAll } from 'vitest';
import { TEST_URL, createTestDatabase } from './db-helpers.js';
import { checkStaffRoles } from './staff-roles.cases.js';

(TEST_URL ? describe : describe.skip)('Staff roles and supplier lists', () => {
  let pool;
  beforeAll(async () => { pool = await createTestDatabase('pos_roles_test'); }, 60000);
  afterAll(async () => { await pool?.end(); });
  it('enforces the permission matrix and the availability/receipt workflow', async () => {
    await checkStaffRoles(pool);
  }, 60000);
});
