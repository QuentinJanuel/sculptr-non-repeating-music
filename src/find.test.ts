import assert from "node:assert/strict";
import { test } from "node:test";
import type { At, Block, Expr, GameContent, Stmt } from "@sculptr/sdk";
import { plan } from "./find.ts";

/** A token, which only has to be unique and present: nothing here reads what is in one. */
let next = 0;
const at = (): At => `entry#s,${(next += 1)},0` as At;

const call = (name: string, ...args: Expr[]): Stmt => ({
  k: "call",
  at: at(),
  call: { k: "call", kind: "builtin", name, args },
});
const script = (name: string, ...args: Expr[]): Stmt => ({
  k: "call",
  at: at(),
  call: { k: "call", kind: "script", name, args },
});
const sound = (name: string): Expr => ({ k: "asset", kind: "sound", name });
const object = (name: string): Expr => ({ k: "asset", kind: "object", name });
const global = (name: string): Expr => ({ k: "var", scope: "global", name });
const destroyPlayer = (): Stmt => ({
  k: "with",
  at: at(),
  target: object("player"),
  body: [call("instance_destroy")],
});

/**
 * A game shaped like the family this mod is for: a death script, a retry key, a music toggle, an
 * F2 that throws the run away, and a boss that changes the music.
 *
 * The save and load scripts are the shape `@sculptr/detect` recognises -- a binary file written
 * one byte at a time and read back into the player -- because the retry half of this mod stands on
 * its save model. The retry key reaches the load the way these engines do, through a script of the
 * game's own rather than by calling the load routine itself.
 */
const game = function (): GameContent {
  const num = (value: number): Expr => ({ k: "number", value });
  const local = (name: string): Expr => ({ k: "var", scope: "local", name });
  const builtin = (name: string): Expr => ({ k: "var", scope: "builtin", name });
  const field = (of: Expr, name: string): Expr => ({ k: "field", of, name });
  const value = (name: string, ...args: Expr[]): Expr =>
    ({ k: "call", kind: "builtin", name, args });
  const set = (target: Expr, to: Expr): Stmt => ({ k: "assign", at: at(), target, op: "=", value: to });

  const saveGame: Block = [
    set(local("f"), value("file_bin_open", { k: "string", value: "save1" }, num(1))),
    set(local("tem"), builtin("room")),
    call("file_bin_write_byte", local("f"), local("tem")),
    set(local("tem"), field(object("player"), "x")),
    call("file_bin_write_byte", local("f"), local("tem")),
    set(local("tem"), field(object("player"), "y")),
    call("file_bin_write_byte", local("f"), local("tem")),
    call("file_bin_close", local("f")),
  ];
  const saveExe: Block = [
    set(local("f"), value("file_bin_open", { k: "string", value: "save1" }, num(0))),
    set(local("roomTo"), value("file_bin_read_byte", local("f"))),
    call("room_goto", local("roomTo")),
    set(field(object("player"), "x"), value("file_bin_read_byte", local("f"))),
    set(field(object("player"), "y"), value("file_bin_read_byte", local("f"))),
  ];
  const loadGame: Block = [script("saveExe"), call("game_restart")];
  const killPlayer: Block = [
    {
      k: "if",
      at: at(),
      cond: global("late"),
      then: [call("sound_play", sound("sndDeath"))],
      else: [call("sound_stop_all"), call("sound_play", sound("sndOnDeath"))],
    },
    destroyPlayer(),
    call("instance_create", num(0), num(0), object("GAMEOVER")),
  ];

  return {
    scripts: [
      { name: "saveGame", body: saveGame },
      { name: "saveExe", body: saveExe },
      { name: "loadGame", body: loadGame },
      { name: "killPlayer", body: killPlayer },
    ],
    objects: [
      { name: "player", events: {} },
      { name: "world", events: {} },
      { name: "boss", events: {} },
    ],
    events: [
      // The retry key: stops the music, then loads -- through `loadGame`, not the load routine
      // itself, which is the link that has to be followed.
      { name: "world.KeyPress_82", body: [call("sound_stop_all"), script("loadGame")] },
      // F2: throws the run away and goes back to the title, where the music *should* stop.
      {
        name: "world.KeyPress_113",
        body: [call("file_delete"), call("sound_stop_all"), call("game_restart")],
      },
      // Ctrl+M, the game's own music switch.
      { name: "world.KeyPress_77", body: [call("sound_stop_all")] },
      // A boss changing the music, which is the game meaning it.
      { name: "boss.Alarm_10", body: [call("sound_stop_all"), call("sound_loop", sound("snd_boss"))] },
    ],
    sounds: [
      { name: "snd_bgm", exclusive: true },
      { name: "snd_boss", exclusive: true },
      { name: "sndOnDeath", exclusive: true },
      { name: "sndDeath", exclusive: false },
      { name: "sndJump", exclusive: false },
    ],
    rooms: [
      // The first room of an area: the author means walking in to start the track over, and wrote
      // the bare call. This is the one a retry inside the area restarts the music through.
      {
        name: "area1.instance_141058",
        room: "area1",
        object: "playMusic",
        body: [call("sound_loop", sound("snd_bgm"))],
      },
      // The rest of the area, written the way these games usually write it.
      {
        name: "area2.instance_141059",
        room: "area2",
        object: "playMusic",
        body: [
          {
            k: "if",
            at: at(),
            cond: { k: "call", kind: "builtin", name: "sound_isplaying", args: [sound("snd_bgm")] },
            then: [],
            else: [call("sound_loop", sound("snd_bgm"))],
          },
        ],
      },
      // A room that means to be silent. A stop, not a play, so nothing here is about it.
      { name: "area3.instance_9", room: "area3", object: "playMusic", body: [call("sound_stop_all")] },
      // Scenery. Nothing to do with sound at all.
      { name: "area1.instance_7", room: "area1", object: "mover", body: [] },
    ],
  };
};

/** Every call the mod would take out of the death and retry code, as `<entry> <call>`. */
const taken = (content: GameContent): string[] =>
  plan(content)
    .found.filter((one) => one.reason !== "room")
    .map((one) => `${one.entry} ${one.call.name}(${one.sound ?? ""})`);

/** Every room whose music the mod would guard. */
const guarded = (content: GameContent): string[] =>
  plan(content)
    .found.filter((one) => one.reason === "room")
    .map((one) => `${String(one.room)} ${one.call.name}(${one.sound ?? ""})`);

test("the death handler's stop and its jingle both go", () => {
  const found = taken(game());
  assert.ok(found.includes("killPlayer sound_stop_all()"), found.join(" | "));
  assert.ok(found.includes("killPlayer sound_play(sndOnDeath)"), found.join(" | "));
});

test("the retry key's stop goes too, through the script that reaches the load", () => {
  assert.ok(taken(game()).includes("world.KeyPress_82 sound_stop_all()"));
});

test("the death sound effect is left alone", () => {
  assert.ok(!taken(game()).some((line) => line.includes("sndDeath)")));
});

test("the keys that mean to stop the music are left alone", () => {
  const found = taken(game());
  assert.ok(!found.some((line) => line.startsWith("world.KeyPress_113")), found.join(" | "));
  assert.ok(!found.some((line) => line.startsWith("world.KeyPress_77")), found.join(" | "));
});

test("a boss changing the music is left alone", () => {
  assert.ok(!taken(game()).some((line) => line.startsWith("boss.")));
});

test("nothing is taken out of a game whose sounds share no slot", () => {
  const studio = game();
  const content: GameContent = {
    ...studio,
    sounds: studio.sounds.map((one) => ({ ...one, exclusive: false })),
  };
  // The stop of everything still goes -- it is what empties the slot in a game that has one -- but
  // nothing that merely plays a sound does.
  assert.deepEqual(taken(content), [
    "killPlayer sound_stop_all()",
    "world.KeyPress_82 sound_stop_all()",
  ]);
});

test("a statement the engine could not place is not pointed at", () => {
  const content = game();
  const killPlayer = content.scripts.find((one) => one.name === "killPlayer");
  assert.ok(killPlayer);
  const branch = killPlayer.body[0];
  assert.ok(branch?.k === "if");
  for (const stmt of branch.else) delete (stmt as { at?: At }).at;
  assert.deepEqual(taken(content), ["world.KeyPress_82 sound_stop_all()"]);
});

test("a game this mod does not recognise is reported, not guessed at", () => {
  const content: GameContent = {
    scripts: [{ name: "doThing", body: [call("sound_stop_all")] }],
    objects: [],
    events: [],
    sounds: [{ name: "snd_bgm", exclusive: true }],
    rooms: [],
  };
  const result = plan(content);
  assert.deepEqual(result.found, []);
  assert.deepEqual(result.indirect, []);
});

test("a death handler that stops the music through a script of its own is named, not edited", () => {
  const content = game();
  const content2: GameContent = {
    ...content,
    scripts: [
      ...content.scripts.filter((one) => one.name !== "killPlayer"),
      { name: "stopMusic", body: [call("sound_stop_all")] },
      { name: "killPlayer", body: [script("stopMusic"), destroyPlayer()] },
    ],
  };
  const result = plan(content2);
  assert.deepEqual(result.indirect, ["killPlayer -> stopMusic"]);
  assert.ok(!result.found.some((one) => one.entry === "killPlayer"));
});

// The other half of the bug, and the one that survives taking every stop out: a retry goes through
// `game_restart()`, so the room loads again and arms its own music again.
test("a room that starts its music without looking is guarded", () => {
  assert.deepEqual(guarded(game()), ["area1 sound_loop(snd_bgm)"]);
});

test("a room that already looks at the slot is left exactly as it was", () => {
  assert.ok(!guarded(game()).some((line) => line.startsWith("area2")));
});

test("a room that means to be silent is not turned into one that plays", () => {
  // A stop, in room code: the author is clearing the slot on purpose and this mod has no business
  // there -- the stops it takes out are the ones in a death and a retry, not in a room.
  assert.ok(!plan(game()).found.some((one) => one.entry.startsWith("area3")));
});

test("room music is guarded on the sound the room names, not on whatever is playing", () => {
  const one = plan(game()).found.find((found) => found.reason === "room");
  assert.equal(one?.kind, "arm");
  assert.equal(one?.sound, "snd_bgm");
  assert.equal(one?.room, "area1");
});

test("a sound effect a room plays on load is left alone", () => {
  const content = game();
  const rooms: GameContent["rooms"] = [
    { name: "area4.instance_1", room: "area4", object: "playMusic", body: [call("sound_play", sound("sndJump"))] },
  ];
  assert.deepEqual(guarded({ ...content, rooms }), []);
});

test("an engine that cannot address room code yields nothing rather than an error", () => {
  assert.deepEqual(guarded({ ...game(), rooms: [] }), []);
});
