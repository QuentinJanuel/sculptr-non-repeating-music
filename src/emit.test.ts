import assert from "node:assert/strict";
import { test } from "node:test";
import type { At, CallExpr, Stmt } from "@sculptr/sdk";
import { emit, nameable } from "./emit.ts";
import type { Found, Plan } from "./find.ts";

/**
 * The name "I wanna Demise" gives a track, as a mod receives it.
 *
 * The game is Chinese, built on a Japanese engine, and the sound is called `sound179_侮蔑、嘲笑单`
 * in the author's codepage; by the time the name reaches a mod it has been through a decode that
 * could not read those bytes, so this is what is left of it.
 */
const mangled = "sound179_�����Ц�� ";

let next = 0;
const at = (): At => `entry#s,${(next += 1)},0` as At;

const call = function (name: string, sound: string | null): CallExpr {
  return {
    k: "call",
    kind: "builtin",
    name,
    args: sound === null ? [] : [{ k: "asset", kind: "sound", name: sound }],
  };
};

const found = function (kind: Found["kind"], name: string, sound: string | null): Found {
  const made = call(name, sound);
  return {
    entry: "killPlayer",
    reason: kind === "arm" ? "room" : "death",
    stmt: { k: "call", at: at(), call: made } as Stmt,
    call: made,
    kind,
    sound,
    room: kind === "arm" ? "area1" : null,
  };
};

const plan = function (over: Partial<Plan> = {}): Plan {
  return {
    found: [],
    music: ["snd_bgm", mangled],
    effects: ["sndJump", "snd�"],
    indirect: [],
    ...over,
  };
};

const bodies = (one: Plan): string[] => emit(one).standIns.map((standIn) => standIn.body);

test("what a name has to be to go into generated code", () => {
  assert.ok(nameable("snd_bgm"));
  assert.ok(nameable("_snd1"));
  assert.ok(!nameable(mangled));
  assert.ok(!nameable("侮蔑"));
  assert.ok(!nameable("1st"));
  assert.ok(!nameable("snd bgm"));
});

// The bug this file exists for: the generated script went to a GameMaker 8 compiler that reads
// identifiers as ASCII, so one unwritable name failed the whole launch -- black screen, no game.
test("nothing this mod writes is outside ASCII", () => {
  const content = plan({
    found: [
      found("stopAll", "sound_stop_all", null),
      found("play", "sound_play", "snd_bgm"),
      found("arm", "sound_loop", "snd_bgm"),
    ],
  });
  for (const body of bodies(content)) {
    assert.match(body, /^[\x00-\x7f]*$/u, JSON.stringify(body));
  }
});

test("a track that cannot be named is left out of the guard, not written into it", () => {
  const content = plan({ found: [found("play", "sound_play", "snd_bgm")] });
  assert.deepEqual(bodies(content), ["if (!(sound_isplaying(snd_bgm))) { sound_play(snd_bgm); }"]);
});

test("a sound effect that cannot be named is left playing rather than written down", () => {
  const content = plan({ found: [found("stopAll", "sound_stop_all", null)] });
  assert.deepEqual(bodies(content), ["sound_stop(sndJump);"]);
});

test("a play of a track that cannot be named is left exactly as the game wrote it", () => {
  const content = plan({ found: [found("play", "sound_play", mangled)] });
  assert.deepEqual(emit(content).standIns, []);
});

test("a room arming a track that cannot be named is left alone too", () => {
  const content = plan({ found: [found("arm", "sound_loop", mangled)] });
  assert.deepEqual(emit(content).standIns, []);
});

// Deleting a call needs no name, so this half of the fix still works on those games.
test("a stop of a track that cannot be named is still taken out", () => {
  const content = plan({ found: [found("stopMusic", "sound_stop", mangled)] });
  assert.deepEqual(bodies(content), [""]);
});

test("the sounds it could not name are reported", () => {
  assert.deepEqual(emit(plan()).unnameable, [mangled, "snd�"]);
  assert.deepEqual(emit(plan({ music: ["snd_bgm"], effects: ["sndJump"] })).unnameable, []);
});

test("a game with no nameable music guards nothing and still starts", () => {
  const content = plan({ music: [mangled], found: [found("play", "sound_play", "snd_bgm")] });
  assert.deepEqual(bodies(content), ["if (!(0)) { sound_play(snd_bgm); }"]);
});
