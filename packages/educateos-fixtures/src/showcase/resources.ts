// The short readings the showcase classes import. Every text is written for EducateOS's demo, except
// the Hammurabi laws, which are adapted from L. W. King's public-domain translation (1910).
import type { ShowcaseResource } from "./types.ts";

/** Every reading a showcase class imports, by key. */
export const SHOWCASE_RESOURCES: readonly ShowcaseResource[] = [
  {
    key: "little-seed",
    title: "The Little Seed",
    path: "/showcase/little-seed",
    paragraphs: [
      "A little seed fell into the dirt.",
      "First, the rain came and gave it a drink.",
      "Next, the sun came and kept it warm.",
      "Last, a tiny green sprout popped up to say hello!",
    ],
  },
  {
    key: "kite-story",
    title: "The Kite That Would Not Fly",
    path: "/showcase/kite-that-would-not-fly",
    paragraphs: [
      "Lila had built her kite from newspaper and two thin sticks. At the park, she ran as fast as she could, but the kite spun and crashed into the grass. She tried again. Crash. A third time. Crash.",
      "\"It's broken,\" she said, and lifted it over the trash can.",
      "Her grandfather caught her arm. \"A broken kite and a kite that isn't finished are not the same thing,\" he said. He held it up to the wind. \"See how it twists? The tail is too short to keep it steady.\"",
      "Lila ran home and found her old blue dress, the one with the torn hem. She cut three long ribbons and tied them to the tail.",
      "Back at the park, the kite lifted, wobbled, and then climbed, higher than any kite in the sky. Lila laughed so hard she almost let go of the string.",
    ],
  },
  {
    key: "lighthouse-story",
    title: "The Lighthouse Keeper's Daughter",
    path: "/showcase/lighthouse-keepers-daughter",
    paragraphs: [
      "Nell was afraid of the stairs. One hundred and twelve iron steps spiraled up the inside of the lighthouse, and through the gaps she could see all the way down to the stone floor.",
      "Every night her father climbed them to light the lamp, and every night Nell stayed below, reading by the stove and pretending she did not care.",
      "The storm came in November. Her father had gone to the mainland for supplies, and the wind was too strong for his boat to return. As darkness fell, Nell saw the lights of a fishing boat beyond the rocks.",
      "Her hands shook on the railing. She counted each step out loud, the way her father did, and did not look down. At the top, she struck the match three times before it caught.",
      "The beam swept out across the water. In the morning, the fishermen came to thank the keeper. \"It wasn't me,\" her father said, looking at Nell. \"It was the bravest person on this island.\" Nell did not feel brave. She had been afraid the whole way up. Maybe, she thought, that was the point.",
    ],
  },
  {
    key: "hammurabi-laws",
    title: "Laws from the Reign of Hammurabi (excerpts, adapted)",
    path: "/showcase/hammurabi-laws",
    paragraphs: [
      "These laws were carved on a stone pillar (a stele) in Babylon around 1750 BCE, during the reign of King Hammurabi. The prologue says the king set them up \"so that the strong should not harm the weak.\"",
      "Law 53: If anyone is too lazy to keep his dam in good repair, and the dam breaks and floods the fields, he shall pay for the grain he has caused to be ruined.",
      "Law 196: If a man puts out the eye of another free man, his eye shall be put out.",
      "Law 198: If he puts out the eye of a commoner, or breaks the bone of a commoner, he shall pay one mina of silver.",
      "Law 229: If a builder builds a house for someone and does not build it properly, and the house falls and kills its owner, the builder shall be put to death.",
    ],
  },
  {
    key: "service-brief",
    title: "Community Service Requirements: A Brief for Families",
    path: "/showcase/community-service-brief",
    paragraphs: [
      "Northfield Public Schools is studying whether to require community service hours for graduation. This brief summarizes what the district's task force found. It is written for this demonstration and uses invented figures.",
      "In a survey of 600 Northfield juniors, 58% had volunteered at least once in the past year. Students who volunteered were more likely to say they felt connected to their community (71% compared with 44%).",
      "Students who worked paid jobs were least likely to have volunteered. Task force members disagreed about whether a requirement would help these students find opportunities or add to their burdens.",
      "Neighboring districts with a requirement allow students to count family caregiving and school clubs toward their hours.",
    ],
  },
  {
    key: "mill-letter",
    title: "Letter from a Lowell Mill Worker, 1845",
    path: "/showcase/lowell-mill-letter",
    paragraphs: [
      "This letter was written for this class, modeled closely on letters that young women in the Lowell mills sent home in the 1840s.",
      "Lowell, May 4th, 1845. Dear Sister, I take my pen to tell you I am well and have been in the weaving room these six weeks. I have two looms now and the overseer says I may have three by summer.",
      "The bell rules us from before light until after dark. We are at the looms at five and do not leave until seven in the evening, with half an hour for breakfast and dinner. My ears ring at night from the noise of the room.",
      "Still, I have money of my own for the first time, and I have sent two dollars with this letter for Father's debt. On Sundays we go to meeting, and some of the girls write for the Improvement Circle. I have borrowed three books.",
      "Do not tell Mother how tired I am. Tell her I am learning a great deal. Your affectionate sister, Hannah",
    ],
  },
];

/** A reading as a minimal HTML page, as a host serves it for a teacher to import. */
export function showcaseResourceHtml(resource: ShowcaseResource): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = resource.paragraphs.map((p) => `<p>${escape(p)}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(resource.title)}</title></head><body><h1>${escape(resource.title)}</h1>${body}</body></html>`;
}
