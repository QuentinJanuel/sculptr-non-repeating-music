import type { Block, CallExpr, Expr, GameContent, Stmt } from "@sculptr/sdk";
import { walk } from "@sculptr/sdk";
import { findPlayerObjects, findSaveModel } from "@sculptr/detect";

/** One piece of the game's code, which is a script or an object event alike. */
export interface Entry {
  readonly name: string;
  readonly body: Block;
}

/**
 * Why an entry is one this mod edits.
 *
 * `death` and `retry` are the two places a game tears the music down. `room` is the other half of
 * the problem: code a room runs when it loads, which *starts* the music -- and starting it is what
 * a retry comes back to.
 */
export type Reason = "death" | "retry" | "room";

/** One call this mod wants out of the game. */
export interface Found {
  /** The entry it is in, for the report. */
  entry: string;
  reason: Reason;
  stmt: Stmt;
  call: CallExpr;
  /**
   * What the call does, which decides what may stand in for it:
   * - `stopAll` empties the slot *and* cuts off every sound effect;
   * - `stopMusic` empties the slot only;
   * - `play` takes the slot, which is what makes a game-over jingle end the music;
   * - `arm` is a room starting its own music, which only needs doing if nothing is playing it.
   */
  kind: "stopAll" | "stopMusic" | "play" | "arm";
  /** The sound it names, when it names one. */
  sound: string | null;
  /** The room whose load runs this, for `arm`, and `null` for everything else. */
  room: string | null;
}

/** What the mod understood about a game, or why it understood nothing. */
export interface Plan {
  found: Found[];
  /** Every sound that holds the music slot, by name. */
  music: string[];
  /** Every sound that does not, by name. */
  effects: string[];
  /** Entries that reach the music through a script instead, which this mod does not follow. */
  indirect: string[];
}

/** The calls that empty the music slot. `sound_stop` only when it names a sound that holds it. */
const STOPS = new Set(["sound_stop_all", "sound_stop"]);

/** The calls that take the music slot. */
const PLAYS = new Set(["sound_play", "sound_loop"]);

/** Every sound call, for the report on an entry whose music goes through a script of its own. */
const SOUND_CALLS = new Set([...STOPS, ...PLAYS]);

const statementCall = (stmt: Stmt): CallExpr | null =>
  stmt.k === "call" && stmt.call.kind === "builtin" ? stmt.call : null;

/** The one sound a call names, when its argument is a sound asset and not something computed. */
const namedSound = function (call: CallExpr): string | null {
  const [first] = call.args;
  if (call.args.length !== 1 || first === undefined) return null;
  return first.k === "asset" && first.kind === "sound" ? first.name : null;
};

/**
 * Whether an expression names one of the player objects.
 *
 * Two shapes, because a game whose asset names were stripped refers to its objects by index and the
 * summary has nothing to turn that back into a name.
 */
const playerTest = function (game: GameContent): (expr: Expr) => boolean {
  const names = new Set<string>();
  const indices = new Set<number>();
  const players = findPlayerObjects(game);
  if (players.ok) {
    for (const candidate of players.value.candidates) {
      if (candidate.name) names.add(candidate.name);
      const asIndex = /^\((\d+)\)$/u.exec(candidate.ref);
      if (asIndex?.[1] !== undefined) indices.add(Number(asIndex[1]));
    }
  }
  return (expr) =>
    (expr.k === "asset" && expr.kind === "object" && names.has(expr.name)) ||
    (expr.k === "number" && indices.has(expr.value));
};

/** Whether anything in this block calls `instance_destroy`. */
const destroys = function (body: Block): boolean {
  for (const stmt of walk(body)) {
    if (statementCall(stmt)?.name === "instance_destroy") return true;
  }
  return false;
};

/**
 * Whether this entry is the game killing the player.
 *
 * `with (player) instance_destroy()`, wherever in the entry it is -- the death handler of every one
 * of these engines does that, and nothing else in a game does it to the player.
 */
const isDeath = function (entry: Entry, isPlayer: (expr: Expr) => boolean): boolean {
  for (const stmt of walk(entry.body)) {
    if (stmt.k === "with" && isPlayer(stmt.target) && destroys(stmt.body)) return true;
  }
  return false;
};

/** Every script this entry calls, by name. Statements only: a call used as a value is not one. */
const callsOf = function (body: Block): string[] {
  const names: string[] = [];
  for (const stmt of walk(body)) {
    const call = stmt.k === "call" ? stmt.call : null;
    if (call && call.kind === "script") names.push(call.name);
  }
  return names;
};

/**
 * Every script that goes back to a save, whether it is a load routine or merely reaches one.
 *
 * The chain has to be followed: in the yuuutu-edition family the retry key calls `loadGame`, which
 * calls the script that actually reads the save file and is the one a save model names. One link
 * short of that and the retry's own stop goes unnoticed, which is the half of the problem that is
 * not the death.
 */
const loadReach = function (game: GameContent, loads: ReadonlySet<string>): Set<string> {
  const reaching = new Set(loads);
  for (;;) {
    let grew = false;
    for (const script of game.scripts) {
      if (reaching.has(script.name)) continue;
      if (callsOf(script.body).some((name) => reaching.has(name))) {
        reaching.add(script.name);
        grew = true;
      }
    }
    if (!grew) return reaching;
  }
};

/**
 * Whether this entry is the game going back to a save: it is one of those scripts, or it calls one.
 *
 * The retry key is the other half of the problem and it is not a death: these engines stop the
 * music there a second time, on the way into the load. Keyed on the load rather than on
 * `game_restart` so that the key that throws the run away -- F2 in most of them, which restarts to
 * the title and *should* stop the music -- is not caught by this.
 */
const isRetry = function (entry: Entry, reaching: ReadonlySet<string>): boolean {
  return reaching.has(entry.name) || callsOf(entry.body).some((name) => reaching.has(name));
};

/**
 * Whether this piece of code looks at the music slot before filling it.
 *
 * The idiom these games are full of is
 *
 * ```gml
 * if (sound_isplaying(snd_ederu)) { } else { sound_loop(snd_ederu); }
 * ```
 *
 * and the question here is only whether the author wrote it. Asked of the whole entry rather than
 * of the branch the play sits in: a room's creation code is a handful of lines, and an author who
 * named `sound_isplaying` in them at all was thinking about exactly this. Being wrong in the
 * cautious direction leaves a room alone, which is the game's own behaviour -- being wrong in the
 * other direction would silence a room that meant to start its music.
 */
const looksAtTheSlot = function (body: Block, sound: string): boolean {
  for (const stmt of walk(body)) {
    for (const expr of callsIn(stmt)) {
      if (expr.name === "sound_isplaying" && namedSound(expr) === sound) return true;
    }
  }
  return false;
};

/** Every call anywhere in one statement, including the ones used as values. */
const callsIn = function (stmt: Stmt): CallExpr[] {
  const found: CallExpr[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as { k?: string; kind?: string };
    if (node.k === "call" && node.kind === "builtin") found.push(value as CallExpr);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(stmt);
  return found;
};

/**
 * Every room that starts its own music without looking first.
 *
 * **The second half of the bug, and the one that cannot be fixed by leaving stops out.** A retry in
 * these engines goes through `game_restart()`, so the room is loaded again from scratch and runs
 * its creation code again. Where that code is the guarded idiom, the music it finds already playing
 * is left alone and the retry is seamless. Where the author wrote the bare `sound_loop(...)` -- in
 * "I wanna see the moon" that is sixteen rooms, every one of them the first room of an area, where
 * starting the track over is what walking in should do -- the music restarts on every death in
 * that area no matter what this mod does about the stops.
 *
 * So those are guarded too, with the game's own idiom. A room reached from somewhere else still
 * starts its music, because something else was playing; a room reached by retrying inside it does
 * not, because its own music never stopped.
 */
const roomArms = function (game: GameContent, holdsSlot: ReadonlySet<string>): Found[] {
  const found: Found[] = [];
  for (const entry of game.rooms) {
    for (const stmt of walk(entry.body)) {
      const call = statementCall(stmt);
      if (!call || !PLAYS.has(call.name)) continue;
      if (stmt.at === undefined) continue;
      const sound = namedSound(call);
      if (sound === null || !holdsSlot.has(sound)) continue;
      if (looksAtTheSlot(entry.body, sound)) continue;
      found.push({
        entry: entry.name,
        reason: "room",
        stmt,
        call,
        kind: "arm",
        sound,
        room: entry.room,
      });
    }
  }
  return found;
};

/**
 * What to take out of this game, by reading its code.
 *
 * Only the calls in the two entries that matter, and only the ones whose argument says what it
 * means: a stop of a sound this mod cannot resolve is left alone, because a wrong guess here is a
 * game that goes quiet.
 */
export const plan = function (game: GameContent): Plan {
  const music = game.sounds.filter((sound) => sound.exclusive).map((sound) => sound.name);
  const effects = game.sounds.filter((sound) => !sound.exclusive).map((sound) => sound.name);
  const holdsSlot = new Set(music);
  const isPlayer = playerTest(game);
  const saves = findSaveModel(game);
  const reaching = loadReach(game, new Set(saves.ok ? saves.value.loads : []));

  const entries: Entry[] = [...game.scripts, ...game.events];
  const found: Found[] = [];
  const indirect: string[] = [];

  // Scripts that empty the music slot themselves, for the report below.
  const stoppers = new Set(
    game.scripts
      .filter((script) => {
        for (const stmt of walk(script.body)) {
          const call = statementCall(stmt);
          if (call && STOPS.has(call.name)) return true;
        }
        return false;
      })
      .map((script) => script.name),
  );
  const edited = new Set<string>();

  for (const entry of entries) {
    const reason: Reason | null = isDeath(entry, isPlayer)
      ? "death"
      : isRetry(entry, reaching)
        ? "retry"
        : null;
    if (reason === null) continue;

    for (const stmt of walk(entry.body)) {
      const call = statementCall(stmt);
      if (!call || !SOUND_CALLS.has(call.name)) continue;
      if (stmt.at === undefined) continue;
      const sound = namedSound(call);
      edited.add(entry.name);
      if (call.name === "sound_stop_all") {
        found.push({ entry: entry.name, reason, stmt, call, kind: "stopAll", sound: null, room: null });
      } else if (call.name === "sound_stop" && sound !== null && holdsSlot.has(sound)) {
        found.push({ entry: entry.name, reason, stmt, call, kind: "stopMusic", sound, room: null });
      } else if (PLAYS.has(call.name) && sound !== null && holdsSlot.has(sound)) {
        found.push({ entry: entry.name, reason, stmt, call, kind: "play", sound, room: null });
      }
    }

    // An entry that stops the music through a script of its own. Editing that script would change
    // the music everywhere else it is called from -- a room transition, a boss intro -- so this mod
    // says so rather than guess which of its callers meant what.
    for (const name of callsOf(entry.body)) {
      const line = `${entry.name} -> ${name}`;
      if (stoppers.has(name) && !edited.has(name) && !indirect.includes(line)) indirect.push(line);
    }
  }

  // The rooms are a pass of their own: they are not a death or a retry, they are what a retry
  // comes back to, and nothing about which entry they are in decides whether they count.
  found.push(...roomArms(game, holdsSlot));

  return { found, music, effects, indirect };
};
