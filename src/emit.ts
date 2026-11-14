import type { Found, Plan } from "./find.ts";

/** One call this mod takes out, and the GML that runs in its place. */
export interface StandIn {
  found: Found;
  body: string;
}

/** What this mod writes into a game, and what it had to leave alone to do it. */
export interface Emitted {
  standIns: StandIn[];
  /** Every sound of this game whose name cannot be written as GML; see `nameable`. */
  unnameable: string[];
}

/**
 * Whether GameMaker 8 code can name this sound.
 *
 * An asset name is an *identifier* where it appears in GML, and the compiler reads identifiers as
 * ASCII -- while an asset name is whatever the author's Windows let them type. A game written
 * outside ASCII routinely has one: "I wanna Demise" is a Chinese game built on a Japanese engine
 * and calls a track `sound179_侮蔑、嘲笑单`. Worse, that name has already been through a decode
 * that could not represent it by the time a mod sees it, so what arrives is replacement
 * characters -- there is not even a faithful name left to write.
 *
 * Either way the generated script does not compile, and in GameMaker 8 scripts are compiled when
 * the game starts: one unwritable name is the whole game failing to launch, black screen and all,
 * because its music mod had an opinion. So a sound this mod cannot write down is one it leaves
 * alone.
 *
 * Asked here rather than in `find.ts` on purpose. The plan stays complete, which is what lets a
 * *stop* of an unnameable track still be recognised as a stop of the music and still be taken out:
 * that edit deletes a call and never has to name anything.
 */
export const nameable = function (name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
};

/**
 * The GML this mod runs in place of each call it found, and the sounds it could not spell.
 *
 * Pure, and apart from `find.ts`, because what a mod may *say* is a different question from what it
 * can find -- and because the answer is a string a test can read without a game around it.
 */
export const emit = function (plan: Plan): Emitted {
  const { music, effects } = plan;

  /**
   * Whether anything holds the music slot right now, as GML.
   *
   * A track left out for want of a name is a track this guard cannot see: if that one is playing
   * when the player dies, the game's own jingle plays and the music goes, exactly as it did before
   * this mod existed. The alternative is not starting at all.
   */
  const named = music.filter(nameable);
  const slotBusy = named.length > 0
    ? named.map((name) => `sound_isplaying(${name})`).join(" || ")
    : "0";

  /**
   * What a death used to do to the sound effects, said one sound at a time.
   *
   * `sound_stop_all` cannot be used for this: it is exactly the call being replaced, and it would
   * take the music with it. A game with a great many sounds is left alone instead of handed a
   * script thousands of calls long -- its effects keep playing through a death, which is the
   * smaller of the two prices.
   */
  const stoppable = effects.filter(nameable);
  const stopEffects = stoppable.length <= 256
    ? stoppable.map((name) => `sound_stop(${name});`).join("\n")
    : "";

  /** The call this mod took out, as the GML it was. */
  const original = (one: Found) =>
    `${one.call.name}(${one.sound === null ? "" : one.sound});`;

  /**
   * What runs in place of one call, or `null` to leave the game's own call where it is.
   *
   * Identical bodies become one script -- the SDK does that -- so a game with a dozen of these
   * usually gets two.
   */
  const standIn = function (one: Found): string | null {
    switch (one.kind) {
      case "stopAll":
        return stopEffects;
      case "stopMusic":
        // Nothing: not stopping the music is the whole fix. Needs no name, so an unnameable track
        // is fixed here even though the guards below cannot mention it.
        return "";
      case "play":
        // `plan` only reports a play whose sound it could name as an asset, so this is never null.
        if (one.sound !== null && !nameable(one.sound)) return null;
        return `if (!(${slotBusy})) { ${original(one)} }`;
      case "arm": {
        // `roomArms` only reports a play whose sound it could name, so this is never null; handing
        // the game's own call back rather than asserting means a mistake there cannot write GML
        // with an empty argument into a room.
        if (one.sound === null) return original(one);
        if (!nameable(one.sound)) return null;
        // The game's own idiom, which most of its rooms already use: start the track unless it is
        // the one already playing. Per sound, not "unless anything is playing" -- a room reached
        // with a *different* track in the slot still starts its own, which is what walking into an
        // area or finishing the game and landing on the title screen does.
        return `if (!sound_isplaying(${one.sound})) { ${original(one)} }`;
      }
    }
  };

  const standIns: StandIn[] = [];
  for (const one of plan.found) {
    const body = standIn(one);
    if (body !== null) standIns.push({ found: one, body });
  }

  return {
    standIns,
    unnameable: [...new Set([...music, ...effects].filter((name) => !nameable(name)))],
  };
};
