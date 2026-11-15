// Reading foundations, version 1.0.0 (ADR-0016): phonemic awareness, three sets of sound–letter
// correspondences taught in a common published order (s a t i p n; c e h r m d; g o u l f b),
// building and reading CVC words, heart words, decodable sentences, oral reading an adult observes,
// and listening comprehension kept as its own strand.
//
// Every word a child is asked to read or build uses only letters taught by then, or is a heart
// word taught by then; `__tests__/content.test.ts` checks that, recomputes each answer, and checks
// each distractor differs from the answer. Pictures are emoji with a spoken label. A reading item's
// prompt never names the word or sentence the child is asked to read.
//
// Status: draft. The pack has not yet had the qualified literacy review ADR-0016 requires before a
// community offers it as reviewed content; the library says so to parents.
import type { Choice, Item, Picture } from "./schema.ts";

const SET_1 = ["s", "a", "t", "i", "p", "n"];
const SET_2 = [...SET_1, "c", "e", "h", "r", "m", "d"];
const SET_3 = [...SET_2, "g", "o", "u", "l", "f", "b"];
const HEART_1 = ["the", "a", "is", "I"];
const HEART_2 = [...HEART_1, "to", "he", "was", "of"];

const pic = (emoji: string, label: string): Picture => ({ emoji, label });

/** The pictures a reading item may show, by the word they stand for. */
const PICTURES = {
  pin: pic("📌", "a pin"), pan: pic("🍳", "a pan"), pen: pic("🖊️", "a pen"), fan: pic("🪭", "a fan"), tap: pic("🚰", "a tap"),
  cap: pic("🧢", "a cap"), map: pic("🗺️", "a map"), nap: pic("😴", "someone napping"), ant: pic("🐜", "an ant"), hat: pic("🎩", "a hat"),
  cat: pic("🐱", "a cat"), pit: pic("🕳️", "a pit"), pig: pic("🐷", "a pig"), hen: pic("🐔", "a hen"), ten: pic("🔟", "ten"),
  net: pic("🥅", "a net"), rat: pic("🐀", "a rat"), red: pic("🟥", "a red square"), man: pic("👨", "a man"), sad: pic("😢", "a sad face"),
  mad: pic("😠", "a mad face"), ram: pic("🐏", "a ram"), dog: pic("🐶", "a dog"), bug: pic("🐛", "a bug"), sun: pic("☀️", "the sun"),
  bus: pic("🚌", "a bus"), cup: pic("🥤", "a cup"), mug: pic("☕", "a mug"), log: pic("🪵", "a log"), leg: pic("🦵", "a leg"),
  bed: pic("🛏️", "a bed"), bag: pic("👜", "a bag"), bat: pic("🦇", "a bat"), nut: pic("🥜", "a nut"), pot: pic("🍲", "a pot"),
  lip: pic("👄", "lips"), tub: pic("🛁", "a tub"), hug: pic("🤗", "a hug"), hut: pic("🛖", "a hut"), fog: pic("🌫️", "fog"),
  hot: pic("🥵", "a hot face"), hog: pic("🐗", "a hog"), fish: pic("🐟", "a fish"), frog: pic("🐸", "a frog"), bee: pic("🐝", "a bee"),
  up: pic("⬆️", "an arrow pointing up"), sip: pic("🧃", "a juice box to sip"), sit: pic("🪑", "a chair to sit on"),
  mud: pic("🟫", "a brown puddle of mud"),
} as const satisfies Record<string, Picture>;
type Pictured = keyof typeof PICTURES;

/** A picture-only choice for a word. */
const word = (key: Pictured): Choice => ({ key, text: "", picture: PICTURES[key] });
/** A picture-only choice showing a scene. */
const scene = (key: string, emoji: string, label: string): Choice => ({ key, text: "", picture: pic(emoji, label) });
/** A printed-word choice. */
const printed = (text: string): Choice => ({ key: text.toLowerCase(), text });

const countSounds = (key: Pictured, phonemes: string[]): Item => ({
  type: "count-sounds", key, word: key, picture: PICTURES[key], phonemes, answer: phonemes.length,
  prompt: `Listen: ${key}. Tap one counter for each sound you hear.`,
  hint: `Say it slowly with me, one sound at a time: ${phonemes.join(" ")}. Tap as you say each sound.`,
});

const blendSounds = (answer: Pictured, phonemes: string[], others: [Pictured, Pictured]): Item => ({
  type: "blend-sounds", key: answer, phonemes, answer, choices: [word(answer), word(others[0]), word(others[1])].toSorted((a, b) => a.key.localeCompare(b.key)),
  prompt: "Listen to your grown-up say the sounds. Put them together. Tap the picture of the word.",
  hint: "Ask your grown-up to say the sounds again, a little faster each time, until they make a word.",
});

const buildWord = (answer: string, extra: string[], spoken?: Pictured): Item => ({
  type: "build-word", key: answer, word: answer, answer,
  ...(spoken === undefined ? {} : { picture: PICTURES[spoken] }),
  tiles: [...answer.split(""), ...extra].toSorted(),
  prompt: `Build the word ${answer}. Tap the letters in order.`,
  hint: `Say ${answer} slowly. What sound do you hear first? Find that letter. Then say the word again.`,
});

const readWord = (answer: Pictured, others: [Pictured, Pictured]): Item => ({
  type: "read-word", key: answer, word: answer, answer,
  choices: [word(answer), word(others[0]), word(others[1])].toSorted((a, b) => a.key.localeCompare(b.key)),
  prompt: "Read the word. Then find the picture that matches it.",
  hint: "Point to each letter and say its sound. Then blend the sounds together, faster and faster.",
});

const findWord = (answer: string, others: [string, string]): Item => ({
  type: "find-word", key: `hw-${answer.toLowerCase()}`, word: answer, answer: answer.toLowerCase(),
  choices: [printed(answer), printed(others[0]), printed(others[1])].toSorted((a, b) => a.key.localeCompare(b.key)),
  prompt: `Find the word ${answer}. Tap it.`,
  hint: `Look for the word that starts with ${answer[0]!.toLowerCase() === "i" ? "the letter I" : `the letter ${answer[0]!.toLowerCase()}`}.`,
});

const readSentence = (key: string, sentence: string, choices: [Choice, Choice, Choice], answer: string): Item => ({
  type: "read-sentence", key, sentence, answer, choices,
  prompt: "Read the sentence. Tap the picture that shows it.",
  hint: "Read one word at a time. Sound out any word you don't know, then read the whole sentence again.",
});

const readAloud = (key: string, sentence: string): Item => ({
  type: "read-aloud", key, sentence,
  prompt: "Read this sentence out loud to your grown-up.",
});

const listen = (key: string, passage: string, question: string, choices: [Choice, Choice, Choice], answer: string): Item => ({
  type: "listen-and-answer", key, passage, question, choices, answer,
  prompt: "Listen to the story. Then answer the question.",
  hint: "Tap the speaker to hear the story again. Think about what happened.",
});

const PHONEME_GUIDE = "Say each sound short and clean, without adding \"uh\": /m/ is \"mmm\", not \"muh\"; /t/ is a quiet puff, not \"tuh\". Stretch sounds you can hold (/s/, /m/, /n/, /a/). If your child taps too many counters, say the word slowly together and tap as you go.";

/** Reading foundations 1.0.0. */
export const READING_FOUNDATIONS = {
  id: "reading-foundations",
  version: "1.0.0",
  track: "reading",
  title: "Reading foundations",
  summary: "Hear the sounds in words, connect sounds to letters, build and read short words, read simple sentences, and listen to stories. Taught in a fixed order, one small set of letters at a time.",
  gradeBands: ["K", "1", "2"],
  language: "en",
  review: { status: "draft", scope: "Awaiting qualified literacy review of the scope and sequence, the phoneme guide, decodability and distractors." },
  startFor: { K: "count-sounds", "1": "build-words-set-1", "2": "read-sentences-2" },
  skills: [
    { id: "phonemic.count-sounds", strand: "phonemic-awareness", title: "Count the sounds in a word", description: "Hears a short spoken word and counts its separate sounds.", standards: ["CCSS.ELA-LITERACY.RF.1.2.D"] },
    { id: "phonemic.blend-sounds", strand: "phonemic-awareness", title: "Blend sounds into a word", description: "Hears separate sounds and puts them together into a word.", standards: ["CCSS.ELA-LITERACY.RF.1.2.B"] },
    { id: "spell.set-1", strand: "spelling", title: "Build words with s, a, t, i, p, n", description: "Spells short words by their sounds using the first six letters.", standards: ["CCSS.ELA-LITERACY.L.K.2.D"] },
    { id: "decode.set-1", strand: "decoding", title: "Read words with s, a, t, i, p, n", description: "Reads short words made from the first six letters by blending their sounds.", standards: ["CCSS.ELA-LITERACY.RF.K.3.A", "CCSS.ELA-LITERACY.RF.1.3.B"] },
    { id: "heart-words.set-1", strand: "heart-words", title: "Heart words: the, a, is, I", description: "Recognizes four common words whose spelling has a part to learn by heart.", standards: ["CCSS.ELA-LITERACY.RF.K.3.C"] },
    { id: "text.set-1", strand: "connected-text", title: "Read sentences: first letters", description: "Reads short sentences built only from taught letters and heart words, and shows what they mean.", standards: ["CCSS.ELA-LITERACY.RF.K.4"] },
    { id: "spell.set-2", strand: "spelling", title: "Build words with c, e, h, r, m, d", description: "Spells short words using the first twelve letters.", standards: ["CCSS.ELA-LITERACY.L.K.2.D"] },
    { id: "decode.set-2", strand: "decoding", title: "Read words with c, e, h, r, m, d", description: "Reads short words using the first twelve letters.", standards: ["CCSS.ELA-LITERACY.RF.K.3.A", "CCSS.ELA-LITERACY.RF.1.3.B"] },
    { id: "heart-words.set-2", strand: "heart-words", title: "Heart words: to, he, was, of", description: "Recognizes four more common words with a part to learn by heart.", standards: ["CCSS.ELA-LITERACY.RF.K.3.C"] },
    { id: "text.set-2", strand: "connected-text", title: "Read sentences: twelve letters", description: "Reads short decodable sentences and shows what they mean.", standards: ["CCSS.ELA-LITERACY.RF.K.4", "CCSS.ELA-LITERACY.RF.1.4.A"] },
    { id: "spell.set-3", strand: "spelling", title: "Build words with g, o, u, l, f, b", description: "Spells short words using all eighteen taught letters.", standards: ["CCSS.ELA-LITERACY.L.K.2.D", "CCSS.ELA-LITERACY.L.1.2.D"] },
    { id: "decode.set-3", strand: "decoding", title: "Read words with g, o, u, l, f, b", description: "Reads short words using all eighteen taught letters.", standards: ["CCSS.ELA-LITERACY.RF.K.3.A", "CCSS.ELA-LITERACY.RF.1.3.B"] },
    { id: "text.set-3", strand: "connected-text", title: "Read sentences: eighteen letters", description: "Reads decodable sentences and shows what they mean.", standards: ["CCSS.ELA-LITERACY.RF.1.4.A"] },
    { id: "text.oral-reading", strand: "connected-text", title: "Read a sentence aloud", description: "Reads a decodable sentence aloud to an adult, who records how it went.", standards: ["CCSS.ELA-LITERACY.RF.1.4.B"] },
    { id: "listening.stories", strand: "listening-comprehension", title: "Listen and understand", description: "Listens to a short story read aloud and answers a question about it. This is listening, not reading.", standards: ["CCSS.ELA-LITERACY.RL.K.1", "CCSS.ELA-LITERACY.SL.K.2"] },
  ],
  activities: [
    {
      key: "count-sounds", title: "Count the sounds", skill: "phonemic.count-sounds", mode: "practice", minutes: 5,
      preview: "Your child hears a word and taps a counter for each sound. No letters yet: this trains the ear.",
      adultGuide: PHONEME_GUIDE,
      directions: "Listen to each word. Tap one counter for every sound you hear.",
      example: "Listen: sun. I hear /s/, /u/, /n/. That's three sounds, so I tap three counters.",
      itemsPerSession: 5,
      items: [
        countSounds("sun", ["/s/", "/u/", "/n/"]), countSounds("cat", ["/k/", "/a/", "/t/"]), countSounds("dog", ["/d/", "/o/", "/g/"]),
        countSounds("bee", ["/b/", "/ee/"]), countSounds("pig", ["/p/", "/i/", "/g/"]), countSounds("fish", ["/f/", "/i/", "/sh/"]),
        countSounds("frog", ["/f/", "/r/", "/o/", "/g/"]), countSounds("up", ["/u/", "/p/"]), countSounds("bus", ["/b/", "/u/", "/s/"]),
      ],
    },
    {
      key: "blend-sounds", title: "Blend the sounds", skill: "phonemic.blend-sounds", mode: "practice", minutes: 5, after: ["count-sounds"],
      preview: "You say the sounds of a word from the guide; your child puts them together and taps the picture.",
      adultGuide: `${PHONEME_GUIDE} Say the sounds from the screen with a short pause between them. On a second try, say them closer together.`,
      directions: "Your grown-up will say some sounds. Put them together to make a word, then tap its picture.",
      example: "Listen: /m/ /a/ /p/. Map! I tap the map.",
      itemsPerSession: 5,
      items: [
        blendSounds("pig", ["/p/", "/i/", "/g/"], ["pin", "bug"]), blendSounds("sun", ["/s/", "/u/", "/n/"], ["bus", "nut"]),
        blendSounds("hat", ["/h/", "/a/", "/t/"], ["cat", "hen"]), blendSounds("bed", ["/b/", "/e/", "/d/"], ["bag", "red"]),
        blendSounds("mug", ["/m/", "/u/", "/g/"], ["bug", "map"]), blendSounds("fish", ["/f/", "/i/", "/sh/"], ["fan", "frog"]),
        blendSounds("net", ["/n/", "/e/", "/t/"], ["nut", "ten"]),
      ],
    },
    {
      key: "listen-stories-1", title: "Listen to a story", skill: "listening.stories", mode: "practice", minutes: 5,
      preview: "Your child listens to a very short story read aloud and answers a question about it. This builds vocabulary and understanding; it is not word reading.",
      adultGuide: "Talk about any interesting word afterwards: what does \"shivering\" look like? Act it out together.",
      directions: "Listen to the story. Then tap the answer to the question.",
      example: "Listen: Ben dropped his ice cream and it melted on the hot sidewalk. What happened to the ice cream? It melted.",
      itemsPerSession: 3,
      items: [
        listen("kitten", "Mia found a little gray kitten under the porch. It was shivering. Mia wrapped it in her warm scarf and gave it a bowl of milk. Soon the kitten was purring.", "What did Mia give the kitten?",
          [scene("milk", "🥛", "a glass of milk"), scene("apple", "🍎", "an apple"), scene("ball", "⚽", "a ball")], "milk"),
        listen("rain", "Dark clouds rolled across the sky. Leo heard a rumble of thunder. He pulled on his boots and grabbed his umbrella before he walked to the bus.", "What was the weather like?",
          [scene("storm", "⛈️", "a storm"), scene("sunny", "☀️", "a sunny day"), scene("snow", "❄️", "snow")], "storm"),
        listen("seed", "Ava planted a tiny seed in a pot. Every morning she gave it a little water. After many days, a green sprout poked out of the soil.", "What grew in Ava's pot?",
          [scene("sprout", "🌱", "a green sprout"), scene("rock", "🪨", "a rock"), scene("cake", "🍰", "a cake")], "sprout"),
        listen("lost", "Sam could not find his red mitten. He looked under his bed and behind the couch. At last he found it in his coat pocket!", "Where was the mitten?",
          [scene("coat", "🧥", "a coat pocket"), scene("bed", "🛏️", "under the bed"), scene("couch", "🛋️", "behind the couch")], "coat"),
      ],
    },
    {
      key: "build-words-set-1", title: "Build words: s a t i p n", skill: "spell.set-1", mode: "practice", minutes: 6, after: ["blend-sounds"],
      preview: "Your child hears a short word and builds it with letter tiles, using the first six letters: s, a, t, i, p, n.",
      adultGuide: "If a tile goes in the wrong place, ask \"What sound do you hear first? Next?\" rather than naming the letter. Letter names matter less than letter sounds here.",
      directions: "Listen to the word. Tap the letters to build it, one sound at a time.",
      example: "The word is sat. /s/ is s. /a/ is a. /t/ is t. S, a, t: sat.",
      taught: SET_1,
      itemsPerSession: 5,
      items: [
        buildWord("pin", ["a", "s"], "pin"), buildWord("pan", ["i", "t"], "pan"), buildWord("tap", ["n", "i"], "tap"), buildWord("nap", ["s", "i"], "nap"),
        buildWord("sit", ["a", "p"], "sit"), buildWord("sip", ["a", "n"], "sip"), buildWord("ant", ["s", "i"], "ant"), buildWord("tin", ["a", "p"]),
      ],
    },
    {
      key: "read-words-set-1", title: "Read words: s a t i p n", skill: "decode.set-1", mode: "practice", minutes: 5, after: ["build-words-set-1"],
      preview: "Your child reads a short word on the screen (it is never read aloud for them) and taps the matching picture.",
      adultGuide: "Let your child sound out the word themselves. If they guess from the pictures, cover the pictures, read the word together sound by sound, then uncover them.",
      directions: "Read the word. Then tap the picture that matches it.",
      example: "This word is p, a, n. /p/ /a/ /n/: pan. I tap the pan.",
      taught: SET_1,
      itemsPerSession: 5,
      items: [readWord("pin", ["pan", "pen"]), readWord("pan", ["pin", "fan"]), readWord("tap", ["cap", "map"]), readWord("nap", ["map", "cap"]), readWord("ant", ["hat", "cat"]), readWord("pit", ["pig", "pin"])],
    },
    {
      key: "heart-words-1", title: "Heart words: the, a, is, I", skill: "heart-words.set-1", mode: "practice", minutes: 4, after: ["read-words-set-1"],
      preview: "Four very common words that are worth learning by heart. Your child hears a word and finds it.",
      adultGuide: "Point out the part to learn by heart: in \"the\", t and h are regular and the e says /uh/; in \"is\", the s says /z/; \"a\" usually says /uh/; \"I\" is always a capital letter.",
      directions: "Listen to the word. Find it and tap it.",
      example: "The word is the. T, h, e: the. I tap the.",
      heartWords: HEART_1,
      itemsPerSession: 5,
      items: [findWord("the", ["is", "a"]), findWord("is", ["I", "the"]), findWord("a", ["I", "is"]), findWord("I", ["a", "is"]), { ...findWord("the", ["a", "I"]), key: "hw-the-2" }, { ...findWord("is", ["the", "a"]), key: "hw-is-2" }],
    },
    {
      key: "read-sentences-1", title: "Read sentences", skill: "text.set-1", mode: "practice", minutes: 6, after: ["heart-words-1"],
      preview: "Short sentences made only from s, a, t, i, p, n and the heart words. Your child reads one and taps the picture that shows it.",
      adultGuide: "If your child stalls, point to each word in turn. Praise sounding out, not guessing.",
      directions: "Read the sentence. Then tap the picture that shows it.",
      example: "I read: I sit. I tap the chair, because I sit on a chair.",
      taught: SET_1, heartWords: HEART_1,
      itemsPerSession: 4,
      items: [
        readSentence("nap", "I nap.", [word("nap"), word("sip"), word("sit")], "nap"),
        readSentence("sip", "I sip.", [word("sip"), word("nap"), word("sit")], "sip"),
        readSentence("ant-pan", "An ant is in the pan.", [scene("ant-pan", "🐜🍳", "an ant in a pan"), scene("pin-pan", "📌🍳", "a pin in a pan"), scene("ant-tin", "🐜🥫", "an ant in a tin")], "ant-pan"),
        readSentence("pin-tin", "A pin is in the tin.", [scene("pin-tin", "📌🥫", "a pin in a tin"), scene("ant-tin", "🐜🥫", "an ant in a tin"), scene("pin-pan", "📌🍳", "a pin in a pan")], "pin-tin"),
        readSentence("ant-tin", "An ant is in a tin.", [scene("ant-tin", "🐜🥫", "an ant in a tin"), scene("ant-pan", "🐜🍳", "an ant in a pan"), scene("pin-tin", "📌🥫", "a pin in a tin")], "ant-tin"),
      ],
    },
    {
      key: "build-words-set-2", title: "Build words: c e h r m d", skill: "spell.set-2", mode: "practice", minutes: 6, after: ["read-sentences-1"],
      preview: "Your child builds words with six new letters: c, e, h, r, m, d, plus the first six.",
      adultGuide: "Short e (/e/ as in hen) and short i (/i/ as in pin) are easy to mix up. Ask your child to watch your mouth: e opens wider.",
      directions: "Listen to the word. Tap the letters to build it.",
      example: "The word is hen. /h/ /e/ /n/: h, e, n.",
      taught: SET_2,
      itemsPerSession: 5,
      items: [
        buildWord("cat", ["e", "h"], "cat"), buildWord("hen", ["a", "m"], "hen"), buildWord("red", ["a", "t"], "red"), buildWord("map", ["e", "d"], "map"),
        buildWord("sad", ["e", "m"], "sad"), buildWord("ten", ["a", "h"], "ten"), buildWord("men", ["a", "c"]), buildWord("hat", ["e", "c"], "hat"),
      ],
    },
    {
      key: "read-words-set-2", title: "Read words: c e h r m d", skill: "decode.set-2", mode: "practice", minutes: 5, after: ["build-words-set-2"],
      preview: "Your child reads words with the first twelve letters and taps the matching picture.",
      adultGuide: "Each wrong picture differs from the word by one sound. If your child picks one, read both words slowly together and compare.",
      directions: "Read the word. Then tap the picture that matches it.",
      example: "This word is c, a, t. /k/ /a/ /t/: cat. I tap the cat.",
      taught: SET_2,
      itemsPerSession: 5,
      items: [
        readWord("cat", ["hat", "cap"]), readWord("hat", ["cat", "hen"]), readWord("hen", ["pen", "ten"]), readWord("pen", ["pin", "hen"]),
        readWord("ten", ["net", "hen"]), readWord("net", ["ten", "nut"]), readWord("map", ["cap", "nap"]), readWord("sad", ["mad", "sun"]),
      ],
    },
    {
      key: "check-read-set-2", title: "Check: read words", skill: "decode.set-2", mode: "check", minutes: 4, after: ["read-words-set-2"],
      preview: "Fresh words your child has not practiced, with no hints and one try, to see what they can read on their own.",
      adultGuide: "Please don't help on this one: it shows what your child can do independently. It's fine to stop if it's frustrating.",
      directions: "Read each word by yourself. Tap the picture that matches it.",
      example: "Read the word, then tap its picture. Take your time.",
      taught: SET_2,
      itemsPerSession: 5,
      items: [readWord("rat", ["hat", "cat"]), readWord("cap", ["map", "cat"]), readWord("red", ["bed", "ram"]), readWord("man", ["map", "pan"]), readWord("ram", ["rat", "man"]), readWord("mad", ["sad", "man"])],
    },
    {
      key: "heart-words-2", title: "Heart words: to, he, was, of", skill: "heart-words.set-2", mode: "practice", minutes: 4, after: ["read-words-set-2"],
      preview: "Four more common words to learn by heart, mixed with the first four.",
      adultGuide: "The heart parts: in \"to\" the o says /oo/; in \"he\" the e says its name; in \"was\" the a says /u/ and s says /z/; in \"of\" the f says /v/.",
      directions: "Listen to the word. Find it and tap it.",
      example: "The word is to. T, o: to.",
      heartWords: HEART_2,
      itemsPerSession: 5,
      items: [findWord("to", ["the", "of"]), findWord("he", ["the", "is"]), findWord("was", ["is", "a"]), findWord("of", ["to", "I"]), { ...findWord("to", ["he", "was"]), key: "hw-to-2" }, { ...findWord("the", ["he", "to"]), key: "hw-the-3" }],
    },
    {
      key: "read-sentences-2", title: "Read sentences", skill: "text.set-2", mode: "practice", minutes: 6, after: ["heart-words-2"],
      preview: "Sentences with the first twelve letters and eight heart words. Your child reads one and taps the picture that shows it.",
      adultGuide: "After a sentence, ask a quick question (\"Who has the hat?\") to make sure the meaning came through.",
      directions: "Read the sentence. Then tap the picture that shows it.",
      example: "I read: The cat sat. I tap the cat sitting.",
      taught: SET_2, heartWords: HEART_2,
      itemsPerSession: 4,
      items: [
        readSentence("cat-hat", "The cat has a hat.", [scene("cat-hat", "🐱🎩", "a cat with a hat"), scene("rat-hat", "🐀🎩", "a rat with a hat"), scene("cat-map", "🐱🗺️", "a cat with a map")], "cat-hat"),
        readSentence("rat-map", "The rat has a map.", [scene("rat-map", "🐀🗺️", "a rat with a map"), scene("rat-hat", "🐀🎩", "a rat with a hat"), scene("cat-map", "🐱🗺️", "a cat with a map")], "rat-map"),
        readSentence("dad-sad", "Dad is sad.", [scene("sad", "👨😢", "a sad dad"), scene("mad", "👨😠", "a mad dad"), scene("nap", "👨😴", "a dad napping")], "sad"),
        readSentence("dad-mad", "Dad was mad.", [scene("mad", "👨😠", "a mad dad"), scene("sad", "👨😢", "a sad dad"), scene("nap", "👨😴", "a dad napping")], "mad"),
        readSentence("hen-ran", "He ran to the hen.", [scene("hen", "🏃🐔", "running to a hen"), scene("cat", "🏃🐱", "running to a cat"), scene("nap", "😴🐔", "a hen and someone napping")], "hen"),
        readSentence("cat-nap", "The cat had a nap.", [scene("cat-nap", "🐱😴", "a cat napping"), scene("rat-nap", "🐀😴", "a rat napping"), scene("cat-hat", "🐱🎩", "a cat with a hat")], "cat-nap"),
      ],
    },
    {
      key: "build-words-set-3", title: "Build words: g o u l f b", skill: "spell.set-3", mode: "practice", minutes: 6, after: ["read-sentences-2"],
      preview: "Your child builds words with the last six letters of this pack: g, o, u, l, f, b.",
      adultGuide: "b and d are often reversed. Make a \"bed\" with your hands: left fist (b) and right fist (d), thumbs up.",
      directions: "Listen to the word. Tap the letters to build it.",
      example: "The word is dog. /d/ /o/ /g/: d, o, g.",
      taught: SET_3,
      itemsPerSession: 5,
      items: [
        buildWord("dog", ["u", "b"], "dog"), buildWord("bug", ["o", "d"], "bug"), buildWord("sun", ["o", "l"], "sun"), buildWord("cup", ["o", "f"], "cup"),
        buildWord("log", ["u", "b"], "log"), buildWord("fan", ["u", "l"], "fan"), buildWord("bed", ["u", "g"], "bed"), buildWord("nut", ["o", "f"], "nut"),
        buildWord("tub", ["o", "d"], "tub"), buildWord("big", ["u", "d"]),
      ],
    },
    {
      key: "read-words-set-3", title: "Read words: g o u l f b", skill: "decode.set-3", mode: "practice", minutes: 5, after: ["build-words-set-3"],
      preview: "Your child reads words with all eighteen letters and taps the matching picture.",
      adultGuide: "Short o (/o/ as in dog) and short u (/u/ as in bug) are the new vowels. Contrast them: dog and dug, hot and hut.",
      directions: "Read the word. Then tap the picture that matches it.",
      example: "This word is b, u, g. /b/ /u/ /g/: bug.",
      taught: SET_3,
      itemsPerSession: 5,
      items: [
        readWord("dog", ["log", "bug"]), readWord("pig", ["pin", "bug"]), readWord("bug", ["mug", "bag"]), readWord("sun", ["bus", "nut"]), readWord("cup", ["cap", "mug"]),
        readWord("mug", ["bug", "map"]), readWord("log", ["leg", "dog"]), readWord("leg", ["log", "bed"]), readWord("bag", ["bug", "bat"]), readWord("pot", ["hot", "pit"]), readWord("lip", ["log", "pin"]),
      ],
    },
    {
      key: "check-read-set-3", title: "Check: read words", skill: "decode.set-3", mode: "check", minutes: 4, after: ["read-words-set-3"],
      preview: "Fresh words with all eighteen letters, no hints and one try.",
      adultGuide: "Please don't help on this one: it shows what your child can read on their own.",
      directions: "Read each word by yourself. Tap the picture that matches it.",
      example: "Read the word, then tap its picture. Take your time.",
      taught: SET_3,
      itemsPerSession: 5,
      items: [readWord("hut", ["hat", "hot"]), readWord("bus", ["sun", "bug"]), readWord("fog", ["dog", "log"]), readWord("hot", ["hut", "pot"]), readWord("hog", ["dog", "hug"])],
    },
    {
      key: "check-spell-set-3", title: "Check: build words", skill: "spell.set-3", mode: "check", minutes: 4, after: ["build-words-set-3"],
      preview: "Fresh words to build from their sounds, with no hints and one try.",
      adultGuide: "Please don't help on this one. Spelling by sound is the goal; a sensible sound spelling still counts as an error here, so note it in the session if you want to.",
      directions: "Listen to each word. Build it by yourself.",
      example: "Listen to the word, then tap its letters in order.",
      taught: SET_3,
      itemsPerSession: 5,
      items: [buildWord("fun", ["o", "a"]), buildWord("hop", ["u", "a"]), buildWord("rub", ["o", "d"]), buildWord("lot", ["u", "i"]), buildWord("fig", ["u", "e"]), buildWord("mud", ["o", "b"], "mud")],
    },
    {
      key: "read-sentences-3", title: "Read sentences", skill: "text.set-3", mode: "practice", minutes: 6, after: ["read-words-set-3"],
      preview: "Sentences with all eighteen letters and eight heart words.",
      adultGuide: "Encourage your child to reread the whole sentence after sounding out a hard word, so it sounds like talking.",
      directions: "Read the sentence. Then tap the picture that shows it.",
      example: "I read: The dog is on the bed. I tap the dog and the bed.",
      taught: SET_3, heartWords: HEART_2,
      itemsPerSession: 4,
      items: [
        readSentence("dog-bed", "The dog is on the bed.", [scene("dog-bed", "🐶🛏️", "a dog on a bed"), scene("dog-log", "🐶🪵", "a dog on a log"), scene("bug-bed", "🐛🛏️", "a bug on a bed")], "dog-bed"),
        readSentence("bug-log", "A bug is on a log.", [scene("bug-log", "🐛🪵", "a bug on a log"), scene("bug-bed", "🐛🛏️", "a bug on a bed"), scene("dog-log", "🐶🪵", "a dog on a log")], "bug-log"),
        readSentence("pig-mug", "The pig has a big mug.", [scene("pig-mug", "🐷☕", "a pig with a mug"), scene("pig-bag", "🐷👜", "a pig with a bag"), scene("dog-mug", "🐶☕", "a dog with a mug")], "pig-mug"),
        readSentence("pig-bag", "The pig got a bag.", [scene("pig-bag", "🐷👜", "a pig with a bag"), scene("pig-mug", "🐷☕", "a pig with a mug"), scene("dog-bag", "🐶👜", "a dog with a bag")], "pig-bag"),
        readSentence("sun-hot", "The sun is hot.", [scene("sun-hot", "☀️🥵", "a hot sun"), scene("fog", "🌫️", "fog"), scene("bus", "🚌", "a bus")], "sun-hot"),
        readSentence("bus-big", "The bus was big.", [scene("bus", "🚌", "a big bus"), scene("bug", "🐛", "a little bug"), scene("cup", "🥤", "a cup")], "bus"),
      ],
    },
    {
      key: "read-aloud-3", title: "Read aloud to your grown-up", skill: "text.oral-reading", mode: "practice", minutes: 5, after: ["read-sentences-3"],
      preview: "Your child reads a sentence aloud to you, and you record how it went. Nothing is recorded or listened to by the app.",
      adultGuide: "Choose \"On their own\" only if your child read every word without a prompt. \"With help\" if you modeled or prompted any word. \"Not yet\" if it was too hard: that's useful to know, not a failure.",
      directions: "Read the sentence out loud to your grown-up.",
      example: "Point to each word as you read it.",
      taught: SET_3, heartWords: HEART_2,
      itemsPerSession: 3,
      items: [
        readAloud("dog-log", "The dog sat on a log."), readAloud("bug-mud", "A big bug is in the mud."), readAloud("dad-cup", "Dad has a red cup."),
        readAloud("hen-pen", "The hen ran to the pen."), readAloud("sam-sun", "Sam had fun in the sun."), readAloud("pam-pig", "Pam got a pet pig."),
      ],
    },
    {
      key: "listen-stories-2", title: "Listen to a story", skill: "listening.stories", mode: "practice", minutes: 5, after: ["read-sentences-3"],
      preview: "More short stories read aloud, with a question about each. Listening builds the vocabulary reading draws on later.",
      adultGuide: "Ask \"Why do you think…?\" after the answer. Talk counts as much as the tap.",
      directions: "Listen to the story. Then tap the answer to the question.",
      example: "Listen: The puppy ran to the door and wagged its tail when it heard the car. Who was coming home? Someone in the car.",
      itemsPerSession: 3,
      items: [
        listen("snow", "When Nora woke up, everything outside was white and quiet. She put on her mittens and rolled a big ball for a snowman's body.", "What was Nora making?",
          [scene("snowman", "⛄", "a snowman"), scene("sandcastle", "🏰", "a castle"), scene("kite", "🪁", "a kite")], "snowman"),
        listen("picnic", "The family spread a blanket on the grass. They ate sandwiches and grapes. Then an ant marched across the blanket and stole a crumb!", "Who took a crumb?",
          [scene("ant", "🐜", "an ant"), scene("dog", "🐶", "a dog"), scene("bird", "🐦", "a bird")], "ant"),
        listen("moon", "Owl stayed awake while the other animals slept. She watched the round, bright moon and listened for mice in the dark field.", "When was Owl awake?",
          [scene("night", "🌙", "at night"), scene("morning", "🌅", "in the morning"), scene("noon", "☀️", "at noon")], "night"),
        listen("boat", "Grandpa and Eli rowed the little boat to the middle of the lake. The water was calm and smooth like glass. Eli dipped his fingers in. Brr!", "How did the water feel?",
          [scene("cold", "🥶", "cold"), scene("hot", "🥵", "hot"), scene("sticky", "🍯", "sticky")], "cold"),
      ],
    },
  ],
};
