/** Changelog AT-60: "log out other devices" (Supabase Auth, no app SQL). */
import { expect, test } from 'vitest';
import { newOwner, signIn, refresh, logoutOthers, verifySession } from './helpers.js';

test('AT-60 log out other devices: every other session ends, this one stays', async () => {
  const owner = await newOwner();
  const phone = await signIn(owner.email, owner.password);
  const laptop = await signIn(owner.email, owner.password);

  const res = await logoutOthers(phone.access_token);
  expect(res.ok).toBe(true);

  expect((await refresh(laptop.refresh_token)).ok).toBe(false);
  const stillHere = await refresh(phone.refresh_token);
  expect(stillHere.ok).toBe(true);
  const fresh = await stillHere.json() as { access_token: string };
  await expect(verifySession(fresh.access_token)).resolves.toMatchObject({ id: owner.userId });
});
