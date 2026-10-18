/** HTML entities that show up in attribute values scraped from shop pages */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

/** Decode the entities found in HTML attribute values, e.g. `&amp;` in a URL */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(amp|quot|#39|#x27|lt|gt);/g,
    (match) => ENTITIES[match] ?? match,
  );
}
