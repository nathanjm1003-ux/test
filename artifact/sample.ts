/**
 * A stand-in for a real scan.
 *
 * These are three pages of *Moby-Dick* (public domain) typed the way Tesseract
 * hands them back from a photograph of a paperback: a running head and page
 * number on every page, words split across the line break, and a hard newline
 * at the end of every printed line. The demo runs them through the real
 * `cleanPages` so the cleanup is doing actual work, not showing a canned
 * before-and-after.
 */

export const SAMPLE_PAGES: string[] = [
  `MOBY-DICK
17

Call me Ishmael. Some years ago—never mind how long precise-
ly—having little or no money in my purse, and nothing par-
ticular to interest me on shore, I thought I would sail about a
little and see the watery part of the world. It is a way I have
of driving off the spleen and regulating the circulation.

Whenever I find myself growing grim about the mouth; when-
ever it is a damp, drizzly November in my soul; whenever I
find myself involuntarily pausing before coffin warehouses,
and bringing up the rear of every funeral I meet; then, I ac-
count it high time to get to sea as soon as I can.`,

  `MOBY-DICK
18
~

This is my substitute for pistol and ball. With a philosophical
flourish Cato throws himself upon his sword; I quietly take to
the ship. There is nothing surprising in this. If they but knew
it, almost all men in their degree, some time or other, cherish
very nearly the same feelings towards the ocean with me.

There now is your insular city of the Manhattoes, belted round
by wharves as Indian isles by coral reefs—commerce sur-
rounds it with her surf. Right and left, the streets take you
waterward.`,

  `19   MOBY-DICK

Its extreme downtown is the battery, where that noble mole is
washed by waves, and cooled by breezes, which a few hours
previous were out of sight of land. Look at the crowds of wa-
ter-gazers there.`,
];
