# AI Research Dashboard MVP

## Goal
Transform the existing dashboard into an AI-paper intelligence feed for research use, with strong source reliability and low operational cost.

## Scope (MVP)
- Prioritize accepted papers from trusted conference tracks.
- Keep arXiv as a secondary preprint stream.
- Show short news-style summaries per paper.
- Attach coarse geo points based on first-author institution country.
- Reuse existing map/news infrastructure to avoid infra cost.

## Trusted-first source policy
Primary (accepted):
- NeurIPS (`NeurIPS.cc/<year>/Conference` via OpenReview)
- ICLR (`ICLR.cc/<year>/Conference` via OpenReview)
- ICML (`ICML.cc/<year>/Conference` via OpenReview)

Secondary (preprint):
- arXiv categories `cs.AI`, `cs.LG`, `cs.CL`, `cs.CV`

Ranking:
- Accepted conference papers get high trust scores.
- Preprints are included but ranked lower.
- Within same trust tier, newer publication date first.

## Cost controls
- Aggregated endpoint cache (`20 min`) to reduce repeated external calls.
- Per-paper summary cache (`7 days`) to avoid duplicate LLM charges.
- LLM summaries only for top-N papers (default `5`), rest use extractive fallback.
- No paid crawler dependency; API-only collection.

## Data model (MVP)
Paper fields:
- `id`, `title`, `abstract`, `summary`, `authors`
- `venue`, `sourceType` (`accepted` | `preprint`), `trustScore`
- `publishedAt`, `link`, `pdfLink`
- `institution`, `institutionCountry`, `lat`, `lon`

Activity points:
- Grouped by institution/country centroid
- `paperCount`, `weightedScore`, `intensity`

## Implementation notes
- New API: `GET /api/ai-papers`
- New service: `src/services/ai-papers.ts`
- New panel: `ai-papers` (flat list, no clustering)
- Existing map pulse layer consumes geo-tagged paper items through `allNews` clustering pipeline.

## Next steps after MVP
- Add more accepted venues (CVPR, ACL, EMNLP, AAAI) via reliable APIs.
- Improve affiliation geocoding from country-level to institution-level coordinates.
- Add budget dashboard (daily/monthly token usage + soft/hard limits).
