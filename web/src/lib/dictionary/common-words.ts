/**
 * Everyday English words. A fix whose result is made only of these is prose
 * editing ("Yeah" → "Yes", "Friday" → "Monday", "Where" → "Were"), not a name
 * or term the transcriber got wrong, so it never becomes a dictionary entry.
 *
 * Deliberately left out: first names ("John"), brands and tech words that are
 * also ordinary nouns ("Rust", "Swift", "Slack", "Notion"), because those are
 * exactly what people teach the dictionary.
 */
const WORDS = `
a about above across act actually add after again against ago agree ahead all almost alone along already also
although always am among an and another answer any anybody anyone anything anyway anywhere apart are area aren't
around as ask asked asking at away awesome back bad badly be became because become been before began begin behind
being believe below best better between big bit both bring brought build built busy but buy by call called can
can't cannot care case catch cause certain certainly change changed check clear clearly close come comes coming
could couldn't course cool cut day days decide did didn't different do does doesn't doing don't done down during
each early easy either else end enough even ever every everybody everyone everything exactly example except expect
fact fair far fast feel felt few final finally find fine first fix fixed follow following for forget form forward
found free from full fun further get gets getting give given go goes going gone good got great group had half hand
happen happened happy hard has hasn't have haven't having he he's head hear heard help her here hers herself hey hi
high him himself his hold home hope how however huge i i'd i'll i'm i've idea if important in inside instead into
is isn't issue it it's its itself just keep kept kind knew know known last late later least leave left less let
let's life like likely line little long look looked looking lot lots love low made main make makes making man many
may maybe me mean means meant might mind mine more most move much must my myself name near need needed needs never
new next nice no nobody none nor not nothing now number of off often oh ok okay old on once one only open or order
other others our ours out over own part past people perfect perhaps person place plan please point possible pretty
probably problem pull push put question quick quickly quite rather read ready real really reason right run said
same saw say saying says see seem seems seen send sent set she she's should shouldn't show side since small so
some somebody someone something sometimes somewhere soon sorry sort start started still stop stuff such sure take
taken talk tell than thank thanks that that's the their theirs them themselves then there there's these they
they're thing things think this those though thought through time to today together told tomorrow too took top
toward true try trying turn under understand until up upon us use used using very want wanted was wasn't way we
we'd we'll we're we've well went were weren't what what's whatever when where whether which while who whole whom
whose why will with within without won't word words work worked working world would wouldn't wow yeah year years
yes yesterday yet you you'd you'll you're you've your yours yourself
monday tuesday wednesday thursday friday saturday sunday morning afternoon evening night week weekend month
january february march april june july august september october november december
zero two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand million
first second third fourth fifth
am pm
ask asks answer answers bug bugs call calls cloud code data email file files fix fixes link links list meeting
meetings message messages note notes page pages post posts report reports review reviews team teams test tests
thing update updates user users
`;

export const COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
