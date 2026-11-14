import { createMod } from "@sculptr/sdk";
import { emit } from "./emit.ts";
import { plan } from "./find.ts";

/**
 * Keeps a GameMaker 8 game's music playing through a death and a retry.
 *
 * ## The problem this is for
 *
 * A GameMaker 8 game plays its music through the engine's "multimedia" slot, which holds exactly
 * one sound: starting a second one ends the first. GameMaker 8 also has no way at all to ask where
 * a sound is playing or to start one part-way through -- `sound_play` and `sound_loop` begin at the
 * beginning, and that is the whole API.
 *
 * So the usual death handler in these engines reads:
 *
 * ```gml
 * sound_stop_all();
 * sound_play(sndOnDeath);
 * ```
 *
 * and the retry key, a second place, reads:
 *
 * ```gml
 * sound_stop_all();
 * loadGame();
 * ```
 *
 * while every room starts its own music with a guard of its own:
 *
 * ```gml
 * if (sound_isplaying(snd_ederu)) { } else { sound_loop(snd_ederu); }
 * ```
 *
 * That guard is the important one, and it is why this mod can be as small as it is: **nothing
 * restarts the music if nothing stops it.** Take the two teardowns out and the music plays straight
 * through the death, the retry, and the `game_restart()` the retry goes through -- the room it comes
 * back to looks at the slot, finds its own music still in it, and leaves it alone.
 *
 * The games prove this themselves. "I wanna see the moon" has a branch in its death handler for its
 * late areas that plays only the death sound effect and leaves the music alone, and in those areas
 * the music does not restart. This mod makes every area behave the way the author made those.
 *
 * ## The jingle has to go
 *
 * One slot means a game-over jingle cannot play *over* the music; it plays *instead* of it, and the
 * music is gone whether or not anything called a stop. So keeping the music means the jingle does
 * not play. That is the price of the fix, and the only way back to the game's own behaviour is to
 * turn the mod off.
 *
 * ## What it edits, and what it refuses to
 *
 * `find.ts` looks for the two entries -- the one that destroys the player, and the one that loads a
 * save -- and in those, for calls whose argument says what it means. A `sound_stop` on a sound this
 * mod cannot resolve to an asset is left alone: a wrong guess here is a game that goes quiet, which
 * is worse than the restart it was trying to fix. Neither is the F2-style "restart to the title"
 * key caught, which stops the music on purpose; keying on the load routine rather than on
 * `game_restart()` is what tells the two apart.
 *
 * Each call it does take out is replaced by a script of this mod's, so nothing is really deleted:
 *
 * - a **stop** becomes a stop of every sound that does *not* hold the music slot, so a death still
 *   cuts off the sound effects that were playing, exactly as it did;
 * - a **play of music** becomes that same play, guarded by "unless something is already in the
 *   slot". If this mod missed a teardown somewhere and the slot really is empty, the game's own
 *   sound plays and the player hears what they always heard. It can leave a game with its music
 *   restarting; it cannot leave one silent.
 *
 * A sound whose name GameMaker 8 code cannot spell is a third thing it refuses -- see `nameable`
 * in `emit.ts`, which is the one that black-screened a game rather than merely misjudging it.
 *
 * ## GameMaker 8 only
 *
 * GameMaker Studio has `audio_pause_sound`, `audio_resume_sound` and track positions, mixes freely,
 * and its engines already pause the music on death and resume it on the retry key. There is nothing
 * here for them to fix, and a Studio game's events cannot be addressed by the loader anyway.
 */
export default createMod((mod) => {
  if (mod.engine !== "gm8") {
    console.warn("[non-repeating-music] only GameMaker 8 games restart their music this way");
    return;
  }

  const found = plan(mod.content);
  const { indirect } = found;
  const { standIns, unnameable } = emit(found);

  for (const { found: one, body } of standIns) {
    mod.resource.script.insert({ at: one.stmt, place: "instead", body: () => body });
  }

  // What was actually edited, not what was found: a call this mod could not write a stand-in for
  // is one the game still makes.
  const done = standIns.map((standIn) => standIn.found);
  const teardown = done.filter((one) => one.reason !== "room");
  const places = [...new Set(teardown.map((one) => one.entry))];
  const rooms = [...new Set(done.filter((one) => one.reason === "room").map((one) => one.room))];
  console.info(
    places.length > 0
      ? `[non-repeating-music] standing in for ${teardown.length} call(s) in ${places.join(", ")}`
      : "[non-repeating-music] this game's death and retry code does not stop the music where this mod looks",
  );
  if (rooms.length > 0) {
    // Worth saying out loud: these are the rooms where taking the stops out is not enough on its
    // own, and before this mod looked at them a retry inside one restarted the music regardless.
    console.info(`[non-repeating-music] also guarded the music ${rooms.length} room(s) start unasked: ${rooms.join(", ")}`);
  }
  if (indirect.length > 0) {
    console.info(`[non-repeating-music] stopped through a script of its own, left alone: ${indirect.join(", ")}`);
  }
  if (unnameable.length > 0) {
    // Not a warning: the game runs, and this says which of its sounds this mod had to work around.
    console.info(
      `[non-repeating-music] cannot be named in GameMaker 8 code, left out of every guard: ` +
        unnameable.map((name) => JSON.stringify(name)).join(", "),
    );
  }
});
