---
name: natural-style
description: Rewrite a given piece of text into natural, conversational technical prose. Precise but not corporate or robotic, no semicolons, no em-dashes, no AI-cliche phrasing. Use when the user supplies text and asks to apply the "natural" style, rewrite it naturally, or strip AI-sounding language, em-dashes, or semicolons from it. Do not use to change how Claude talks during the rest of the session, that's the "Natural" output style, a separate mechanism.
---

# Natural style

Rewrite the supplied text so it reads like an educated technical person in
their 20s explaining something to a technically capable peer: intelligent
and precise, not academic, corporate, performative, or overly polished.
Preserve the original meaning and technical content exactly. Do not add or
remove substantive claims, only change how they're expressed.

## Voice

- Favor connected paragraphs that develop an idea naturally, with sentences
  varying in length and structure. Don't manufacture short sentences purely
  for emphasis.
- Be direct. State what something is rather than routinely defining it
  against what it isn't. Cut formulaic contrast like "It's not X, it's Y",
  "not just X", "less X than Y" unless the contrast itself carries real
  information.
- Cut AI-cliche language and metaphors: "load-bearing", "footgun", "blast
  radius", "the shape of things", "sit with it", generic "pushback",
  "belt-and-suspenders", "north star", "sharp edges", "moving parts", "at
  the end of the day", and similar canned phrasing. Don't swap in a new
  decorative metaphor, just say the literal thing.
- Cut these patterns:
  - rhetorical questions immediately answered by the next sentence
  - "Not X. Y." staged emphasis
  - repeated fragments used for dramatic effect
  - artificial suspense before an ordinary conclusion
  - "Let's dive in", "Here's the thing", and similar preambles
  - unnecessary restatement of what's being discussed
  - generic praise ("great", "powerful", "elegant") without a concrete reason
  - announcing candor with "honestly" or "to be blunt"
  - a closing recap that just repeats what was already said
- Prefer concrete nouns, active verbs, and established technical
  terminology. Explain unfamiliar concepts directly rather than reaching
  for an analogy by default.
- Default to plain prose. Keep a header or bullet list only where it was
  already doing real work (labeling distinct sections, reference material
  someone will scan). Don't add structure just to add it, and don't strip
  structure that's genuinely useful for scanning.
- Allow ordinary informality ("basically", "in practice", "though",
  "probably") where it already reads naturally. Don't sand every sentence
  into stiff formal prose.

## Punctuation: no semicolons, no em-dashes

This applies to prose only. Leave code blocks, inline code, shell syntax
(`cmd1; cmd2`), source code, quoted strings, file paths, and URLs exactly
as given, verbatim, semicolons and em-dashes included.

In prose, replace an em-dash with a comma, a colon, parentheses, or by
splitting the sentence in two. Replace a semicolon with a period or a
comma. Never substitute a double hyphen, a spaced hyphen, or an en-dash as
a stand-in for the em-dash. If a sentence genuinely can't be written
without one, restructure it into two sentences. The en-dash in a numeric
range (e.g. 2020-2024) is unaffected.

## Output

Return only the rewritten text, with the same structure (paragraphs,
lists, headings) as the input unless the voice rules above call for
removing decorative structure. No preamble, no explanation of what
changed, no follow-up offer, unless the user asked for a diff or summary
of changes.
