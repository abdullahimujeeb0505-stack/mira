import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonWebUserStore,
  WebAuthInputError,
  WebUsernameTakenError,
} from "./web-auth.js";

test("web accounts use salted password hashes and case-insensitive usernames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-web-auth-"));
  const path = join(directory, "users.json");
  const store = new JsonWebUserStore(path);
  const password = "correct horse battery";
  try {
    const user = await store.register("Mira_Fan", password);
    assert.equal(user.username, "Mira_Fan");
    assert.ok(user.id);
    assert.deepEqual(await store.authenticate("mira_fan", password), user);
    assert.equal(await store.authenticate("Mira_Fan", "incorrect password"), undefined);
    assert.equal(await store.authenticate("missing_user", password), undefined);

    await assert.rejects(
      () => store.register("mira_fan", "another valid password"),
      WebUsernameTakenError,
    );
    await assert.rejects(
      () => store.register("ab", password),
      WebAuthInputError,
    );
    await assert.rejects(
      () => store.register("valid_name", "short"),
      WebAuthInputError,
    );

    const storedUsers = await readFile(path, "utf8");
    assert.doesNotMatch(storedUsers, new RegExp(password));
    assert.match(storedUsers, /"passwordHash"/);
    assert.match(storedUsers, /"salt"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
