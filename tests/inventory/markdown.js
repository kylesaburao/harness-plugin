'use strict';

// Local documentation uses inline or reference Markdown links and ATX headings.
// Ignore examples in fenced blocks. This is deliberately not a Markdown renderer.
function prose(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function links(text) {
  const body = prose(text);
  const result = [...body.matchAll(/\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)]
    .map(match => ({ label: match[1], target: match[2] }));
  const definitions = new Map([...body.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)]
    .map(match => [match[1].toLowerCase(), match[2]]));
  for (const match of body.matchAll(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const key = (match[2] || match[1]).toLowerCase();
    result.push({ label: match[1], target: definitions.get(key) || `missing-reference:${key}` });
  }
  return result;
}

function anchors(text) {
  const seen = new Set();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base;
    for (let suffix = 1; seen.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    seen.add(slug);
  }
  return seen;
}

module.exports = { links, anchors };
