# Project terminology schema

A repository can provide `STE_TERMS.jsonl` at its root. Each nonblank line must be one JSON object.

Required fields:

- `term`: Canonical technical noun or technical verb.
- `part_of_speech`: `technical_noun` or `technical_verb`.

Optional fields:

- `forms`: Array of permitted inflected or plural forms. The canonical term is always permitted.
- `meaning`: Short project-specific meaning.
- `source`: Project glossary, drawing, specification, or other authority.

Example:

```json
{"term":"cache buster","part_of_speech":"technical_noun","forms":["cache busters"],"meaning":"A value that invalidates a cached artifact","source":"Project glossary"}
{"term":"rehydrate","part_of_speech":"technical_verb","forms":["rehydrates","rehydrated"],"source":"Storage design"}
```

Do not use terminology overrides to approve general prose words. Keep exact identifiers in code or identifier spans instead of adding them as terms.
