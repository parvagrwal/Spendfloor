import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  chmod,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
test("concurrent generation has one winner; exports are exclusive and restricted by role and mode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sf-custody-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (file: string, ...args: string[]) =>
    exec(process.execPath, ["--import", "tsx", `sdk/${file}.ts`, ...args], {
      env: { ...process.env, SPENDFLOOR_KEYS_DIR: dir },
    });
  const gen = () =>
    run("gen-key", "--machine", "owner", "--role", "owner", "--chain", "sol");
  const attempts = await Promise.allSettled([gen(), gen()]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  const output = join(dir, "export");
  await run("sol-key-to-bare", "owner", output);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const orig = await readFile(output);
  await assert.rejects(run("sol-key-to-bare", "owner", output));
  assert.ok(orig.equals(await readFile(output)));
  await chmod(join(dir, "sol-owner.json"), 0o644);
  await assert.rejects(
    run("sol-key-to-bare", "owner", join(dir, "second")),
    /permissions/,
  );
  await writeFile(join(dir, "MACHINE"), "agent\n");
  await assert.rejects(
    run("sol-key-to-bare", "owner", join(dir, "third")),
    /role not permitted/,
  );
});
